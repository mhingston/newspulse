import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { DiscoveryPlannerStore } from "../src/db/discovery-planner-store";
import {
  planDiscoveryQueries,
  allocateQuerySlots,
} from "../src/discovery-planner";
import { ProfileStore, type Interest } from "../src/profiles";
import { runScheduledDiscovery } from "../src/scheduled-discovery";
import type { SearchProvider } from "../src/search-provider";
import { ProcessingWorker } from "../src/worker";
import { scoringHandler } from "../src/scoring-service";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  });

  test("persisted feedback prioritizes useful queries, while missing feedback is neutral", () => {
    const store = new Store(":memory:");
    try {
      const planner = new DiscoveryPlannerStore(store.sqlite);
      const q = planDiscoveryQueries([
        interest({ queries: ["robotics research", "robotics lab"] }),
      ]);
      planner.sync(q, 1000, 86_400_000);
      planner.feedbackForQuery("robotics lab", true, 1001);
      const due = planner.due(1002, 10);
      expect(due[0]?.query).toBe("robotics lab");
      expect(
        due.find((item) => item.query === "robotics research")?.utility,
      ).toBe(0);
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
