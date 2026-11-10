import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { DiscoveryPlannerStore } from "../src/db/discovery-planner-store";
import { DiscoveryStore } from "../src/db/discovery-store";
import { runDiscovery } from "../src/discovery-service";
import {
  planDiscoveryQueries,
  allocateQuerySlots,
} from "../src/discovery-planner";
import { ProfileStore, type Interest } from "../src/profiles";
import { runScheduledDiscovery } from "../src/scheduled-discovery";
import type { SearchProvider } from "../src/search-provider";
import { ProcessingWorker } from "../src/worker";
import { scoringHandler } from "../src/scoring-service";
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
  queries: ["robotics research"],
  lifetime: "persistent",
  feedbackRefs: [],
  ...overrides,
});

describe("discovery planning", () => {
  test("is deterministic, excludes expired interests, and constrains explicit negatives", () => {
    const profiles = [
      interest(),
      interest({
        id: "climate",
        entities: ["climate"],
        keywords: ["climate"],
        queries: ["climate research"],
        priority: 2,
      }),
      interest({
        id: "expired",
        lifetime: "temporary",
        expiresAt: 100,
        queries: ["expired topic"],
      }),
    ];
    const active = profiles.filter(
      (p) => p.lifetime === "persistent" || p.expiresAt! > 100,
    );
    const first = planDiscoveryQueries(active);
    expect(planDiscoveryQueries(active)).toEqual(first);
    expect(first.some((q) => q.query === "expired topic")).toBe(false);
    expect(first.some((q) => q.query.includes("advertising"))).toBe(false);
    expect(
      first.some(
        (q) =>
          q.kind === "adjacent" &&
          q.query.includes("robotics") &&
          q.query.includes("climate"),
      ),
    ).toBe(true);
    expect(
      first.find((query) => query.kind === "adjacent")?.interestLineage,
    ).toEqual([
      { id: "robotics", version: 1 },
      { id: "climate", version: 1 },
    ]);
  });

  test("merges shared-query negative terms before deciding whether it is eligible", () => {
    const shared = planDiscoveryQueries([
      interest({ queries: ["robotics research"], negative: [] }),
      interest({
        id: "robotics-2",
        queries: ["robotics research"],
        negative: ["research"],
      }),
    ]);
    expect(shared.some((query) => query.query === "robotics research")).toBe(
      false,
    );
    const retained = planDiscoveryQueries([
      interest({ queries: ["robotics research"], negative: [] }),
      interest({
        id: "robotics-2",
        queries: ["robotics research"],
        negative: ["advertising"],
      }),
    ]);
    expect(retained[0]?.interestLineage).toEqual([
      { id: "robotics", version: 1 },
      { id: "robotics-2", version: 1 },
    ]);
    expect(retained[0]?.negative).toEqual(["advertising"]);
  });

  test("allocates a bounded adjacent reserve and uses unused primary capacity", () => {
    const queries = planDiscoveryQueries([
      interest(),
      interest({
        id: "climate",
        entities: ["climate"],
        keywords: ["climate"],
        queries: ["climate news"],
      }),
    ]);
    const planned = allocateQuerySlots(queries, 4, 25);
    expect(planned).toHaveLength(3);
    expect(planned.filter((q) => q.kind === "adjacent").length).toBe(1);
    expect(
      allocateQuerySlots(queries, 1, 20, { total: 4, adjacent: 0 }).map(
        (query) => query.kind,
      ),
    ).toEqual(["adjacent"]);
    expect(
      allocateQuerySlots(queries, 1, 100, { total: 10, adjacent: 0 }),
    ).toHaveLength(1);
    const adjacent = queries.filter((query) => query.kind === "adjacent");
    expect(allocateQuerySlots(adjacent, 1, 0)).toEqual([]);
    expect(allocateQuerySlots(adjacent, 1, 20)).toHaveLength(1);
  });

  test("configured query kind wins over a higher-priority adjacent duplicate", () => {
    const queries = planDiscoveryQueries([
      interest({
        id: "robotics",
        priority: 5,
        entities: ["robotics"],
        keywords: ["robotics"],
      }),
      interest({
        id: "climate",
        priority: 1,
        entities: ["climate"],
        keywords: ["climate"],
        queries: ["robotics climate"],
      }),
    ]);
    expect(
      queries.find((query) => query.query === "robotics climate"),
    ).toMatchObject({
      kind: "interest",
    });
  });

  test("persisted feedback prioritizes useful queries, while missing feedback is neutral", async () => {
    const store = new Store(":memory:");
    try {
      const planner = new DiscoveryPlannerStore(store.sqlite);
      const q = planDiscoveryQueries([
        interest({ queries: ["robotics research", "robotics lab"] }),
      ]);
      planner.sync(q, 1000, 86_400_000);
      const labQuery = q.find((query) => query.query === "robotics lab")!;
      const provider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search() {
          return {
            results: [
              {
                url: "https://feedback.example/item",
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
      const result = store.sqlite
        .query<{ item_id: string }, []>("SELECT item_id FROM discovery_results")
        .get()!;
      planner.feedbackForLatestItemResult(result.item_id, true, 1002);
      const due = planner.due(1003, 10);
      expect(due[0]?.query).toBe("robotics lab");
      expect(
        due.find((item) => item.query === "robotics research")?.utility,
      ).toBe(0);
      expect(
        planner.history().find((item: any) => item.query === "robotics lab"),
      ).toMatchObject({ useful_discoveries: 1 });
      planner.feedbackForLatestItemResult(result.item_id, false, 1004);
      expect(planner.due(1005, 10)[0]?.query).toBe("robotics research");
      expect(
        planner.history().find((item: any) => item.query === "robotics lab"),
      ).toMatchObject({ useful_discoveries: 0, not_useful_discoveries: 1 });
    } finally {
      store.close();
    }
  });

  test("latest item feedback replaces older votes across repeated result rows and queries", async () => {
    const store = new Store(":memory:");
    try {
      const planner = new DiscoveryPlannerStore(store.sqlite);
      const queries = planDiscoveryQueries([
        interest({ queries: ["robotics research", "robotics lab"] }),
      ]);
      planner.sync(queries, 1000, 86_400_000);
      const provider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search() {
          return {
            results: [
              { url: "https://repeated.example/item", title: "Repeated" },
            ],
            truncated: false,
          };
        },
      };
      const config = {
        maxQueriesPerDay: 10,
        maxQueriesPerRun: 1,
        maxResultsPerDay: 10,
        maxResultsPerRun: 1,
        maxCostMicrosPerDay: 10,
        maxCostMicrosPerRun: 1,
        reservedCostMicrosPerQuery: 1,
      };
      for (const [index, query] of queries.entries()) {
        await runDiscovery(
          store,
          provider,
          query.query,
          config,
          () => 1001 + index,
          {
            queryKind: "interest",
            scheduleKey: query.key,
            interestLineage: query.interestLineage,
          },
        );
      }
      const item = store.sqlite
        .query<{ item_id: string }, []>(
          "SELECT item_id FROM discovery_results LIMIT 1",
        )
        .get()!.item_id;
      planner.feedbackForLatestItemResult(item, true, 1004);
      expect(
        planner
          .history()
          .map((row: any) => [
            row.query,
            row.useful_discoveries,
            row.not_useful_discoveries,
          ]),
      ).toEqual([
        ["robotics lab", 1, 0],
        ["robotics research", 1, 0],
      ]);
      planner.feedbackForLatestItemResult(item, false, 1005);
      expect(
        planner
          .due(1006, 10)
          .map((row) => [row.query, row.utility])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["robotics lab", -40],
        ["robotics research", -40],
      ]);
      expect(
        planner
          .history()
          .map((row: any) => [
            row.query,
            row.useful_discoveries,
            row.not_useful_discoveries,
          ]),
      ).toEqual([
        ["robotics lab", 0, 1],
        ["robotics research", 0, 1],
      ]);
    } finally {
      store.close();
    }
  });

  test("schedule deadlines survive restart and catch up only when due", () => {
    const dir = mkdtempSync(join(tmpdir(), "newspulse-query-schedule-"));
    const path = join(dir, "db.sqlite");
    let store = new Store(path);
    try {
      const query = planDiscoveryQueries([interest()]);
      const planner = new DiscoveryPlannerStore(store.sqlite);
      planner.sync(query, 1000, 60_000);
      planner.markAttempt(query[0]!.key, "run-1", 1000, 60_000);
      store.close();
      store = new Store(path);
      const resumed = new DiscoveryPlannerStore(store.sqlite);
      resumed.sync(query, 50_000, 60_000);
      expect(resumed.due(60_999, 10)).toHaveLength(0);
      expect(resumed.due(61_000, 10)).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("schedule sync uses indexed recent runs and ignores older execution history", () => {
    const store = new Store(":memory:");
    try {
      const query = planDiscoveryQueries([interest()])[0]!;
      const now = 5_000_000_000;
      const intervalMs = 86_400_000;
      const insertRun = store.sqlite.query(
        `INSERT INTO discovery_runs(id,query,provider,provider_version,subscription_snapshot,status,started_at,schedule_key)
         VALUES(?,?,'fixture','1','{}','completed',?,?)`,
      );
      const insertPage = store.sqlite.query(
        `INSERT INTO discovery_pages(id,run_id,budget_day,reserved_results,reserved_cost_micros,status,started_at,finished_at)
         VALUES(?,?,0,1,1,'complete',?,?)`,
      );
      for (const [id, startedAt] of [
        ["old-run", now - intervalMs - 1],
        ["recent-run", now - 60_000],
      ] as const) {
        insertRun.run(id, query.query, startedAt, query.key);
        insertPage.run(`${id}-page`, id, startedAt, startedAt);
      }
      const planner = new DiscoveryPlannerStore(store.sqlite);
      planner.sync([query], now, intervalMs);
      expect(
        store.sqlite
          .query<{ next_due_at: number }, [string]>(
            "SELECT next_due_at FROM discovery_query_state WHERE query_key=?",
          )
          .get(query.key)?.next_due_at,
      ).toBe(now - 60_000 + intervalMs);

      const plan = store.sqlite
        .query<{ detail: string }, [number, string]>(
          `EXPLAIN QUERY PLAN SELECT r.schedule_key,max(r.started_at)
           FROM discovery_runs r WHERE r.started_at>=? AND r.schedule_key IN (?)
           AND EXISTS(SELECT 1 FROM discovery_pages p WHERE p.run_id=r.id)
           GROUP BY r.schedule_key`,
        )
        .all(now - intervalMs, query.key)
        .map((row) => row.detail);
      expect(
        plan.some((detail) =>
          detail.includes("discovery_runs_schedule_started"),
        ),
      ).toBe(true);
      expect(
        plan.some((detail) => detail.includes("discovery_pages_run")),
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  test("scheduled discovery skips sync while the daily budget is exhausted", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([interest()]);
      const now = 86_400_000 * 20;
      store.sqlite.exec(`
        INSERT INTO discovery_runs(id,query,provider,provider_version,subscription_snapshot,status,started_at)
        VALUES('budget-run','manual','fixture','1','{}','completed',${now});
        INSERT INTO discovery_pages(id,run_id,budget_day,reserved_results,reserved_cost_micros,status,started_at,finished_at)
        VALUES('budget-page','budget-run',20,1,1,'complete',${now},${now});
      `);
      const config = {
        limits: {
          maxQueriesPerDay: 1,
          maxQueriesPerRun: 1,
          maxResultsPerDay: 10,
          maxResultsPerRun: 5,
          maxCostMicrosPerDay: 10,
          maxCostMicrosPerRun: 5,
          reservedCostMicrosPerQuery: 1,
        },
        intervalMs: 86_400_000,
        adjacentPercent: 20,
      };
      const provider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search() {
          return { results: [], truncated: false };
        },
      };
      expect(
        await runScheduledDiscovery(
          store,
          config,
          now + 1,
          provider,
          () => now + 1,
        ),
      ).toBe(0);
      expect(
        store.sqlite
          .query("SELECT count(*) AS n FROM discovery_query_state")
          .get(),
      ).toEqual({ n: 0 });
      expect(
        await runScheduledDiscovery(
          store,
          config,
          now + 86_400_000 + 1,
          provider,
          () => now + 86_400_000 + 1,
        ),
      ).toBe(1);
      expect(
        store.sqlite
          .query("SELECT count(*) AS n FROM discovery_query_state")
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      store.close();
    }
  });

  test("a temporary interest expiring between ticks cannot dispatch its cached query", async () => {
    const store = new Store(":memory:");
    try {
      const now = 1_000_000;
      const temporary = interest({
        lifetime: "temporary",
        expiresAt: now + 5_000,
      });
      new ProfileStore(store.sqlite).import([temporary]);
      const query = planDiscoveryQueries([temporary])[0]!;
      const planner = new DiscoveryPlannerStore(store.sqlite);
      planner.sync([query], now, 60_000);
      store.sqlite
        .query(
          "UPDATE discovery_query_state SET next_due_at=? WHERE query_key=?",
        )
        .run(now + 10_000, query.key);
      let calls = 0;
      const provider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search() {
          calls++;
          return { results: [], truncated: false };
        },
      };
      const config = {
        limits: {
          maxQueriesPerDay: 10,
          maxQueriesPerRun: 1,
          maxResultsPerDay: 10,
          maxResultsPerRun: 5,
          maxCostMicrosPerDay: 10,
          maxCostMicrosPerRun: 5,
          reservedCostMicrosPerQuery: 1,
        },
        intervalMs: 60_000,
        adjacentPercent: 20,
      };
      await runScheduledDiscovery(store, config, now, provider, () => now);
      expect(
        await runScheduledDiscovery(
          store,
          config,
          now + 11_000,
          provider,
          () => now + 11_000,
        ),
      ).toBe(0);
      expect(calls).toBe(0);
      expect(
        store.sqlite
          .query<{ enabled: number }, [string]>(
            "SELECT enabled FROM discovery_query_state WHERE query_key=?",
          )
          .get(query.key)?.enabled,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("profile preference edits between ticks invalidate cached negative queries", async () => {
    const store = new Store(":memory:");
    try {
      const now = 2_000_000;
      const original = interest();
      new ProfileStore(store.sqlite).import([original]);
      const query = planDiscoveryQueries([original])[0]!;
      const planner = new DiscoveryPlannerStore(store.sqlite);
      planner.sync([query], now, 60_000);
      store.sqlite
        .query(
          "UPDATE discovery_query_state SET next_due_at=? WHERE query_key=?",
        )
        .run(now + 10_000, query.key);
      let calls = 0;
      const provider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search() {
          calls++;
          return { results: [], truncated: false };
        },
      };
      const config = {
        limits: {
          maxQueriesPerDay: 10,
          maxQueriesPerRun: 1,
          maxResultsPerDay: 10,
          maxResultsPerRun: 5,
          maxCostMicrosPerDay: 10,
          maxCostMicrosPerRun: 5,
          reservedCostMicrosPerQuery: 1,
        },
        intervalMs: 60_000,
        adjacentPercent: 20,
      };
      await runScheduledDiscovery(store, config, now, provider, () => now);
      new ProfileStore(store.sqlite).import([
        interest({ version: 2, negative: ["robotics"] }),
      ]);
      expect(
        await runScheduledDiscovery(
          store,
          config,
          now + 11_000,
          provider,
          () => now + 11_000,
        ),
      ).toBe(0);
      expect(calls).toBe(0);
      expect(
        store.sqlite
          .query<{ enabled: number }, [string]>(
            "SELECT enabled FROM discovery_query_state WHERE query_key=?",
          )
          .get(query.key)?.enabled,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("a profile collision becoming adjacent is reallocated before dispatch", async () => {
    const store = new Store(":memory:");
    try {
      const now = 3_000_000;
      const robotics = interest({
        id: "robotics",
        priority: 5,
        entities: ["robotics"],
        keywords: ["robotics"],
        queries: [],
      });
      const climate = interest({
        id: "climate",
        priority: 1,
        entities: ["climate"],
        keywords: ["climate"],
        queries: ["robotics climate"],
      });
      new ProfileStore(store.sqlite).import([robotics, climate]);
      const configured = planDiscoveryQueries([robotics, climate]).find(
        (query) => query.query === "robotics climate",
      )!;
      expect(configured.kind).toBe("interest");
      const planner = new DiscoveryPlannerStore(store.sqlite);
      planner.sync([configured], now, 60_000);
      store.sqlite
        .query(
          "UPDATE discovery_query_state SET next_due_at=? WHERE query_key=?",
        )
        .run(now + 10_000, configured.key);
      let calls = 0;
      const provider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search() {
          calls++;
          return { results: [], truncated: false };
        },
      };
      const config = {
        limits: {
          maxQueriesPerDay: 10,
          maxQueriesPerRun: 1,
          maxResultsPerDay: 10,
          maxResultsPerRun: 5,
          maxCostMicrosPerDay: 10,
          maxCostMicrosPerRun: 5,
          reservedCostMicrosPerQuery: 1,
        },
        intervalMs: 60_000,
        adjacentPercent: 0,
      };
      await runScheduledDiscovery(store, config, now, provider, () => now);
      new ProfileStore(store.sqlite).import([
        interest({
          id: "climate",
          version: 2,
          priority: 1,
          entities: ["climate"],
          keywords: ["climate"],
          queries: [],
        }),
      ]);
      expect(
        await runScheduledDiscovery(
          store,
          config,
          now + 11_000,
          provider,
          () => now + 11_000,
        ),
      ).toBe(0);
      expect(
        store.sqlite
          .query<{ kind: string }, [string]>(
            "SELECT kind FROM discovery_query_state WHERE query_key=?",
          )
          .get(configured.key)?.kind,
      ).toBe("adjacent");
      expect(
        await runScheduledDiscovery(
          store,
          config,
          now + 12_000,
          provider,
          () => now + 12_000,
        ),
      ).toBe(0);
      expect(calls).toBe(0);
    } finally {
      store.close();
    }
  });

  test("populated scheduled-query state migrates with lineage defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "newspulse-discovery-migration-"));
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
    journal.entries = journal.entries.filter((entry) => entry.idx < 42);
    writeFileSync(join(prior, "meta/_journal.json"), JSON.stringify(journal));
    const db = new Database(path);
    migrate(drizzle(db), { migrationsFolder: prior });
    db.exec(`
      INSERT INTO discovery_query_state(query_key,query,kind,interest_id,interest_version,priority,negative_terms,enabled,next_due_at,last_run_at,last_run_id)
      VALUES('robotics research','robotics research','interest','robotics',1,300,'[]',1,1000,500,'manual-run');
      INSERT INTO discovery_runs(id,query,provider,provider_version,subscription_snapshot,status,started_at)
      VALUES('manual-run','robotics research','fixture','1','{}','completed',500);
    `);
    db.close();
    let upgraded: Store | undefined;
    try {
      upgraded = new Store(path);
      expect(
        upgraded.sqlite
          .query<{ interest_lineage: string }, []>(
            "SELECT interest_lineage FROM discovery_query_state WHERE query_key='robotics research'",
          )
          .get(),
      ).toEqual({ interest_lineage: "[]" });
      expect(
        upgraded.sqlite
          .query<{ query_kind: string; interest_lineage: string }, []>(
            "SELECT query_kind,interest_lineage FROM discovery_runs WHERE id='manual-run'",
          )
          .get(),
      ).toEqual({ query_kind: "manual", interest_lineage: "[]" });
    } finally {
      upgraded?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("schedule sync honors manual results and an interrupted reserved attempt", async () => {
    const store = new Store(":memory:");
    try {
      const queries = planDiscoveryQueries([interest()]);
      const planner = new DiscoveryPlannerStore(store.sqlite);
      planner.sync(queries, 1000, 60_000);
      const provider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search() {
          return { results: [], truncated: false };
        },
      };
      await runDiscovery(
        store,
        provider,
        "  ROBOTICS   RESEARCH ",
        {
          maxQueriesPerDay: 10,
          maxQueriesPerRun: 1,
          maxResultsPerDay: 10,
          maxResultsPerRun: 1,
          maxCostMicrosPerDay: 10,
          maxCostMicrosPerRun: 1,
          reservedCostMicrosPerQuery: 1,
        },
        () => 2000,
      );
      planner.sync(queries, 3000, 60_000);
      expect(planner.due(61_999, 10)).toHaveLength(0);
      expect(planner.due(62_000, 10)).toHaveLength(1);

      planner.sync(queries, 70_000, 60_000);
      const repo = new DiscoveryStore(store.sqlite);
      const runId = "crashed-run";
      repo.createRun({
        id: runId,
        query: "robotics research",
        provider: "fixture",
        providerVersion: "1",
        now: 71_000,
      });
      repo.reservePage({
        id: "crashed-page",
        runId,
        now: 71_000,
        reservedResults: 1,
        reservedCostMicros: 1,
        limits: {
          dailyQueries: 10,
          dailyResults: 10,
          dailyCostMicros: 10,
          runQueries: 1,
          runResults: 1,
          runCostMicros: 1,
        },
      });
      planner.sync(queries, 72_000, 60_000);
      expect(planner.due(130_999, 10)).toHaveLength(0);
      expect(planner.due(131_000, 10)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("adjacent daily share includes completed manual query executions", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([
        interest(),
        interest({
          id: "climate",
          entities: ["climate"],
          keywords: ["climate"],
          priority: 2,
          queries: ["climate research"],
        }),
      ]);
      const limits = {
        maxQueriesPerDay: 10,
        maxQueriesPerRun: 1,
        maxResultsPerDay: 100,
        maxResultsPerRun: 1,
        maxCostMicrosPerDay: 100,
        maxCostMicrosPerRun: 10,
        reservedCostMicrosPerQuery: 1,
      };
      const manualProvider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search() {
          return { results: [], truncated: false };
        },
      };
      for (let i = 0; i < 4; i++)
        await runDiscovery(
          store,
          manualProvider,
          `manual topic ${i}`,
          limits,
          () => 10_000 + i * 6_000,
        );
      const dispatched: string[] = [];
      const scheduledProvider: SearchProvider = {
        name: "fixture-scheduled",
        version: "1",
        async search({ query }) {
          dispatched.push(query);
          return { results: [], truncated: false };
        },
      };
      const config = { limits, intervalMs: 86_400_000, adjacentPercent: 20 };
      expect(
        await runScheduledDiscovery(
          store,
          config,
          34_000,
          scheduledProvider,
          () => 34_000,
        ),
      ).toBe(1);
      expect(dispatched).toEqual(["robotics climate"]);
      const run = store.sqlite
        .query<{ query_kind: string; interest_lineage: string }, []>(
          "SELECT query_kind,interest_lineage FROM discovery_runs WHERE query_kind='adjacent'",
        )
        .get()!;
      expect(run.query_kind).toBe("adjacent");
      expect(JSON.parse(run.interest_lineage)).toEqual([
        { id: "robotics", version: 1 },
        { id: "climate", version: 1 },
      ]);
    } finally {
      store.close();
    }
  });

  test("provider failure is recorded and leaves subscription polling claimable", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([interest()]);
      const provider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search() {
          throw new Error("offline");
        },
      };
      const config = {
        limits: {
          maxQueriesPerDay: 10,
          maxQueriesPerRun: 1,
          maxResultsPerDay: 100,
          maxResultsPerRun: 10,
          maxCostMicrosPerDay: 100,
          maxCostMicrosPerRun: 10,
          reservedCostMicrosPerQuery: 1,
        },
        intervalMs: 86_400_000,
        adjacentPercent: 20,
      };
      await runScheduledDiscovery(
        store,
        config,
        10_000,
        provider,
        () => 10_000,
      );
      expect(
        store.sqlite.query("SELECT status FROM discovery_runs").get(),
      ).toEqual({ status: "failed" });
      store.addSource("https://feed.example.test/rss");
      expect(store.enqueueDue(10_000)).toBe(1);
      expect(store.claim(10_000)).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test("scheduled queries deduplicate, ingest outside-subscription results and leave failures isolated", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([interest()]);
      const provider: SearchProvider = {
        name: "fixture",
        version: "1",
        async search({ query }) {
          if (query.includes("fail")) throw new Error("fixture failure");
          return {
            results: [
              {
                url: "https://example.test/new",
                title: "New robotics research",
                snippet: "A discovery",
              },
              {
                url: "https://example.test/ads",
                title: "Robotics advertising",
                snippet: "An ad",
              },
            ],
            truncated: false,
          };
        },
      };
      const config = {
        limits: {
          maxQueriesPerDay: 10,
          maxQueriesPerRun: 1,
          maxResultsPerDay: 100,
          maxResultsPerRun: 10,
          maxCostMicrosPerDay: 100,
          maxCostMicrosPerRun: 10,
          reservedCostMicrosPerQuery: 1,
        },
        intervalMs: 86_400_000,
        adjacentPercent: 20,
      };
      expect(
        await runScheduledDiscovery(
          store,
          config,
          10_000,
          provider,
          () => 10_000,
        ),
      ).toBe(1);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM discovery_results WHERE origin='discovered'",
          )
          .get()!.n,
      ).toBe(1);
      expect(
        store.sqlite
          .query<{ micros: number; results: number }, []>(
            "SELECT reserved_cost_micros AS micros,reserved_results AS results FROM discovery_pages",
          )
          .get(),
      ).toEqual({ micros: 1, results: 10 });
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM discovery_results",
          )
          .get()!.n,
      ).toBe(1);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM processing_jobs WHERE stage='extract'",
          )
          .get()!.n,
      ).toBeGreaterThan(0);
      const processing = new ProcessingWorker(store, {
        extract: async () => ({
          status: "extracted",
          result: JSON.stringify({
            status: "extracted",
            text: "A robotics research result describes a useful new actuator.",
          }),
        }),
        score: scoringHandler(store),
      });
      expect(await processing.drain("extract")).toBe(1);
      expect(await processing.drain("score")).toBe(1);
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) AS n FROM item_scores")
          .get()!.n,
      ).toBe(1);
      expect(
        await runScheduledDiscovery(
          store,
          config,
          10_001,
          provider,
          () => 10_001,
        ),
      ).toBe(0);
    } finally {
      store.close();
    }
  });
});
