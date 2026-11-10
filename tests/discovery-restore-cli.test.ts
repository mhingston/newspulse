import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";

test("CLI restore creates the discovery guard and prevents network dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-restore-cli-"));
  const original = join(dir, "original.sqlite");
  const backup = join(dir, "backup.sqlite");
  const restored = join(dir, "restored.sqlite");
  try {
    const store = new Store(original);
    store.backup(backup);
    store.close();
    const env = { ...process.env, DB_PATH: restored };
    const restore = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "restore", backup],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(restore.exitCode).toBe(0);
    const marker = `${restored}.discovery-restore-pending`;
    expect(existsSync(marker)).toBe(true);
    const saved = JSON.parse(readFileSync(marker, "utf8")) as {
      version: number;
      restoredAt: number;
    };
    expect(saved.version).toBe(1);
    expect(saved.restoredAt).toBeGreaterThan(0);
    // Use a future restore time to keep this test deterministic across UTC midnight.
    writeFileSync(
      marker,
      JSON.stringify({ version: 1, restoredAt: Date.now() + 86400000 }),
    );
    const discover = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "discover", "clean energy"],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(discover.exitCode).not.toBe(0);
    expect(discover.stderr.toString()).toContain(
      "blocked until the next UTC day",
    );
    const restoredStore = new Store(restored);
    expect(
      restoredStore.sqlite
        .query("SELECT count(*) AS n FROM discovery_pages")
        .get(),
    ).toEqual({ n: 0 });
    restoredStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
