import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db/store";
import { DAY_MS, retentionPolicy } from "../src/retention";
import { verifyDatabase } from "../src/recovery";
import { parseFeed } from "../src/adapters/rss";
import { DigestStore } from "../src/db/digest-store";

const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-retention-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const DAY0 = Date.UTC(2026, 10, 1);

const feed = (title: string, text: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
<item><title>${title}</title><link>https://example.test/${title.replace(/\W+/g, "-")}</link><guid>${title}</guid><description>${text}</description></item>
</channel></rss>`;

/** Ingests one feed item, completes extraction with payload text and an analysis summary, and scores it. */
function populatedItem(
  store: Store,
  title: string,
  summaryWord: string,
  now: number,
) {
  const source = store.addSource(`https://example.test/${title}.xml`, title);
  store.enqueueDue(now);
  const poll = store.claim(now)!;
  store.complete(
    poll,
    { items: parseFeed(feed(title, "baseline body"), source.url) },
    now,
  );
  const item = store.search(title)[0]!;
  store.enqueueProcessing("extract", item.id, now);
  const extract = store.claimProcessing("extract", now)!;
  store.completeProcessing(
    extract,
    "extracted",
    now,
    JSON.stringify({
      status: "extracted",
      text: `payload ${summaryWord} body`,
    }),
  );
  store.enqueueProcessing("analyse", item.id, now, extract.generation);
  const analyse = store.claimProcessing("analyse", now)!;
  store.completeAnalysis(
    analyse,
    {
      inputHash: `hash-${title}`,
      provider: "fake",
      model: "fake",
      promptVersion: "v1",
      profiles: [],
      analysis: { summary: `summary ${summaryWord}` },
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: 0,
    },
    now,
  );
  const score = store.claimProcessing("score", now)!;
  store.completeProcessing(score, "scored", now);
  return item.id;
}

describe("retention policy", () => {
  test("defaults retain everything and invalid windows fail closed", () => {
    expect(retentionPolicy({})).toEqual({
      extractedPayloadDays: undefined,
      analysisSummaryDays: undefined,
    });
    expect(() =>
      retentionPolicy({ RETENTION_EXTRACTED_PAYLOAD_DAYS: "0" }),
    ).toThrow();
    expect(() =>
      retentionPolicy({ RETENTION_ANALYSIS_SUMMARY_DAYS: "abc" }),
    ).toThrow();
    expect(() =>
      retentionPolicy({ RETENTION_ANALYSIS_SUMMARY_DAYS: "99999" }),
    ).toThrow();
    expect(
      retentionPolicy({
        RETENTION_EXTRACTED_PAYLOAD_DAYS: "30",
        RETENTION_ANALYSIS_SUMMARY_DAYS: "90",
      }),
    ).toEqual({ extractedPayloadDays: 30, analysisSummaryDays: 90 });
  });
});

