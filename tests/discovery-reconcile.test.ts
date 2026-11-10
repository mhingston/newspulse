import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/db/store";
import { DiscoveryStore } from "../src/db/discovery-store";
import { acquireDiscoveryLock } from "../src/discovery-lock";
import {
  previewDiscoveryReconciliation,
  confirmDiscoveryReconciliation,
} from "../src/discovery-reconcile";

test("reconciliation binds page state and retains all reservations", () => {
  const store = new Store(":memory:");
  try {
    const repo = new DiscoveryStore(store.sqlite);
    repo.createRun({
      id: "run",
      query: "robotics",
      provider: "gdelt",
      providerVersion: "v1",
      now: 1000,
    });
    expect(
      repo.reservePage({
        id: "page",
        runId: "run",
        now: 1000,
        reservedResults: 4,
        reservedCostMicros: 3,
        limits: {
          dailyQueries: 2,
          dailyResults: 20,
          dailyCostMicros: 20,
          runQueries: 2,
          runResults: 20,
          runCostMicros: 20,
        },
      }),
    ).toBe(4);
    const preview = previewDiscoveryReconciliation(store.sqlite, "page", 2000);
    expect(() =>
      confirmDiscoveryReconciliation(
        store.sqlite,
        "page",
        2000,
        "0".repeat(64),
        3000,
      ),
    ).toThrow();
    expect(() =>
      confirmDiscoveryReconciliation(
        store.sqlite,
        "page",
        2000,
        preview.confirmation.hash,
        302001,
      ),
    ).toThrow();
    store.sqlite
      .query("UPDATE discovery_pages SET reserved_results=5 WHERE id='page'")
      .run();
    expect(() =>
      confirmDiscoveryReconciliation(
        store.sqlite,
        "page",
        2000,
        preview.confirmation.hash,
        3000,
      ),
    ).toThrow();
    store.sqlite
      .query("UPDATE discovery_pages SET reserved_results=4 WHERE id='page'")
      .run();
    confirmDiscoveryReconciliation(
      store.sqlite,
      "page",
      2000,
      preview.confirmation.hash,
      3000,
    );
    expect(
      store.sqlite
        .query(
          "SELECT status,reserved_results,reserved_cost_micros,last_error,finished_at FROM discovery_pages",
        )
        .get(),
    ).toEqual({
      status: "failed",
      reserved_results: 4,
      reserved_cost_micros: 3,
      last_error: "outcome_unknown",
      finished_at: 3000,
    });
    expect(
      store.sqlite.query("SELECT status,last_error FROM discovery_runs").get(),
    ).toEqual({ status: "failed", last_error: "outcome_unknown" });
    expect(() =>
      confirmDiscoveryReconciliation(
        store.sqlite,
        "page",
        2000,
        preview.confirmation.hash,
        3000,
      ),
    ).toThrow();
  } finally {
    store.close();
  }
});

test("discovery lock excludes another operator and is released", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-lock-"));
  const path = join(dir, "db.sqlite");
  try {
    const lock = acquireDiscoveryLock(path);
    expect(() => acquireDiscoveryLock(path)).toThrow();
    lock.close();
    acquireDiscoveryLock(path).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
