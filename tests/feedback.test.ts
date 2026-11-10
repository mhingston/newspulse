import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db/store";
import { recordFeedback, latestFeedback } from "../src/feedback";
import { DiscoveryPlannerStore } from "../src/db/discovery-planner-store";
import { runDiscovery } from "../src/discovery-service";
import { planDiscoveryQueries } from "../src/discovery-planner";
import { submitUrl } from "../src/manual";
import type { SearchProvider } from "../src/search-provider";
import type { Interest } from "../src/profiles";

const interest = (overrides: Partial<Interest> = {}): Interest => ({
  kind: "interest",
  id: "robotics",
  version: 1,
  description: "Robotics research",
  entities: ["robotics"],
  keywords: ["robotics"],
  priority: 3,
  positive: ["research"],
  negative: ["advertising"],
  queries: ["robotics research", "robotics lab"],
  lifetime: "persistent",
  feedbackRefs: [],
  ...overrides,
});

describe("explicit feedback", () => {
  test("records provenance, invalidates scores and never infers missing clicks", () => {
    const store = new Store(":memory:");
    try {
      store.addSource("https://example.com/feed");
      store.enqueueDue();
      store.complete(store.claim()!, {
        items: [
          {
            nativeId: "1",
            url: "https://example.com/a",
            title: "Item",
            text: "body",
          },
        ],
      });
      const item = store.search("body")[0]!;
      // Extraction completes so a score job exists to invalidate.
      const extract = store.claimProcessing("extract")!;
      store.completeProcessing(extract, "extracted");

      const event = recordFeedback(store.sqlite, {
        itemId: item.id,
        action: "useful",
        source: "mcp",
        now: 5,
      });
      expect(event).toMatchObject({
        itemId: item.id,
        useful: true,
        source: "mcp",
        editionDate: null,
      });
      expect(latestFeedback(store.sqlite)).toEqual([event]);
      // The feedback is explicit and re-derives scores with recorded evidence.
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM score_validity_events WHERE kind='item_invalidation'",
          )
          .get()!.n,
      ).toBe(1);
      expect(
        store.sqlite
          .query<{ status: string }, []>(
            "SELECT status FROM processing_jobs WHERE stage='score'",
          )
          .get()!.status,
      ).toBe("pending");

      // An item nobody gave feedback on stays absent from the ledger.
      store.addSource("https://example.com/other");
      store.enqueueDue();
      store.complete(store.claim()!, {
        items: [{ nativeId: "2", title: "Unread", text: "silent" }],
      });
      const other = store.search("silent")[0]!;
      expect(latestFeedback(store.sqlite).map((row) => row.itemId)).toEqual([
        item.id,
      ]);
      expect(other.id).not.toBe(item.id);
    } finally {
      store.close();
    }
  });

  test("the latest feedback reaches the score input with same-millisecond ties broken deterministically", () => {
    const store = new Store(":memory:");
    try {
      store.addSource("https://example.com/feed");
      store.enqueueDue();
      store.complete(store.claim()!, {
        items: [{ nativeId: "1", title: "Item", text: "body" }],
      });
      const item = store.search("body")[0]!;
      const extract = store.claimProcessing("extract")!;
      store.completeProcessing(extract, "extracted");
      // Two explicit judgments in the same millisecond: the later row wins, so
      // the ledger never exposes two contradicting "latest" rows.
      recordFeedback(store.sqlite, {
        itemId: item.id,
        action: "not_useful",
        source: "mcp",
        now: 5,
      });
      recordFeedback(store.sqlite, {
        itemId: item.id,
        action: "useful",
        source: "mcp",
        now: 5,
      });
      expect(latestFeedback(store.sqlite)).toHaveLength(1);
      expect(latestFeedback(store.sqlite)[0]!.useful).toBe(true);
      const job = store.claimProcessing("score")!;
      const snapshot = store.scoringSnapshot(job)!;
      expect(snapshot.input.feedback).toEqual({ useful: true, at: 5 });
    } finally {
      store.close();
    }
  });

  test("feedback on a discovered item changes subsequent query selection", async () => {
    const store = new Store(":memory:");
    try {
      const planner = new DiscoveryPlannerStore(store.sqlite);
      const queries = planDiscoveryQueries([interest()]);
      planner.sync(queries, 1000, 86_400_000);
      const labQuery = queries.find((query) => query.query === "robotics lab")!;
      const provider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search() {
          return {
            results: [
              {
                url: "https://discovered.example/item",
                title: "Robotics lab result",
              },
            ],
            truncated: false,
          };
        },
      };
      await runDiscovery(
        store,
        provider,
        labQuery.query,
        {
          maxQueriesPerDay: 10,
          maxQueriesPerRun: 1,
          maxResultsPerDay: 10,
          maxResultsPerRun: 1,
          maxCostMicrosPerDay: 10,
          maxCostMicrosPerRun: 1,
          reservedCostMicrosPerQuery: 1,
        },
        () => 1001,
        {
          queryKind: "interest",
          scheduleKey: labQuery.key,
          interestLineage: labQuery.interestLineage,
        },
      );
      const itemId = store.sqlite
        .query<{ item_id: string }, []>("SELECT item_id FROM discovery_results")
        .get()!.item_id;

      // Useful feedback propagates to the discovery ledger and prioritizes the
      // query that found the item.
      recordFeedback(store.sqlite, {
        itemId,
        action: "useful",
        source: "mcp",
        now: 1002,
      });
      expect(planner.due(1003, 10)[0]?.query).toBe("robotics lab");
      expect(
        planner
          .history()
          .find((row) => (row as { query: string }).query === "robotics lab"),
      ).toMatchObject({ useful_discoveries: 1 });

      // A later not-useful signal reverses the selection with provenance.
      recordFeedback(store.sqlite, {
        itemId,
        action: "not_useful",
        source: "mcp",
        now: 1004,
      });
      expect(planner.due(1005, 10)[0]?.query).toBe("robotics research");
      expect(
        planner
          .history()
          .find((row) => (row as { query: string }).query === "robotics lab"),
      ).toMatchObject({ useful_discoveries: 0, not_useful_discoveries: 1 });
    } finally {
      store.close();
    }
  });

  test("a merge repoints explicit feedback to the surviving item", () => {
    const store = new Store(":memory:");
    try {
      store.sqlite
        .query(
          "INSERT INTO items(id,identity,url,title,ingested_at) VALUES(?,?,?,?,?)",
        )
        .run(
          "legacy",
          "url:https://old.reddit.com/r/rust/comments/abc123/title/",
          "https://old.reddit.com/r/rust/comments/abc123/title/",
          "Legacy discussion",
          50,
        );
      store.sqlite
        .query("INSERT INTO content(item_id,text) VALUES(?,?)")
        .run("legacy", "legacy body");
      recordFeedback(store.sqlite, {
        itemId: "legacy",
        action: "useful",
        source: "mcp",
        now: 60,
      });
      const submitted = submitUrl(store, {
        submissionId: "s1",
        url: "https://redd.it/abc123",
        origin: "manual",
        now: 100,
      });
      expect(submitted.itemId).toBe("legacy");
      // The feedback follows the surviving item; no row references a deleted
      // item.
      expect(latestFeedback(store.sqlite).map((row) => row.itemId)).toEqual([
        submitted.itemId,
      ]);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM item_feedback WHERE item_id NOT IN (SELECT id FROM items)",
          )
          .get()!.n,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("a populated pre-#18 database migrates and can record feedback", () => {
    const dir = mkdtempSync(join(tmpdir(), "newspulse-feedback-migration-"));
    const prior = join(dir, "prior-migrations");
    const path = join(dir, "prior.sqlite");
    mkdirSync(join(prior, "meta"), { recursive: true });
    const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
    for (const file of readdirSync(migrations))
      if (file.endsWith(".sql"))
        copyFileSync(join(migrations, file), join(prior, file));
    const journal = JSON.parse(
      readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number }[] };
    // Everything before the feedback/confirmation tables were introduced.
    journal.entries = journal.entries.filter((entry) => entry.idx < 45);
    writeFileSync(join(prior, "meta/_journal.json"), JSON.stringify(journal));
    const db = new Database(path);
    migrate(drizzle(db), { migrationsFolder: prior });
    db.exec(`
      INSERT INTO sources(id,kind,url,title) VALUES('s','rss','https://example.com/feed','Feed');
      INSERT INTO items(id,identity,url,title,ingested_at)
        VALUES('existing','url:https://example.com/known','https://example.com/known','Known page',100);
      INSERT INTO content(item_id,text) VALUES('existing','searchable historical body');
      INSERT INTO item_sources(item_id,source_id,native_id,url)
        VALUES('existing','s','known','https://example.com/known');
    `);
    for (const table of [
      "item_feedback",
      "digest_feedback_tokens",
      "mutation_confirmations",
    ])
      expect(
        db
          .query("SELECT count(*) AS n FROM sqlite_master WHERE name=?")
          .get(table),
      ).toEqual({ n: 0 });
    db.close();
    let store: Store | undefined;
    try {
      store = new Store(path);
      // Historical identity and search survive the migration unchanged.
      expect(store.search("historical").map((item) => item.id)).toEqual([
        "existing",
      ]);
      const event = recordFeedback(store.sqlite, {
        itemId: "existing",
        action: "useful",
        source: "mcp",
        now: 500,
      });
      expect(latestFeedback(store.sqlite)).toEqual([event]);
    } finally {
      store?.close();
    }
  });
});
