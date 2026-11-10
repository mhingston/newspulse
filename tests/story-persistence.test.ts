import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/db/store";
import { createApp } from "../src/http";
import { ProcessingWorker } from "../src/worker";
import { scoreItem } from "../src/scoring";

const day = 86400000;
const start = Date.UTC(2026, 10, 1);
function candidate(nativeId: string, title: string, days = 0, text = "") {
  return {
    nativeId,
    url: "https://articles.example/" + nativeId,
    title,
    publishedAt: start + days * day,
    text,
  };
}
function ingest(
  store: Store,
  source: string,
  items: ReturnType<typeof candidate>[],
  now = start + 1000,
) {
  const s = store.addSource(source);
  store.enqueueDue(now, true);
  // All calls in this file use a fresh or already-completed source poll.
  let job = store.claim(now);
  while (job && job.source_id !== s.id) {
    expect(store.complete(job, { items: [] }, now + 1)).toBe(true);
    job = store.claim(now);
  }
  expect(job?.source_id).toBe(s.id);
  expect(store.complete(job!, { items }, now + 1)).toBe(true);
}
function current(store: Store) {
  return store.sqlite
    .query<{ group_id: string; title: string }, []>(
      "SELECT m.group_id,i.title FROM story_memberships m JOIN items i ON i.id=m.item_id WHERE m.ended_at IS NULL ORDER BY i.title",
    )
    .all();
}

test("canonical URL aliases retain one item with both original source references", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, "https://feed-one.example/rss", [
      candidate("same", "Acme releases Atlas 2 robotics model"),
    ]);
    ingest(store, "https://feed-two.example/rss", [
      {
        ...candidate("native-other", "Acme releases Atlas 2 robotics model"),
        url: "https://articles.example/same?utm_source=second-feed",
      },
    ]);
    const items = store.search("Atlas");
    expect(items).toHaveLength(1);
    expect(store.getItem(items[0]!.id)!.references).toHaveLength(2);
    store.stories.reconcile();
    expect(current(store)).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("cross-source coverage forms a group without collapsing any source or analysis", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, "https://feed-one.example/rss", [
      candidate("a", "Acme releases Atlas 2 robotics model"),
    ]);
    ingest(store, "https://feed-two.example/rss", [
      candidate("b", "Atlas 2 robotics model launched by Acme"),
    ]);
    const before = store.search("robotics");
    expect(before).toHaveLength(2);
    const result = store.stories.reconcile(start + 2000);
    expect(result).toMatchObject({ changed: true, groups: 1, members: 2 });
    const group = store.getStoryGroup(current(store)[0]!.group_id)!;
    expect(group.members).toHaveLength(2);
    expect(group.members.map((m) => m.item!.references.length)).toEqual([1, 1]);
    for (const member of group.members) {
      expect(store.getItem(member.item_id)!.references).toHaveLength(1);
      expect(store.getItem(member.item_id)!.story.current).not.toBeNull();
    }
    expect(store.stories.reconcile(start + 3000).changed).toBe(false);
    expect(
      store.sqlite.query("SELECT count(*) AS n FROM story_memberships").get(),
    ).toEqual({ n: 2 });
  } finally {
    store.close();
  }
});

test("unrelated grouping changes do not invalidate an unchanged membership", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, "https://feed-one.example/rss", [
      candidate("a", "Acme releases Atlas robotics model"),
    ]);
    store.stories.reconcile(start + 2000);
    const id = store.search("Atlas")[0]!.id;
    const extraction = store.claimProcessing("extract", start + 2001)!;
    store.completeProcessing(extraction, "extracted", start + 2002);
    store.sqlite
      .query(
        "UPDATE processing_jobs SET status='done',outcome='scored' WHERE stage='score' AND item_id=?",
      )
      .run(id);
    ingest(
      store,
      "https://feed-two.example/rss",
      [candidate("b", "Mars probe measures distant solar wind")],
      start + 3000,
    );
    store.stories.reconcile(start + 4000);
    expect(
      store.sqlite
        .query<{ status: string }, [string]>(
          "SELECT status FROM processing_jobs WHERE item_id=? AND stage='score'",
        )
        .get(id)?.status,
    ).toBe("done");
  } finally {
    store.close();
  }
});

