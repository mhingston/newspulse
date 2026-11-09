import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { acquireDeliveryLock } from "../src/delivery-lock";
import {
  assertDeliveryRestoreAcknowledged,
  previewDeliveryRestoreAcknowledgment,
  confirmDeliveryRestoreAcknowledgment,
  markRestoredDelivery,
} from "../src/delivery-restore-guard";

test("restoring a pre-outbox backup blocks delivery until stopped operator confirms a bound audit", () => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-restore-"));
  const original = join(dir, "original.sqlite"),
    backup = join(dir, "backup.sqlite"),
    restored = join(dir, "restored.sqlite");
  const store = new Store(original);
  try {
    store.backup(backup);
    store.close();
    const result = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "restore", backup],
      {
        env: { ...process.env, DB_PATH: restored },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(() => assertDeliveryRestoreAcknowledged(restored)).toThrow(
      "requires delivery recovery acknowledgment",
    );
    const restoredStore = new Store(restored);
    expect(
      restoredStore.sqlite.query("SELECT count(*) n FROM deliveries").get(),
    ).toEqual({ n: 0 });
    restoredStore.close();
    const lock = acquireDeliveryLock(restored);
    try {
      const preview = previewDeliveryRestoreAcknowledgment(restored, 1000);
      expect(preview.warning).toContain("no outbox row");
      expect(() =>
        confirmDeliveryRestoreAcknowledgment(
          restored,
          1000,
          preview.confirmation.hash,
          301001,
        ),
      ).toThrow();
      expect(() =>
        confirmDeliveryRestoreAcknowledgment(
          restored,
          1000,
          "0".repeat(64),
          1001,
        ),
      ).toThrow();
      expect(() => assertDeliveryRestoreAcknowledged(restored)).toThrow();
      confirmDeliveryRestoreAcknowledgment(
        restored,
        1000,
        preview.confirmation.hash,
        1001,
      );
      expect(() => assertDeliveryRestoreAcknowledged(restored)).not.toThrow();
    } finally {
      lock.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard exists before copy and altered marker invalidates preview", () => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-restore-crash-")),
    db = join(dir, "db.sqlite");
  try {
    markRestoredDelivery(db, 1);
    expect(() => assertDeliveryRestoreAcknowledged(db)).toThrow();
    const preview = previewDeliveryRestoreAcknowledgment(db, 2);
    writeFileSync(`${db}.delivery-restore-pending`, "changed");
    expect(() =>
      confirmDeliveryRestoreAcknowledgment(db, 2, preview.confirmation.hash, 3),
    ).toThrow();
    expect(() => assertDeliveryRestoreAcknowledged(db)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