describe("content retention", () => {
  test("default policy purges nothing even when everything is old", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      populatedItem(store, "Alpha", "alphaword", DAY0);
      const report = store.retention(retentionPolicy({}), {
        dryRun: false,
        now: DAY0 + 3650 * DAY_MS,
      });
      expect(report.eligible).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
      });
      expect(store.search("alphaword")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("clock-advanced expiry removes derived content while identity, history and FTS remain consistent", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      const before = {
        items: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM items")
          .get()!.n,
        versions: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM content_versions")
          .get()!.n,
        sources: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM item_sources")
          .get()!.n,
      };
      const policy = retentionPolicy({
        RETENTION_EXTRACTED_PAYLOAD_DAYS: "7",
        RETENTION_ANALYSIS_SUMMARY_DAYS: "7",
      });

      const early = store.retention(policy, {
        dryRun: true,
        now: DAY0 + 6 * DAY_MS,
      });
      expect(early.eligible).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
      });

      const dry = store.retention(policy, {
        dryRun: true,
        now: DAY0 + 8 * DAY_MS,
      });
      expect(dry.eligible).toEqual({
        extracted_payload: 1,
        analysis_summary: 1,
      });
      expect(dry.purged).toEqual({ extracted_payload: 0, analysis_summary: 0 });
      expect(store.search("alphaword")).toHaveLength(1);

      const applied = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 8 * DAY_MS,
      });
      expect(applied.purged).toEqual({
        extracted_payload: 1,
        analysis_summary: 1,
      });

      const item = store.getItem(itemId)!;
      expect(item.extraction).toEqual({
        status: "purged",
        reason: "retention",
      });
      expect(item.summary).toBeNull();
      expect(item.analysis?.result).toEqual({ purged: true, summary: null });
      expect(item.retention.map((row) => row.class).sort()).toEqual([
        "analysis_summary",
        "extracted_payload",
      ]);
      expect(item.references.length).toBeGreaterThan(0);
      expect(item.content_versions.length).toBeGreaterThan(0);

      // Purged summary and payload text must not stay searchable.
      expect(store.search("alphaword")).toHaveLength(0);
      expect(store.search("baseline")).toHaveLength(1);

      const after = {
        items: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM items")
          .get()!.n,
        versions: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM content_versions")
          .get()!.n,
        sources: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM item_sources")
          .get()!.n,
      };
      expect(after).toEqual(before);
    } finally {
      store.close();
    }
  });

  test("repeat cleanup is idempotent and does not change counts or FTS", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      populatedItem(store, "Alpha", "alphaword", DAY0);
      populatedItem(store, "Beta", "betaword", DAY0);
      const policy = retentionPolicy({
        RETENTION_EXTRACTED_PAYLOAD_DAYS: "1",
        RETENTION_ANALYSIS_SUMMARY_DAYS: "1",
      });
      const now = DAY0 + 5 * DAY_MS;
      const first = store.retention(policy, { dryRun: false, now });
      expect(first.purged).toEqual({
        extracted_payload: 2,
        analysis_summary: 2,
      });
      const second = store.retention(policy, {
        dryRun: false,
        now: now + DAY_MS,
      });
      expect(second.eligible).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
      });
      expect(second.purged).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
      });
      const audit = store.sqlite
        .query<{ n: number }, []>("SELECT count(*) n FROM retention_purges")
        .get()!.n;
      expect(audit).toBe(4);
      expect(verifyDatabase(join(dir, "db.sqlite")).ftsConsistent).toBe(true);
    } finally {
      store.close();
    }
  });

  test("unsettled items, pending stages and in-flight analysis reservations are never purged", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      // A newer extraction generation is pending, so the old one must not be purged.
      store.sqlite
        .query(
          "INSERT INTO processing_jobs(id,stage,item_id,generation,status,attempts,available_at,queued_at,created_at) VALUES('pending-ext',?,?,2,'pending',0,?,?,?)",
        )
        .run("extract", itemId, DAY0, DAY0, DAY0);
      const policy = retentionPolicy({
        RETENTION_EXTRACTED_PAYLOAD_DAYS: "1",
        RETENTION_ANALYSIS_SUMMARY_DAYS: "1",
      });
      const report = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 10 * DAY_MS,
      });
      expect(report.purged).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
      });
      expect(report.deferred).toBeGreaterThanOrEqual(1);
      expect(
        store.sqlite
          .query<{ result: string }, [string]>(
            "SELECT result FROM processing_jobs WHERE item_id=? AND stage='extract' AND generation=1",
          )
          .get(itemId)!.result,
      ).toContain("payload alphaword body");

      // Remove the pending work; now an in-flight analysis reservation blocks summary purges.
      store.sqlite
        .query("DELETE FROM processing_jobs WHERE id='pending-ext'")
        .run();
      store.sqlite
        .query(
          "INSERT INTO analysis_reservations(key,tokens,micros,status) VALUES('ambiguous',1,1,'reserved')",
        )
        .run();
      const blocked = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 10 * DAY_MS,
      });
      expect(blocked.analysisReservationsActive).toBe(true);
      expect(blocked.purged.analysis_summary).toBe(0);
      expect(blocked.purged.extracted_payload).toBe(1);

      store.sqlite
        .query("DELETE FROM analysis_reservations WHERE key='ambiguous'")
        .run();
      const resumed = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 10 * DAY_MS,
      });
      expect(resumed.purged.analysis_summary).toBe(1);
    } finally {
      store.close();
    }
  });

  test("frozen digests, deliveries and feedback survive retention untouched", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      new DigestStore(store.sqlite).freeze(
        {
          date: "2026-11-01",
          timezone: "Europe/London",
          subject: "Discovery",
          html: "<p>alphaword</p>",
          text: "alphaword",
          decisionSnapshot: {},
          items: [
            {
              itemId,
              groupId: null,
              scoreId: null,
              snapshot: {
                title: "Alpha",
                citations: [{ url: "https://example.test/a" }],
              },
            },
          ],
        },
        DAY0,
      );
      store.sqlite
        .query(
          "INSERT INTO item_feedback(id,item_id,useful,source,created_at) VALUES('f1',?,1,'mcp',?)",
        )
        .run(itemId, DAY0);
      store.retention(
        retentionPolicy({
          RETENTION_EXTRACTED_PAYLOAD_DAYS: "1",
          RETENTION_ANALYSIS_SUMMARY_DAYS: "1",
        }),
        { dryRun: false, now: DAY0 + 10 * DAY_MS },
      );
      expect(
        store.sqlite
          .query<{ html: string }, []>("SELECT html FROM digests")
          .get()!.html,
      ).toBe("<p>alphaword</p>");
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM item_feedback")
          .get()!.n,
      ).toBe(1);
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM digest_items")
          .get()!.n,
      ).toBe(1);
      expect(
        store.retention(
          retentionPolicy({ RETENTION_EXTRACTED_PAYLOAD_DAYS: "1" }),
          { dryRun: true, now: DAY0 + 10 * DAY_MS },
        ).eligible.extracted_payload,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("populated prior-version database migrates and retains canonical identity, references and search", () => {
    const dir = temp();
    const old = join(dir, "prior-migrations");
    const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
    mkdirSync(old, { recursive: true });
    for (const file of readdirSync(migrations)) {
      if (file.endsWith(".sql") && file !== "0047_retention_purges.sql")
        copyFileSync(join(migrations, file), join(old, file));
    }
    const journal = JSON.parse(
      readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
    );
    journal.entries = journal.entries.filter(
      (entry: { tag: string }) => entry.tag !== "0047_retention_purges",
    );
    mkdirSync(join(old, "meta"), { recursive: true });
    writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
    for (const file of readdirSync(join(migrations, "meta"))) {
      if (file.endsWith("_snapshot.json") && !file.startsWith("0047"))
        copyFileSync(join(migrations, "meta", file), join(old, "meta", file));
    }
    const path = join(dir, "prior.sqlite");
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA foreign_keys=ON");
    migrate(drizzle(db), { migrationsFolder: old });
    db.query(
      "INSERT INTO sources(id,kind,url,title,enabled) VALUES('s1','rss','https://example.test/prior.xml','Prior',1)",
    ).run();
    db.query(
      "INSERT INTO items(id,identity,url,title,ingested_at,status) VALUES('canon-1','url:https://example.test/a','https://example.test/a','Legacy survived',1,'extracted')",
    ).run();
    db.query(
      "INSERT INTO item_sources(item_id,source_id,native_id,url) VALUES('canon-1','s1','native-a','https://example.test/a')",
    ).run();
    db.query(
      "INSERT INTO content(item_id,text) VALUES('canon-1','legacy payload')",
    ).run();
    db.query(
      "INSERT INTO processing_jobs(id,stage,item_id,generation,status,outcome,attempts,available_at,queued_at,created_at,result) VALUES('px','extract','canon-1',1,'done','extracted',0,1,1,1,?)",
    ).run(JSON.stringify({ status: "extracted", text: "legacy payload" }));
    db.close();

    const store = new Store(path);
    try {
      expect(store.getItem("canon-1")?.title).toBe("Legacy survived");
      expect(store.search("legacy")).toHaveLength(1);
      const report = store.retention(
        retentionPolicy({ RETENTION_EXTRACTED_PAYLOAD_DAYS: "1" }),
        { dryRun: false, now: 10 * DAY_MS },
      );
      expect(report.purged.extracted_payload).toBe(0);
      expect(store.getItem("canon-1")?.references).toHaveLength(1);
    } finally {
      store.close();
    }
    const verified = verifyDatabase(path);
    expect(verified.ok).toBe(true);
    expect(verified.migrations).toBe(
      JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"))
        .entries.length,
    );
  });
});