test("a relation-only evidence change requeues scores in both related groups", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, "https://feed-one.example/rss", [
      candidate("rel-old", "Acme Atlas 2 robotics model launches", 0),
    ]);
    ingest(store, "https://feed-two.example/rss", [
      candidate("rel-new", "Acme Atlas 2 robotics model recalled", 9),
    ]);
    store.stories.reconcile(start + 20 * day);
    const groups = store.sqlite
      .query<{ id: string }, []>(
        "SELECT id FROM story_groups WHERE retired_at IS NULL ORDER BY id",
      )
      .all();
    expect(groups).toHaveLength(2);
    expect(
      store.sqlite
        .query("SELECT 1 FROM story_relations WHERE ended_at IS NULL")
        .get(),
    ).not.toBeNull();
    const robotItems = store.search("robotics");
    for (const [index, item] of robotItems.entries()) {
      store.sqlite
        .query(
          "UPDATE processing_jobs SET status='done',outcome='extracted' WHERE item_id=? AND stage='extract'",
        )
        .run(item.id);
      store.sqlite
        .query(
          "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,available_at,created_at) VALUES(?,?,'score',1,?,'scored',0,0)",
        )
        .run(`score-${item.id}`, item.id, index === 0 ? "pending" : "done");
    }
    const staleClaim = store.claimProcessing("score", start + 20 * day)!;
    const staleSnapshot = store.scoringSnapshot(staleClaim, start + 20 * day)!;
    store.sqlite
      .query("UPDATE story_relations SET evidence='{}' WHERE ended_at IS NULL")
      .run();
    store.sqlite
      .query("UPDATE story_grouping_state SET fingerprint='dirty' WHERE id=1")
      .run();
    store.stories.reconcile(start + 21 * day);
    const states = store.sqlite
      .query<{ status: string }, []>(
        "SELECT status FROM processing_jobs WHERE stage='score' ORDER BY item_id",
      )
      .all();
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states.every((row) => row.status === "pending")).toBe(true);
    expect(
      store.completeScore(
        staleClaim,
        {
          inputHash: staleSnapshot.inputHash,
          criteriaVersion: "deterministic-v2",
          provenance: staleSnapshot.provenance,
          result: scoreItem(staleSnapshot.input),
          capturedAt: start + 20 * day,
        },
        start + 21 * day,
      ),
    ).toBe(false);
  } finally {
    store.close();
  }
});

test("regrouping fences affected peers but leaves unrelated score claims intact", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, "https://feed-one.example/rss", [
      candidate("a", "Acme releases Atlas 2 robotics model"),
      candidate("b", "Atlas 2 robotics model launched by Acme"),
      candidate("c", "Mars probe measures distant solar wind"),
    ]);
    for (let i = 0; i < 3; i++) {
      const extraction = store.claimProcessing("extract", start + 1002)!;
      expect(
        store.completeProcessing(extraction, "unavailable", start + 1003),
      ).toBe(true);
    }
    store.stories.reconcile(start + 2000);
    const ids = store.search("robotics");
    const peer = ids.find((item) => item.url?.endsWith("/a"))!.id;
    const unrelated = store.search("Mars")[0]!.id;
    const lease = store.sqlite.query(
      "UPDATE processing_jobs SET status='running',lease_token=?,lease_until=? WHERE item_id=? AND stage='score'",
    );
    lease.run("peer-token", start + 100_000, peer);
    lease.run("unrelated-token", start + 100_000, unrelated);
    ingest(
      store,
      "https://feed-one.example/rss",
      [candidate("b", "Acme launches Orion 3 robotics model")],
      start + 5000,
    );
    expect(
      store.sqlite
        .query<{ status: string }, [string]>(
          "SELECT status FROM processing_jobs WHERE item_id=? AND stage='score'",
        )
        .get(peer)?.status,
    ).toBe("running");
    store.stories.reconcile(start + 6000);
    const state = store.sqlite.query<
      { status: string; lease_token: string | null },
      [string]
    >(
      "SELECT status,lease_token FROM processing_jobs WHERE item_id=? AND stage='score'",
    );
    expect(state.get(peer)).toEqual({ status: "pending", lease_token: null });
    expect(state.get(unrelated)).toEqual({
      status: "running",
      lease_token: "unrelated-token",
    });
  } finally {
    store.close();
  }
});

