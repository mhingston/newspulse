import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { DiscoveryStore } from "../src/db/discovery-store";
import {
  confirmInterruptedDiscoveryRun,
  previewInterruptedDiscoveryRun,
} from "../src/discovery-reconcile";

test("reconciles a run interrupted after a completed page without claiming completion", () => {
  const store = new Store(":memory:");
  try {
    const repo = new DiscoveryStore(store.sqlite);
    repo.createRun({
      id: "run",
      query: "test",
      provider: "fake",
      providerVersion: "1",
      now: 1000,
    });
    repo.reservePage({
      id: "page",
      runId: "run",
      now: 1000,
      reservedResults: 2,
      reservedCostMicros: 3,
      limits: {
        dailyQueries: 2,
        dailyResults: 10,
        dailyCostMicros: 10,
        runQueries: 2,
        runResults: 10,
        runCostMicros: 10,
      },
    });
    expect(() =>
      previewInterruptedDiscoveryRun(store.sqlite, "run", 2000),
    ).toThrow("reserved pages");
    repo.completePage(
      { id: "page", now: 1500, nextCursor: "next", results: [] },
      () => [],
    );
    const preview = previewInterruptedDiscoveryRun(store.sqlite, "run", 2000);
    expect(preview.pages[0]?.next_cursor).toBe("next");
    expect(() =>
      confirmInterruptedDiscoveryRun(
        store.sqlite,
        "run",
        2000,
        preview.confirmation.hash,
        302001,
      ),
    ).toThrow("expired");
    store.sqlite
      .query("UPDATE discovery_pages SET next_cursor='changed' WHERE id='page'")
      .run();
    expect(() =>
      confirmInterruptedDiscoveryRun(
        store.sqlite,
        "run",
        2000,
        preview.confirmation.hash,
        3000,
      ),
    ).toThrow("does not match");
    store.sqlite
      .query("UPDATE discovery_pages SET next_cursor='next' WHERE id='page'")
      .run();
    confirmInterruptedDiscoveryRun(
      store.sqlite,
      "run",
      2000,
      preview.confirmation.hash,
      3000,
    );
    expect(
      store.sqlite
        .query("SELECT status,last_error FROM discovery_runs WHERE id='run'")
        .get(),
    ).toEqual({ status: "failed", last_error: "interrupted" });
    expect(
      store.sqlite
        .query(
          "SELECT status,reserved_cost_micros FROM discovery_pages WHERE id='page'",
        )
        .get(),
    ).toEqual({ status: "completed", reserved_cost_micros: 3 });
    expect(() =>
      confirmInterruptedDiscoveryRun(
        store.sqlite,
        "run",
        2000,
        preview.confirmation.hash,
        3000,
      ),
    ).toThrow();
  } finally {
    store.close();
  }
});