describe("recovery verification", () => {
  test("backup verifies, restore accepts it, and a corrupt backup is rejected", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      populatedItem(store, "Alpha", "alphaword", DAY0);
      const backup = join(dir, "backup.sqlite");
      store.backup(backup);
      const report = verifyDatabase(backup);
      expect(report.ok).toBe(true);
      expect(report.counts.items).toBe(1);
      expect(report.ftsConsistent).toBe(true);
    } finally {
      store.close();
    }
    const corrupt = join(dir, "corrupt.sqlite");
    writeFileSync(corrupt, "not a database");
    expect(verifyDatabase(corrupt).ok).toBe(false);
  });

  test("verification flags a missing search index row and foreign key violations", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    populatedItem(store, "Alpha", "alphaword", DAY0);
    store.close();
    const path = join(dir, "db.sqlite");
    const db = new Database(path, { strict: true });
    db.exec("PRAGMA foreign_keys=OFF");
    db.query("DELETE FROM items_fts").run();
    db.query(
      "INSERT INTO item_sources(item_id,source_id,native_id) VALUES('ghost','s-missing','x')",
    ).run();
    db.close();
    const report = verifyDatabase(path);
    expect(report.ok).toBe(false);
    expect(report.ftsConsistent).toBe(false);
    expect(report.foreignKeyViolations).toBeGreaterThan(0);
  });
});