test("corrections split a development without losing citations or audited memberships", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, "https://feed-one.example/rss", [
      candidate("a", "Acme releases Atlas 2 robotics model"),
    ]);
    ingest(store, "https://feed-two.example/rss", [
      candidate("b", "Atlas 2 robotics model launched by Acme"),
    ]);
    store.stories.reconcile(start + 2000);
    const priorGroup = current(store)[0]!.group_id;
    const id = store.search("robotics").find((i) => i.url?.endsWith("/b"))!.id;
    ingest(
      store,
      "https://feed-two.example/rss",
      [candidate("b", "Acme launches Orion 3 robotics model")],
      start + 5000,
    );
    store.stories.reconcile(start + 6000);
    expect(new Set(current(store).map((m) => m.group_id)).size).toBe(2);
    const item = store.getItem(id)!;
    expect(item.references).toHaveLength(1);
    expect(item.content_versions).toHaveLength(2);
    expect(item.story.history.map((h) => h.group_id)).toContain(priorGroup);
    expect(item.story.history).toHaveLength(2);
    expect(store.search("Orion")).toHaveLength(1);
    expect(store.getStoryGroup(priorGroup)!.members.length).toBeGreaterThan(0);
  } finally {
    store.close();
  }
});

test("arrival order, repeated grouping and historical follow-ups stay stable", () => {
  const stories = [
    candidate("one", "Acme releases Atlas 2 robotics model"),
    candidate("two", "Atlas 2 robotics model launched by Acme"),
    candidate("later", "Acme recalls Atlas 2 robotics model", 7),
    candidate("other", "Acme releases Orion 3 robotics model"),
  ];
  const results: unknown[] = [];
  for (const order of [stories, [...stories].reverse()]) {
    const store = new Store(":memory:");
    try {
      ingest(store, "https://feed-one.example/rss", order);
      store.stories.reconcile();
      const groups = store.sqlite
        .query<{ id: string }, []>(
          "SELECT id FROM story_groups WHERE retired_at IS NULL ORDER BY id",
        )
        .all();
      const relations = store.sqlite
        .query<{ older_group_id: string; newer_group_id: string }, []>(
          "SELECT older_group_id,newer_group_id FROM story_relations WHERE ended_at IS NULL ORDER BY older_group_id,newer_group_id",
        )
        .all();
      results.push({ groups, relations });
      expect(groups).toHaveLength(3);
      expect(relations).toHaveLength(1);
      const count = store.sqlite
        .query("SELECT count(*) AS n FROM story_memberships")
        .get();
      store.stories.reconcile();
      expect(
        store.sqlite.query("SELECT count(*) AS n FROM story_memberships").get(),
      ).toEqual(count);
    } finally {
      store.close();
    }
  }
  expect(results[0]).toEqual(results[1]);
});

