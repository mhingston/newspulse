import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