describe("recovery CLI", () => {
  const cli = (args: string[], env: Record<string, string | undefined>) =>
    Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
      env: {
        ...process.env,
        MCP_TOKEN: "abcdefghijklmnopqrstuvwxyz123456",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

  test("restore rejects a corrupt backup without creating a live database", () => {
    const dir = temp();
    const corrupt = join(dir, "corrupt.sqlite");
    writeFileSync(corrupt, "definitely not sqlite");
    const target = join(dir, "restored.sqlite");
    const result = cli(["restore", corrupt], { DB_PATH: target });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  test("backup verifies its output and restore verifies the restored copy", () => {
    const dir = temp();
    const live = join(dir, "live.sqlite");
    const store = new Store(live);
    populatedItem(store, "Alpha", "alphaword", DAY0);
    store.close();
    const backup = join(dir, "backup.sqlite");
    const created = cli(["backup", backup], { DB_PATH: live });
    expect(created.exitCode).toBe(0);
    expect(created.stdout.toString()).toContain("verified");
    expect(verifyDatabase(backup).ok).toBe(true);

    const target = join(dir, "restored.sqlite");
    const restored = cli(["restore", backup], { DB_PATH: target });
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout.toString()).toContain("verified");
    const check = new Store(target);
    try {
      expect(check.search("alphaword")).toHaveLength(1);
    } finally {
      check.close();
    }
  });

  test("retention CLI previews without changing content by default", () => {
    const dir = temp();
    const live = join(dir, "live.sqlite");
    const store = new Store(live);
    populatedItem(store, "Alpha", "alphaword", DAY0);
    store.close();
    const preview = cli(["retention-preview"], {
      DB_PATH: live,
      RETENTION_EXTRACTED_PAYLOAD_DAYS: "1",
    });
    expect(preview.exitCode).toBe(0);
    const report = JSON.parse(preview.stdout.toString());
    expect(report.dryRun).toBe(true);
    const after = new Store(live);
    try {
      expect(after.search("alphaword")).toHaveLength(1);
    } finally {
      after.close();
    }
  });
});

test("restored upgraded database keeps identity: re-polling and reprocessing do not duplicate items", () => {
  const dir = temp();
  const live = join(dir, "live.sqlite");
  const feedXml = feed("Gamma", "gamma body");
  const store = new Store(live);
  const source = store.addSource("https://example.test/gamma.xml", "gamma");
  store.enqueueDue(DAY0);
  store.complete(
    store.claim(DAY0)!,
    { items: parseFeed(feedXml, source.url) },
    DAY0,
  );
  const itemId = store.search("Gamma")[0]!.id;
  store.close();

  const backup = join(dir, "backup.sqlite");
  const created = Bun.spawnSync(
    [process.execPath, "src/cli.ts", "backup", backup],
    {
      env: {
        ...process.env,
        DB_PATH: live,
        MCP_TOKEN: "abcdefghijklmnopqrstuvwxyz123456",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(created.exitCode).toBe(0);

  const restoredPath = join(dir, "restored.sqlite");
  const restored = Bun.spawnSync(
    [process.execPath, "src/cli.ts", "restore", backup],
    {
      env: {
        ...process.env,
        DB_PATH: restoredPath,
        MCP_TOKEN: "abcdefghijklmnopqrstuvwxyz123456",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(restored.exitCode).toBe(0);

  const reopened = new Store(restoredPath);
  try {
    expect(
      reopened.sqlite
        .query<{ n: number }, []>("PRAGMA foreign_key_check")
        .all(),
    ).toHaveLength(0);
    reopened.enqueueDue(DAY0 + 60_000, true);
    const poll = reopened.claim(DAY0 + 60_000)!;
    reopened.complete(
      poll,
      { items: parseFeed(feedXml, source.url) },
      DAY0 + 60_000,
    );
    expect(reopened.getItem(itemId)?.id).toBe(itemId);
    expect(
      reopened.sqlite
        .query<{ n: number }, []>("SELECT count(*) n FROM items")
        .get()!.n,
    ).toBe(1);
    expect(reopened.search("gamma")).toHaveLength(1);
  } finally {
    reopened.close();
  }
});