test("grouping stage retries with fences and does not re-run derived analysis", async () => {
  const store = new Store(":memory:");
  try {
    ingest(store, "https://feed-one.example/rss", [
      candidate("a", "Acme releases Atlas 2 robotics model"),
    ]);
    const old = store.claimProcessing("group", start + 1002)!;
    expect(old).not.toBeNull();
    expect(store.completeProcessing(old, "grouped", start + 61003)).toBe(false);
    const newJob = store.claimProcessing("group", start + 61003)!;
    expect(newJob).not.toBeNull();
    const worker = new ProcessingWorker(store, {
      group: async () => ({
        status: "grouped",
        result: JSON.stringify(store.stories.reconcile()),
      }),
    });
    // The reclaimed job is already leased: finish it, then verify no new work.
    expect(store.completeProcessing(newJob, "grouped", start + 61004)).toBe(
      true,
    );
    expect(store.stories.reconcile().changed).toBe(true);
    expect(await worker.drain("group", 1)).toBe(0);
    expect(
      store.sqlite.query("SELECT count(*) AS n FROM analyses").get(),
    ).toEqual({ n: 0 });
  } finally {
    store.close();
  }
});

test("populated pre-story schema upgrades without touching analysis, FTS, or backup/restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-stories-"));
  const path = join(dir, "old.sqlite");
  const oldMigrations = join(dir, "old-migrations");
  const backup = join(dir, "restored.sqlite");
  mkdirSync(join(oldMigrations, "meta"), { recursive: true });
  const currentMigrations = fileURLToPath(
    new URL("../drizzle/", import.meta.url),
  );
  for (const file of readdirSync(currentMigrations))
    if (file.endsWith(".sql") && !file.startsWith("0023_"))
      copyFileSync(join(currentMigrations, file), join(oldMigrations, file));
  const journal = JSON.parse(
    readFileSync(join(currentMigrations, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx < 23);
  writeFileSync(
    join(oldMigrations, "meta", "_journal.json"),
    JSON.stringify(journal),
  );
  const db = new Database(path);
  migrate(drizzle(db), { migrationsFolder: oldMigrations });
  db.exec(
    "INSERT INTO sources(id,url,title) VALUES('src','https://source.example/rss','Source');" +
      "INSERT INTO items(id,identity,url,title,ingested_at) VALUES('item','url:https://articles.example/old','https://articles.example/old','Old title',100);" +
      "INSERT INTO content(item_id,text) VALUES('item','persistent searchable original');" +
      "INSERT INTO item_sources(item_id,source_id,native_id,url) VALUES('item','src','native','https://articles.example/old#original');" +
      "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,available_at,created_at) VALUES('extract','item','extract',1,'done','extracted',0,0);" +
      "INSERT INTO analyses(id,item_id,generation,input_hash,provider,model,prompt_version,profiles,result,created_at) VALUES('analysis','item',1,'hash','fake','test','1','[]','{\"summary\":\"preserved model insight\"}',200);",
  );
  db.close();
  let store: Store | undefined;
  let restored: Store | undefined;
  try {
    store = new Store(path);
    expect(store.search("persistent")).toHaveLength(1);
    expect(store.search("insight")).toHaveLength(1);
    expect(store.getItem("item")!.analysis?.result.summary).toBe(
      "preserved model insight",
    );
    expect((store.getItem("item")!.references[0]! as { url: string }).url).toBe(
      "https://articles.example/old#original",
    );
    expect(store.claimProcessing("group", Date.now())?.item_id).toBe("item");
    expect(store.claimProcessing("score", Date.now())?.item_id).toBe("item");
    store.stories.reconcile();
    store.backup(backup);
    restored = new Store(backup);
    expect(restored.getItem("item")!.story.current?.group_id).toBeDefined();
    expect(restored.search("insight")).toHaveLength(1);
    expect(restored.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
  } finally {
    store?.close();
    restored?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending grouping job sees corrections after a clean snapshot was cached", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, "https://feed-one.example/rss", [
      candidate("a", "Acme releases Atlas 2 robotics model"),
      candidate("b", "Atlas 2 robotics model launched by Acme"),
    ]);
    expect(store.stories.reconcile().groups).toBe(1);
    expect(store.stories.reconcile().changed).toBe(false);
    const initialGroup = current(store)[0]!.group_id;
    ingest(
      store,
      "https://feed-one.example/rss",
      [candidate("b", "Acme releases Orion 3 robotics model")],
      start + 6000,
    );
    // The original grouping job can still be pending; it must nevertheless
    // invalidate the cached snapshot and split corrected coverage.
    expect(store.stories.reconcile().changed).toBe(true);
    expect(new Set(current(store).map((row) => row.group_id)).size).toBe(2);
    const history = store.sqlite
      .query<{ group_id: string; ended_at: number | null }, [string]>(
        "SELECT group_id,ended_at FROM story_memberships WHERE group_id=? ORDER BY id",
      )
      .all(initialGroup);
    expect(history.some((row) => row.ended_at !== null)).toBe(true);
    expect(store.stories.reconcile().changed).toBe(false);
  } finally {
    store.close();
  }
});

