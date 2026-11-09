import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { draftDigest, digestDefaults } from "../src/digest-service";
import { SCORING_CRITERIA_VERSION } from "../src/scoring";
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

const now = Date.UTC(2026, 10, 9, 12),
  day = 86400000;
function add(
  store: Store,
  id: string,
  ingested: number,
  scoreAt: number | null,
  failed = false,
  generation = 1,
) {
  store.sqlite
    .query("INSERT INTO items(id,identity,title,ingested_at) VALUES(?,?,?,?)")
    .run(id, id, "Robotics", ingested);
  store.sqlite
    .query(
      "INSERT INTO item_sources(item_id,source_id,native_id,url) VALUES(?,'source',?,NULL)",
    )
    .run(id, id);
  store.sqlite
    .query(
      "INSERT INTO processing_jobs(id,item_id,stage,generation,status,available_at,created_at) VALUES(?,?,'extract',?,?,0,0)",
    )
    .run(`extract-${id}`, id, generation, failed ? "failed" : "done");
  if (scoreAt !== null) {
    store.sqlite
      .query(
        "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,available_at,created_at) VALUES(?,?,'score',?,'done','scored',0,0)",
      )
      .run(`score-${id}`, id, generation);
    store.sqlite
      .query(
        "INSERT INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at) VALUES(?,?,?,'hash',?,'{}',?,?)",
      )
      .run(
        `s-${id}`,
        id,
        generation,
        SCORING_CRITERIA_VERSION,
        JSON.stringify({ total: 90, eligible: true, reasons: [] }),
        scoreAt,
      );
    store.sqlite
      .query(
        "INSERT INTO score_refresh(job_id,criteria_version,due_at) VALUES(?,?,NULL)",
      )
      .run(`score-${id}`, SCORING_CRITERIA_VERSION);
  }
}
function setup(path = ":memory:") {
  const store = new Store(path);
  store.addSource("https://example.test/feed");
  store.sqlite.query("UPDATE sources SET id='source'").run();
  store.sqlite
    .query(
      "INSERT INTO story_grouping_state(id,fingerprint,updated_at) VALUES(1,'clean',?)",
    )
    .run(now);
  return store;
}

test("draft uses fenced acceptance and unresolved history from scored evidence", () => {
  const s = setup();
  try {
    add(s, "one", now - 1000, now - 900);
    const options = { ...digestDefaults("2026-11-09", now), minScore: 0 };
    const setHistory = (history: unknown) =>
      s.sqlite
        .query("UPDATE item_scores SET provenance=? WHERE id='s-one'")
        .run(JSON.stringify({ history }));
    setHistory({
      state: "accepted",
      editionId: "prior",
      acceptedAt: now - 2000,
      update: null,
    });
    expect(draftDigest(s, options)).toMatchObject({
      status: "no_digest",
      decisions: [
        {
          itemId: "one",
          reasons: ["previously_published_without_documented_update"],
          priorEditionId: "prior",
        },
      ],
    });
    setHistory({
      state: "accepted",
      editionId: "prior",
      acceptedAt: now - 2000,
      update: { observedAt: now - 1000 },
    });
    expect(draftDigest(s, options)).toMatchObject({
      status: "ready",
      decisions: [
        {
          itemId: "one",
          included: true,
          reasons: ["meets_quality_threshold", "documented_update"],
          priorEditionId: "prior",
        },
      ],
    });
    setHistory({
      state: "unknown",
      reason: "ambiguous_delivery",
      editionId: "uncertain",
    });
    expect(draftDigest(s, options)).toMatchObject({
      status: "no_digest",
      decisions: [
        {
          itemId: "one",
          reasons: ["prior_delivery_ambiguous"],
          priorEditionId: "uncertain",
        },
      ],
    });
    setHistory({
      state: "unknown",
      reason: "historical_snapshot_limit",
      editionId: "large-prior",
    });
    expect(draftDigest(s, options)).toMatchObject({
      status: "no_digest",
      decisions: [
        {
          itemId: "one",
          reasons: ["prior_delivery_ambiguous"],
          priorEditionId: "large-prior",
        },
      ],
    });
    setHistory({ state: "unknown", reason: "no_confirmed_delivery" });
    expect(draftDigest(s, options).status).toBe("ready");
  } finally {
    s.close();
  }
});

