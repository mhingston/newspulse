import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDiscoveryRestoreElapsed,
  markRestoredDiscovery,
} from "../src/discovery-restore-guard";
import { Store } from "../src/db/store";
import { createScheduledDiscoveryTick } from "../src/scheduled-discovery";

const dirs: string[] = [];
function path() {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-discovery-restore-"));
  dirs.push(dir);
  return join(dir, "db.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe("discovery restore budget guard", () => {
  test("blocks through the restore UTC date, including after clock rollback", () => {
    const db = path();
    const start = Date.parse("2026-11-10T23:59:59.000Z");
    assertDiscoveryRestoreElapsed(db, start);
    markRestoredDiscovery(db, start);
    expect(() => assertDiscoveryRestoreElapsed(db, start)).toThrow(
      "next UTC day",
    );
    expect(() => assertDiscoveryRestoreElapsed(db, start + 1000)).not.toThrow();
    expect(() => assertDiscoveryRestoreElapsed(db, start - 1000)).toThrow(
      "next UTC day",
    );
    expect(() => markRestoredDiscovery(db, start)).toThrow();
  });
  test("restore guard blocks the discovery tick without blocking service startup", async () => {
    const db = path();
    const store = new Store(db);
    try {
      const now = Date.parse("2026-11-10T12:00:00.000Z");
      markRestoredDiscovery(db, now);
      const tick = createScheduledDiscoveryTick(db, store, {
        limits: {
          maxQueriesPerDay: 10,
          maxQueriesPerRun: 1,
          maxResultsPerDay: 250,
          maxResultsPerRun: 25,
          maxCostMicrosPerDay: 100,
          maxCostMicrosPerRun: 10,
          reservedCostMicrosPerQuery: 1,
        },
        intervalMs: 86_400_000,
        adjacentPercent: 20,
      });
      expect(store.sources()).toEqual([]);
      await expect(tick()).rejects.toThrow("next UTC day");
      expect(store.sources()).toEqual([]);
    } finally {
      store.close();
    }
  });
  test("fails closed for corrupt markers and symlinks", () => {
    const db = path();
    writeFileSync(`${db}.discovery-restore-pending`, "{}");
    expect(() => assertDiscoveryRestoreElapsed(db)).toThrow(
      "Invalid discovery restore guard",
    );
    const other = path();
    symlinkSync(
      `${db}.discovery-restore-pending`,
      `${other}.discovery-restore-pending`,
    );
    expect(() => assertDiscoveryRestoreElapsed(other)).toThrow(
      "Unable to inspect",
    );
    expect(() => markRestoredDiscovery(other)).toThrow();
    expect(() => assertDiscoveryRestoreElapsed(":memory:")).toThrow(
      "file database",
    );
  });
});
