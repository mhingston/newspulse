import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { discoveryLimitsOrUndefined } from "../src/discovery-config";

const DAY = 86_400_000;
const limits = {
  maxQueriesPerDay: 10,
  maxResultsPerDay: 100,
  maxCostMicrosPerDay: 1000,
};

function seedRun(store: Store) {
  store.sqlite
    .query(
      `INSERT INTO discovery_runs(id,query,provider,provider_version,subscription_snapshot,status,started_at,schedule_key)
       VALUES('run','q','fixture','1','{}','completed',0,'k')`,
    )
    .run();
}

function seedPage(
  store: Store,
  id: string,
  budgetDay: number,
  status: string,
  finishedAt: number | null,
  results: number,
  micros: number,
) {
  store.sqlite
    .query(
      `INSERT INTO discovery_pages(id,run_id,budget_day,reserved_results,reserved_cost_micros,status,started_at,finished_at)
       VALUES(?,'run',?,?,?,?,0,?)`,
    )
    .run(id, budgetDay, results, micros, status, finishedAt);
}

describe("status budgets", () => {
  test("reports discovery usage in the same rolling-day window the reserver uses", () => {
    const store = new Store(":memory:");
    try {
      seedRun(store);
      const now = 10 * DAY + 1000;
      const day = 10;
      // Counted: today's budget day, an open reservation, and a page finished today.
      seedPage(store, "today", day, "complete", null, 5, 100);
      seedPage(store, "open", 0, "reserved", null, 3, 40);
      seedPage(store, "finished", 0, "complete", day * DAY + 5, 2, 10);
      // Not counted: an old, finished page from a prior day.
      seedPage(store, "old", 2, "complete", 2 * DAY, 99, 999);

      const budgets = store.status({ discoveryLimits: limits, now }).budgets;
      expect(budgets.discovery.queries).toBe(3);
      expect(budgets.discovery.results).toBe(5 + 3 + 2);
      expect(budgets.discovery.cost_micros).toBe(100 + 40 + 10);
      expect(budgets.discovery.limits).toEqual(limits);
      expect(budgets.discovery.day).toBe(day);
    } finally {
      store.close();
    }
  });

  test("discovery limits are null when the configuration is unavailable", () => {
    const store = new Store(":memory:");
    try {
      expect(store.status().budgets.discovery.limits).toBeNull();
    } finally {
      store.close();
    }
  });

  test("analysis totals and envelope breach come from the lifetime ledger", () => {
    const store = new Store(":memory:");
    try {
      store.sqlite
        .query(
          "INSERT INTO analysis_reservations(key,tokens,micros,status) VALUES('a',100,20,'settled'),('b',50,5,'reserved')",
        )
        .run();
      store.sqlite
        .query("INSERT INTO analysis_control(id,envelope_breach) VALUES(1,1)")
        .run();
      const analysis = store.status().budgets.analysis;
      expect(analysis.tokens).toBe(150);
      expect(analysis.cost_micros).toBe(25);
      expect(analysis.reservations).toBe(2);
      expect(analysis.envelope_breach).toBe(true);
    } finally {
      store.close();
    }
  });

  test("a malformed discovery configuration does not make status unreadable", () => {
    expect(
      discoveryLimitsOrUndefined({ DISCOVERY_DAILY_QUERIES: "0" }),
    ).toBeUndefined();
  });
});