test("draft reads one WAL snapshot during concurrent writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "digest-snapshot-"));
  const path = join(dir, "database.sqlite"),
    s = setup(path),
    writer = new Store(path);
  try {
    add(s, "one", now - 1000, now - 900);
    const original = s.sqlite.query.bind(s.sqlite);
    let changed = false;
    Object.defineProperty(s.sqlite, "query", {
      configurable: true,
      value: (sql: string) => {
        const statement = original(sql);
        if (!sql.startsWith("SELECT item_id FROM digest_activity"))
          return statement;
        return new Proxy(statement, {
          get(target, key) {
            if (key === "all")
              return (...args: unknown[]) => {
                const rows = Reflect.apply(target.all, target, args);
                if (!changed) {
                  changed = true;
                  writer.sqlite
                    .query(
                      "UPDATE items SET title='Concurrent change' WHERE id='one'",
                    )
                    .run();
                }
                return rows;
              };
            return Reflect.get(target, key, target);
          },
        });
      },
    });
    const draft = draftDigest(s, {
      ...digestDefaults("2026-11-09", now),
      minScore: 0,
    });
    expect(changed).toBe(true);
    expect(draft.status).toBe("ready");
    expect(draft.selected[0]!.title).toBe("Robotics");
    expect(
      writer.sqlite
        .query<{ title: string }, []>("SELECT title FROM items WHERE id='one'")
        .get()!.title,
    ).toBe("Concurrent change");
  } finally {
    writer.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("late first scoring and new observations enter intake, periodic rescores do not", () => {
  const s = setup();
  try {
    add(s, "late", now - 3 * day, now - 1000);
    add(s, "updated", now - 3 * day, now - 3 * day);
    s.sqlite
      .query(
        "INSERT INTO content_versions(item_id,source_id,native_id,title,text,observed_at) VALUES('updated','source','updated','new','new',?)",
      )
      .run(now - 100);
    add(s, "periodic", now - 3 * day, now - 3 * day);
    s.sqlite
      .query(
        "INSERT INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at) VALUES('second','periodic',1,'second',?,'{}','{}',?)",
      )
      .run(SCORING_CRITERIA_VERSION, now - 50);
    const draft = draftDigest(s, {
      ...digestDefaults("2026-11-09", now),
      minScore: 0,
    });
    expect(draft.status).toBe("ready");
    expect(draft.selected.map((x) => x.itemId).sort()).toEqual([
      "late",
      "updated",
    ]);
  } finally {
    s.close();
  }
});

test("failed candidate is excluded without blocking a healthy item", () => {
  const s = setup();
  try {
    add(s, "healthy", now - 1000, now - 900);
    add(s, "failed", now - 1000, null, true);
    const draft = draftDigest(s, {
      ...digestDefaults("2026-11-09", now),
      minScore: 0,
    });
    expect(draft.status).toBe("ready");
    expect(draft.decisions).toContainEqual({
      itemId: "failed",
      included: false,
      reasons: ["processing_failed_or_unavailable"],
    });
    expect(draft.selected.map((item) => item.itemId)).toEqual(["healthy"]);
  } finally {
    s.close();
  }
});

test("only failed candidates produce unavailable rather than no-digest", () => {
  const s = setup();
  try {
    add(s, "failed", now - 1000, null, true);
    expect(
      draftDigest(s, { ...digestDefaults("2026-11-09", now), minScore: 0 }),
    ).toMatchObject({
      status: "unavailable",
      reason: "candidate_processing_failed",
    });
  } finally {
    s.close();
  }
});

test("overflow selects newest bounded pool and exposes truncation", () => {
  const s = setup();
  try {
    for (let i = 0; i < 501; i++)
      add(s, `i-${String(i).padStart(3, "0")}`, now - 1000 + i, now - 1000 + i);
    const draft = draftDigest(s, {
      ...digestDefaults("2026-11-09", now),
      minScore: 0,
    });
    expect(draft.status).toBe("ready");
    expect(draft.intake.truncated).toBe(true);
    expect(draft.decisions).toHaveLength(500);
    expect(
      draft.decisions.some((decision) => decision.itemId === "i-000"),
    ).toBe(false);
    const plan = s.sqlite
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT item_id FROM digest_activity WHERE activity_at>1 AND activity_at<=2 ORDER BY activity_at DESC,item_id DESC LIMIT 501",
      )
      .all()
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toContain("digest_activity_time");
  } finally {
    s.close();
  }
});

test("activity migration preserves latest generation's first score, not later periodic rescores", () => {
  const dir = mkdtempSync(join(tmpdir(), "digest-activity-")),
    path = join(dir, "old.sqlite"),
    old = join(dir, "migrations");
  mkdirSync(join(old, "meta"), { recursive: true });
  const root = fileURLToPath(new URL("../drizzle/", import.meta.url));
  for (const name of readdirSync(root))
    if (name.endsWith(".sql")) copyFileSync(join(root, name), join(old, name));
  const journal = JSON.parse(
    readFileSync(join(root, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx < 32);
  writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
  const db = new Database(path);
  migrate(drizzle(db), { migrationsFolder: old });
  db.exec(
    "INSERT INTO items(id,identity,title,ingested_at) VALUES('old','old','Old',1)",
  );
  const insert = db.query(
    "INSERT INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at) VALUES(?,'old',?,?,'v','{}','{}',?)",
  );
  insert.run("one", 1, "one", 10);
  insert.run("two", 2, "two", 100);
  insert.run("periodic", 1, "periodic", 150);
  db.close();
  let s: Store | undefined;
  try {
    s = new Store(path);
    expect(
      s.sqlite
        .query<{ activity_at: number }, []>(
          "SELECT activity_at FROM digest_activity WHERE item_id='old'",
        )
        .get()!.activity_at,
    ).toBe(100);
  } finally {
    s?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical identity merge preserves latest intake activity", () => {
  const s = setup();
  try {
    add(s, "winner", now - 3 * day, now - 3 * day);
    add(s, "loser", now - 3 * day, now - 50);
    s.sqlite
      .query(
        "INSERT INTO item_redirects(old_id,item_id) VALUES('loser','winner')",
      )
      .run();
    expect(
      s.sqlite
        .query<{ activity_at: number }, []>(
          "SELECT activity_at FROM digest_activity WHERE item_id='winner'",
        )
        .get()!.activity_at,
    ).toBe(now - 50);
  } finally {
    s.close();
  }
});