test("grouping ignores an obsolete extraction after a correction and unavailable retry", () => {
  const store = new Store(":memory:");
  try {
    const syndicated =
      "The complete release announcement records reproducible benchmark methodology, hardware latency measurements, licensing details and evaluation results for independent research. ".repeat(
        2,
      );
    ingest(store, "https://feed-one.example/rss", [
      candidate("a", "Acme releases Atlas 2 robotics model", 0, syndicated),
      candidate("b", "Atlas 2 robotics model launched by Acme", 0, syndicated),
    ]);
    for (let i = 0; i < 2; i++) {
      const job = store.claimProcessing("extract", start + 1002)!;
      expect(job).not.toBeNull();
      expect(
        store.completeProcessing(
          job,
          "extracted",
          start + 1003,
          JSON.stringify({ text: syndicated }),
        ),
      ).toBe(true);
    }
    expect(store.stories.reconcile().groups).toBe(1);
    const originalGroup = current(store)[0]!.group_id;

    ingest(
      store,
      "https://feed-one.example/rss",
      [
        candidate(
          "b",
          "Acme releases Orion 2 robotics model",
          0,
          "Updated feed body about Orion.",
        ),
      ],
      start + 5000,
    );
    // The previous successful extraction remains stored but is no longer
    // current while the correction's extraction generation is pending.
    expect(store.stories.reconcile().groups).toBe(2);
    expect(new Set(current(store).map((member) => member.group_id)).size).toBe(
      2,
    );
    const job = store.claimProcessing("extract", start + 5002)!;
    expect(job.generation).toBe(2);
    expect(store.completeProcessing(job, "unavailable", start + 5003)).toBe(
      true,
    );
    expect(store.stories.reconcile().groups).toBe(2);
    expect(
      current(store).some((member) => member.group_id === originalGroup),
    ).toBe(true);
  } finally {
    store.close();
  }
});

test("MCP retrieves both grouped and individual original references", async () => {
  const store = new Store(":memory:");
  ingest(store, "https://feed-one.example/rss", [
    candidate("a", "Acme releases Atlas 2 robotics model"),
    candidate("b", "Atlas 2 robotics model launched by Acme"),
  ]);
  store.stories.reconcile();
  const groupId = current(store)[0]!.group_id;
  const token = "token-with-at-least-24-characters";
  const app = createApp(store, {
    token,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  const client = new Client({ name: "stories-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("mcp", server.url), {
        requestInit: { headers: { authorization: "Bearer " + token } },
      }),
    );
    const response = await client.callTool({
      name: "get_story_group",
      arguments: { id: groupId },
    });
    const group = JSON.parse(
      (response.content as { text: string }[])[0]!.text,
    ) as { members: { item: { references: unknown[] }; item_id: string }[] };
    expect(group.members).toHaveLength(2);
    expect(
      group.members.every((member) => member.item.references.length === 1),
    ).toBe(true);
    for (const member of group.members) {
      const detail = await client.callTool({
        name: "get_item",
        arguments: { id: member.item_id },
      });
      expect(detail.isError).not.toBe(true);
    }
  } finally {
    await client.close();
    await server.stop(true);
    store.close();
  }
});
