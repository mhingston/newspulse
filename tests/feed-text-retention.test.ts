import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db/store";
import { DAY_MS, retentionPolicy } from "../src/retention";
import { verifyDatabase } from "../src/recovery";
import { parseFeed } from "../src/adapters/rss";
import { observedUpdate } from "../src/observed-update";

const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-feed-text-"));
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

/** Ingests one feed item and settles extract, group, analyse (none) and score. */
function scoredItem(store: Store, title: string, body: string, now: number) {
  const source = store.addSource(`https://example.test/${title}.xml`, title);
  store.enqueueDue(now);
  const poll = store.claim(now)!;
  store.complete(
    poll,
    { items: parseFeed(feed(title, body), source.url) },
    now,
  );
  const item = store.search(title)[0]!;
  store.enqueueProcessing("extract", item.id, now);
  const extract = store.claimProcessing("extract", now)!;
  store.completeProcessing(
    extract,
    "extracted",
    now,
    JSON.stringify({ status: "extracted", text: `payload ${title} body` }),
  );
  const group = store.claimProcessing("group", now)!;
  store.completeProcessing(group, "grouped", now);
  const analyse = store.claimProcessing("analyse", now)!;
  store.completeProcessing(analyse, "unavailable", now);
  const score = store.claimProcessing("score", now)!;
  store.completeProcessing(score, "scored", now);
  return item.id;
}

const count = (store: Store, sql: string) =>
  store.sqlite.query<{ n: number }, []>(sql).get()!.n;

describe("feed-text retention", () => {
  test("policy parses RETENTION_FEED_TEXT_DAYS and defaults to retaining everything", () => {
    expect(retentionPolicy({}).feedTextDays).toBeUndefined();
    expect(
      retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "30" }).feedTextDays,
    ).toBe(30);
    expect(() => retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "0" })).toThrow();
  });

  test("default policy keeps all feed text", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      scoredItem(store, "Alpha", "feedtextword body", DAY0);
      const report = store.retention(retentionPolicy({}), {
        dryRun: false,
        now: DAY0 + 3650 * DAY_MS,
      });
      expect(report.eligible.feed_text).toBe(0);
      expect(
        count(
          store,
          "SELECT count(*) n FROM content WHERE purged_at IS NOT NULL",
        ),
      ).toBe(0);
      expect(store.search("feedtextword")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("dry run reports counts without changing text or search", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      scoredItem(store, "Alpha", "feedtextword body", DAY0);
      const policy = retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" });
      const dry = store.retention(policy, {
        dryRun: true,
        now: DAY0 + 5 * DAY_MS,
      });
      expect(dry.eligible.feed_text).toBe(1);
      expect(dry.purged.feed_text).toBe(0);
      expect(store.search("feedtextword")).toHaveLength(1);
      expect(
        count(
          store,
          "SELECT count(*) n FROM retention_purges WHERE class='feed_text'",
        ),
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("applied purge clears text, marks rows unavailable, keeps identity and FTS consistent", () => {
    const dbPath = join(temp(), "db.sqlite");
    const store = new Store(dbPath);
    try {
      const itemId = scoredItem(store, "Alpha", "feedtextword body", DAY0);
      const before = {
        items: count(store, "SELECT count(*) n FROM items"),
        versions: count(store, "SELECT count(*) n FROM content_versions"),
        sources: count(store, "SELECT count(*) n FROM item_sources"),
      };
      const policy = retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" });
      const applied = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 5 * DAY_MS,
      });
      expect(applied.purged.feed_text).toBe(1);

      const item = store.getItem(itemId)!;
      expect(item.text).toBe("");
      expect(item.content_versions.every((v) => v.text === "")).toBe(true);
      expect(
        store.sqlite
          .query<{ purged_at: number | null }, [string]>(
            "SELECT purged_at FROM content WHERE item_id=?",
          )
          .get(itemId)!.purged_at,
      ).toBe(DAY0 + 5 * DAY_MS);
      expect(store.search("feedtextword")).toHaveLength(0);
      expect(store.search("Alpha")).toHaveLength(1);

      expect({
        items: count(store, "SELECT count(*) n FROM items"),
        versions: count(store, "SELECT count(*) n FROM content_versions"),
        sources: count(store, "SELECT count(*) n FROM item_sources"),
      }).toEqual(before);
      expect(verifyDatabase(dbPath).ftsConsistent).toBe(true);
    } finally {
      store.close();
    }
  });

  test("a purged item is not re-selected or re-extracted", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      const itemId = scoredItem(store, "Alpha", "feedtextword body", DAY0);
      const policy = retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" });
      store.retention(policy, { dryRun: false, now: DAY0 + 5 * DAY_MS });
      const second = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 6 * DAY_MS,
      });
      expect(second.eligible.feed_text).toBe(0);
      expect(
        count(
          store,
          "SELECT count(*) n FROM retention_purges WHERE class='feed_text'",
        ),
      ).toBe(1);
      // A blank purged row must not look like a fresh extraction target.
      const generations = store.sqlite
        .query<{ n: number }, [string]>(
          "SELECT count(*) n FROM processing_jobs WHERE item_id=? AND stage='extract'",
        )
        .get(itemId)!.n;
      expect(generations).toBe(1);
    } finally {
      store.close();
    }
  });

  test("feed text with pending grouping or scoring is protected", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      const itemId = scoredItem(store, "Alpha", "feedtextword body", DAY0);
      store.sqlite
        .query(
          "UPDATE processing_jobs SET status='pending' WHERE item_id=? AND stage='score'",
        )
        .run(itemId);
      const report = store.retention(
        retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }),
        { dryRun: false, now: DAY0 + 5 * DAY_MS },
      );
      expect(report.purged.feed_text).toBe(0);
      expect(store.search("feedtextword")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("preview counts feed text protected by pending processing as deferred", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      const itemId = scoredItem(store, "Alpha", "feedtextword body", DAY0);
      store.sqlite
        .query(
          "UPDATE processing_jobs SET status='pending' WHERE item_id=? AND stage='score'",
        )
        .run(itemId);
      const preview = store.retention(
        retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }),
        { dryRun: true, now: DAY0 + 5 * DAY_MS },
      );
      expect(preview.purged.feed_text).toBe(0);
      expect(preview.deferred).toBe(1);
    } finally {
      store.close();
    }
  });

  test("merging a purged loser keeps the transferred body tombstoned", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      const itemId = scoredItem(store, "Alpha", "feedtextword body", DAY0);
      store.retention(retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }), {
        dryRun: false,
        now: DAY0 + 5 * DAY_MS,
      });
      // The winner has an unpurged empty placeholder, so a plain copy would
      // leave it blank and eligible for ingestion to refill.
      store.sqlite.exec(`INSERT INTO items(id,identity,title,ingested_at) VALUES
        ('winner','winner-identity','Winner',${DAY0});
        INSERT INTO content(item_id,text,format) VALUES('winner','','feed-text');`);
      (
        store as unknown as { mergeItems(w: string, l: string): void }
      ).mergeItems("winner", itemId);
      expect(
        store.sqlite
          .query<{ text: string; purged_at: number | null }, [string]>(
            "SELECT text,purged_at FROM content WHERE item_id=?",
          )
          .get("winner"),
      ).toEqual({ text: "", purged_at: DAY0 + 5 * DAY_MS });
    } finally {
      store.close();
    }
  });

  test("an unchanged re-poll after purge neither restores text nor queues extraction", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = scoredItem(store, "Alpha", "feedtextword body", DAY0);
      store.retention(retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }), {
        dryRun: false,
        now: DAY0 + 5 * DAY_MS,
      });
      const source = store.addSource("https://example.test/Alpha.xml", "Alpha");
      store.enqueueDue(DAY0 + 6 * DAY_MS);
      const poll = store.claim(DAY0 + 6 * DAY_MS)!;
      store.complete(
        poll,
        { items: parseFeed(feed("Alpha", "feedtextword body"), source.url) },
        DAY0 + 6 * DAY_MS,
      );
      expect(
        store.sqlite
          .query<{ text: string }, [string]>(
            "SELECT text FROM content WHERE item_id=?",
          )
          .get(itemId)!.text,
      ).toBe("");
      expect(store.search("feedtextword")).toHaveLength(0);
      expect(
        count(
          store,
          `SELECT count(*) n FROM processing_jobs WHERE item_id='${itemId}' AND stage='extract'`,
        ),
      ).toBe(1);
      const second = store.retention(
        retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }),
        { dryRun: false, now: DAY0 + 7 * DAY_MS },
      );
      expect(second.purged.feed_text).toBe(0);
    } finally {
      store.close();
    }
  });

  test("observed-update comparison never reads purged text", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      const itemId = scoredItem(store, "Alpha", "feedtextword body", DAY0);
      store.retention(retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }), {
        dryRun: false,
        now: DAY0 + 5 * DAY_MS,
      });
      const rows = store.sqlite
        .query<
          {
            id: number;
            source_id: string;
            native_id: string;
            title: string;
            text: string;
            backfilled: number;
            observed_at: number;
          },
          [string]
        >(
          "SELECT id,source_id,native_id,title,text,backfilled,observed_at FROM content_versions WHERE item_id=? ORDER BY id",
        )
        .all(itemId);
      expect(rows.length).toBeGreaterThan(0);
      const previous = rows[0]!;
      const current = {
        ...previous,
        id: previous.id + 1000,
        text: "a substantially different replacement body with many new words to compare against the purged text",
      };
      expect(observedUpdate(previous, current)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("bounded purge passes complete across runs and each item is audited once", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      scoredItem(store, "Alpha", "alphaword body", DAY0);
      scoredItem(store, "Beta", "betaword body", DAY0);
      const policy = retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" });
      const first = store.retention(policy, {
        dryRun: false,
        limit: 1,
        now: DAY0 + 5 * DAY_MS,
      });
      expect(first.purged.feed_text).toBe(1);
      expect(first.complete).toBe(false);
      const second = store.retention(policy, {
        dryRun: false,
        limit: 1,
        now: DAY0 + 5 * DAY_MS,
      });
      expect(second.purged.feed_text).toBe(1);
      const third = store.retention(policy, {
        dryRun: false,
        limit: 1,
        now: DAY0 + 5 * DAY_MS,
      });
      expect(third.purged.feed_text).toBe(0);
      expect(
        count(
          store,
          "SELECT count(*) n FROM retention_purges WHERE class='feed_text'",
        ),
      ).toBe(2);
    } finally {
      store.close();
    }
  });

  test("a body-only change after purge is detected and the new text is restored", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      const itemId = scoredItem(store, "Alpha", "feedtextword body", DAY0);
      store.retention(retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }), {
        dryRun: false,
        now: DAY0 + 5 * DAY_MS,
      });
      // Same title, URL and guid; only the body changed.
      const source = store.addSource("https://example.test/Alpha.xml", "Alpha");
      const rePOLLED_AT = DAY0 + 5 * DAY_MS + 12 * 60 * 60 * 1000;
      store.enqueueDue(rePOLLED_AT);
      const poll = store.claim(rePOLLED_AT)!;
      store.complete(
        poll,
        {
          items: parseFeed(
            feed("Alpha", "a substantially corrected body with new facts"),
            source.url,
          ),
        },
        rePOLLED_AT,
      );
      // The new observation is fresh: its text is kept and the tombstone lifts.
      expect(
        store.sqlite
          .query<{ text: string; purged_at: number | null }, [string]>(
            "SELECT text,purged_at FROM content WHERE item_id=?",
          )
          .get(itemId),
      ).toEqual({
        text: "a substantially corrected body with new facts",
        purged_at: null,
      });
      const versions = store.sqlite
        .query<
          { text: string; purged_at: number | null; observed_at: number },
          [string]
        >(
          "SELECT text,purged_at,observed_at FROM content_versions WHERE item_id=? ORDER BY id",
        )
        .all(itemId);
      expect(versions.at(-1)).toMatchObject({
        text: "a substantially corrected body with new facts",
        purged_at: null,
        observed_at: rePOLLED_AT,
      });
      // The purged history itself stays purged and audited.
      expect(versions[0]).toMatchObject({
        text: "",
        purged_at: DAY0 + 5 * DAY_MS,
      });
      expect(
        count(
          store,
          "SELECT count(*) n FROM retention_purges WHERE item_id='" +
            itemId +
            "' AND class='feed_text'",
        ),
      ).toBe(1);
      // The restored text is searchable and a new extraction generation runs.
      expect(store.search("substantially corrected")).toHaveLength(1);
      expect(store.search("feedtextword")).toHaveLength(0);
      expect(
        count(
          store,
          `SELECT count(*) n FROM processing_jobs WHERE item_id='${itemId}' AND stage='extract'`,
        ),
      ).toBe(2);
      expect(
        store.sqlite
          .query<{ status: string; generation: number }, [string]>(
            "SELECT status,generation FROM processing_jobs WHERE item_id=? AND stage='extract' ORDER BY generation DESC LIMIT 1",
          )
          .get(itemId),
      ).toEqual({ status: "pending", generation: 2 });
      // Once the new generation settles, retention applies to the restored
      // text on its own age, exactly as for any other observation.
      const now = rePOLLED_AT + 60 * 60 * 1000;
      const settle = (
        stage: "extract" | "group" | "analyse" | "score",
        outcome: string,
        result?: string,
      ) => {
        store.completeProcessing(
          store.claimProcessing(stage, now)!,
          outcome,
          now,
          result,
        );
      };
      settle(
        "extract",
        "extracted",
        JSON.stringify({ status: "extracted", text: "payload Alpha body" }),
      );
      settle("group", "grouped");
      settle("analyse", "unavailable");
      settle("score", "scored");
      const later = store.retention(
        retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }),
        { dryRun: true, now: rePOLLED_AT + 6 * DAY_MS },
      );
      expect(later.eligible.feed_text).toBe(1);
    } finally {
      store.close();
    }
  });

  test("a title-only change after purge keeps the tombstone", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      const itemId = scoredItem(store, "Alpha", "feedtextword body", DAY0);
      store.retention(retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }), {
        dryRun: false,
        now: DAY0 + 5 * DAY_MS,
      });
      const source = store.addSource("https://example.test/Alpha.xml", "Alpha");
      store.enqueueDue(DAY0 + 6 * DAY_MS);
      const poll = store.claim(DAY0 + 6 * DAY_MS)!;
      store.complete(
        poll,
        {
          items: parseFeed(
            feed("Alpha renamed", "feedtextword body"),
            source.url,
          ),
        },
        DAY0 + 6 * DAY_MS,
      );
      expect(
        store.sqlite
          .query<{ text: string; purged_at: number | null }, [string]>(
            "SELECT text,purged_at FROM content WHERE item_id=?",
          )
          .get(itemId),
      ).toEqual({ text: "", purged_at: DAY0 + 5 * DAY_MS });
      expect(
        count(
          store,
          `SELECT count(*) n FROM processing_jobs WHERE item_id='${itemId}' AND stage='extract'`,
        ),
      ).toBe(1);
      expect(store.search("Alpha renamed")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("a changed body on a purged item without a retained fingerprint stays tombstoned", () => {
    const store = new Store(join(temp(), "db.sqlite"));
    try {
      const itemId = scoredItem(store, "Alpha", "feedtextword body", DAY0);
      store.retention(retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }), {
        dryRun: false,
        now: DAY0 + 5 * DAY_MS,
      });
      // Rows purged before the fingerprint column existed have none.
      store.sqlite
        .query(
          "UPDATE content_versions SET text_fingerprint=NULL WHERE item_id=?",
        )
        .run(itemId);
      const source = store.addSource("https://example.test/Alpha.xml", "Alpha");
      store.enqueueDue(DAY0 + 6 * DAY_MS);
      const poll = store.claim(DAY0 + 6 * DAY_MS)!;
      store.complete(
        poll,
        {
          items: parseFeed(
            feed("Alpha", "a substantially corrected body with new facts"),
            source.url,
          ),
        },
        DAY0 + 6 * DAY_MS,
      );
      expect(
        store.sqlite
          .query<{ text: string; purged_at: number | null }, [string]>(
            "SELECT text,purged_at FROM content WHERE item_id=?",
          )
          .get(itemId),
      ).toEqual({ text: "", purged_at: DAY0 + 5 * DAY_MS });
      expect(store.search("substantially corrected")).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("migrating a populated 0049 database adds the fingerprint column and preserves tombstones", () => {
    const dir = temp();
    // A database at the previous schema: one item whose feed text was already
    // purged (no fingerprint existed yet) and one item still holding text.
    const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const old = join(dir, "prior-migrations");
    mkdirSync(join(old, "meta"), { recursive: true });
    for (const file of readdirSync(migrations)) {
      if (file.endsWith(".sql") && !/^0050_/.test(file))
        copyFileSync(join(migrations, file), join(old, file));
    }
    const journal = JSON.parse(
      readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
    );
    journal.entries = journal.entries.filter(
      (entry: { tag: string }) => !entry.tag.startsWith("0050_"),
    );
    writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
    for (const file of readdirSync(join(migrations, "meta"))) {
      if (file.endsWith("_snapshot.json") && !file.startsWith("0050"))
        copyFileSync(join(migrations, "meta", file), join(old, "meta", file));
    }
    const path = join(dir, "prior.sqlite");
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA foreign_keys=ON");
    migrate(drizzle(db), { migrationsFolder: old });
    db.exec(`INSERT INTO sources(id,kind,url,title) VALUES('src','rss','https://example.test/migration.xml','Feed');
      INSERT INTO items(id,identity,title,ingested_at,status) VALUES('legacy','url:https://example.test/legacy','Legacy',${DAY0},'extracted');
      INSERT INTO item_sources(item_id,source_id,native_id,url) VALUES('legacy','src','legacy-1','https://example.test/legacy');
      INSERT INTO content_versions(item_id,source_id,native_id,title,text,url,observed_at,purged_at) VALUES('legacy','src','legacy-1','Legacy','','https://example.test/legacy',${DAY0},${DAY0});
      INSERT INTO content(item_id,text,purged_at) VALUES('legacy','',${DAY0});
      INSERT INTO retention_purges(item_id,generation,class,purged_at,reason) VALUES('legacy',0,'feed_text',${DAY0},'retention');
      INSERT INTO items(id,identity,title,ingested_at,status) VALUES('fresh','url:https://example.test/fresh','Fresh',${DAY0},'extracted');
      INSERT INTO item_sources(item_id,source_id,native_id,url) VALUES('fresh','src','fresh-1','https://example.test/fresh');
      INSERT INTO content_versions(item_id,source_id,native_id,title,text,url,observed_at) VALUES('fresh','src','fresh-1','Fresh','migrationword body','https://example.test/fresh',${DAY0});
      INSERT INTO content(item_id,text) VALUES('fresh','migrationword body');`);
    const backup = join(dir, "backup.sqlite");
    db.query("VACUUM INTO ?").run(backup);
    db.close();

    // Reopening runs the new migration; the preserved tombstone keeps the
    // purged row unavailable, and newly purged text gains a fingerprint.
    const store = new Store(path);
    try {
      expect(
        store.sqlite
          .query<{ name: string }, []>(
            "SELECT name FROM pragma_table_info('content_versions') WHERE name='text_fingerprint'",
          )
          .all(),
      ).toHaveLength(1);
      expect(store.search("migrationword")).toHaveLength(1);
      expect(store.getItem("legacy")!.text).toBe("");

      // The legacy tombstone has no fingerprint, so a changed body stays
      // conservatively unavailable instead of being mistaken for unchanged.
      store.enqueueDue(DAY0 + DAY_MS, true);
      const poll = store.claim(DAY0 + DAY_MS)!;
      store.complete(
        poll,
        {
          items: parseFeed(
            `<?xml version="1.0"?>\n<rss version="2.0"><channel><title>Feed</title>\n<item><title>Legacy</title><link>https://example.test/legacy</link><guid>legacy-1</guid><description>a republished body with entirely new wording here</description></item>\n<item><title>Fresh</title><link>https://example.test/fresh</link><guid>fresh-1</guid><description>migrationword body</description></item>\n</channel></rss>`,
            "https://example.test/migration.xml",
          ),
        },
        DAY0 + DAY_MS,
      );
      expect(store.getItem("legacy")!.text).toBe("");
      expect(store.search("entirely new wording")).toHaveLength(0);

      // The fresh item is settled only after its pipeline completes; run the
      // real purge, which must record fingerprints for the preserved text.
      const staged = DAY0 + DAY_MS;
      store.completeProcessing(
        store.claimProcessing("extract", staged)!,
        "extracted",
        staged,
        JSON.stringify({ status: "extracted", text: "payload" }),
      );
      store.completeProcessing(
        store.claimProcessing("group", staged)!,
        "grouped",
        staged,
      );
      store.completeProcessing(
        store.claimProcessing("analyse", staged)!,
        "unavailable",
        staged,
      );
      store.completeProcessing(
        store.claimProcessing("score", staged)!,
        "scored",
        staged,
      );
      store.retention(retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }), {
        dryRun: false,
        now: DAY0 + 5 * DAY_MS,
      });
      expect(store.getItem("fresh")!.text).toBe("");
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM content_versions WHERE item_id='fresh' AND text_fingerprint IS NOT NULL",
          )
          .get()!.n,
      ).toBe(1);

      // And a later body-only change on the migrated-then-purged item restores.
      store.enqueueDue(DAY0 + 6 * DAY_MS, true);
      const second = store.claim(DAY0 + 6 * DAY_MS)!;
      store.complete(
        second,
        {
          items: parseFeed(
            `<?xml version="1.0"?>\n<rss version="2.0"><channel><title>Feed</title>\n<item><title>Fresh</title><link>https://example.test/fresh</link><guid>fresh-1</guid><description>a corrected migrationword-free body</description></item>\n</channel></rss>`,
            "https://example.test/migration.xml",
          ),
        },
        DAY0 + 6 * DAY_MS,
      );
      expect(store.getItem("fresh")!.text).toBe(
        "a corrected migrationword-free body",
      );
      expect(store.search("a corrected migrationword-free body")).toHaveLength(
        1,
      );
      // The pristine backup copy still verifies and restores unchanged.
      expect(verifyDatabase(backup).ok).toBe(true);
    } finally {
      store.close();
    }
  });
});
