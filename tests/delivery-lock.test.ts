import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDeliveryLock } from "../src/delivery-lock";
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryStore } from "../src/db/delivery-store";
import {
  confirmDeliveryReconciliation,
  previewDeliveryReconciliation,
} from "../src/delivery-reconcile";

test("exclusive delivery lock excludes other processes and releases on crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-lock-"));
  const db = join(dir, "db.sqlite");
  const script = `import { acquireDeliveryLock } from './src/delivery-lock'; acquireDeliveryLock(process.argv[1]); console.log('ready'); setInterval(() => {}, 1000);`;
  const child = Bun.spawn([process.execPath, "-e", script, db], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "ready",
    );
    expect(() => acquireDeliveryLock(db)).toThrow();
    child.kill("SIGKILL");
    await child.exited;
    acquireDeliveryLock(db).close();
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation confirmation binds action and current state and expires", () => {
  const store = new Store(":memory:");
  try {
    const deliveries = new DeliveryStore(store.sqlite);
    const row = deliveries.prepare(
      "2026-11-09",
      "reader@example.test",
      "sender@example.test",
      () =>
        new DigestStore(store.sqlite).freeze(
          {
            date: "2026-11-09",
            timezone: "UTC",
            subject: "News",
            html: "x",
            text: "x",
            decisionSnapshot: {},
            items: [
              { itemId: "id", groupId: null, scoreId: null, snapshot: {} },
            ],
          },
          1,
        ),
      1000,
    )!;
    const claim = deliveries.claim(1000)!;
    deliveries.beginSend(claim, 1000);
    deliveries.fail(claim, "ambiguous", 1001);
    const action = {
      id: row.id,
      resolution: "not_sent" as const,
      providerId: null,
    };
    const preview = previewDeliveryReconciliation(store.sqlite, action, 2000);
    expect(() =>
      confirmDeliveryReconciliation(
        store.sqlite,
        { ...action, resolution: "accepted", providerId: "id" },
        2000,
        preview.confirmation.hash,
        2001,
      ),
    ).toThrow();
    expect(() =>
      confirmDeliveryReconciliation(
        store.sqlite,
        action,
        2000,
        preview.confirmation.hash,
        302001,
      ),
    ).toThrow();
    store.sqlite
      .query("UPDATE deliveries SET last_error='changed' WHERE id=?")
      .run(row.id);
    expect(() =>
      confirmDeliveryReconciliation(
        store.sqlite,
        action,
        2000,
        preview.confirmation.hash,
        2001,
      ),
    ).toThrow();
    const fresh = previewDeliveryReconciliation(store.sqlite, action, 2001);
    confirmDeliveryReconciliation(
      store.sqlite,
      action,
      2001,
      fresh.confirmation.hash,
      2002,
    );
    expect(deliveries.get(row.id)?.status).toBe("pending");
  } finally {
    store.close();
  }
});

test("preview recovers expired attempted sends while leaving active leases alone", () => {
  const store = new Store(":memory:");
  try {
    const deliveries = new DeliveryStore(store.sqlite);
    const row = deliveries.prepare(
      "2026-11-09",
      "reader@example.test",
      "sender@example.test",
      () =>
        new DigestStore(store.sqlite).freeze(
          {
            date: "2026-11-09",
            timezone: "UTC",
            subject: "News",
            html: "x",
            text: "x",
            decisionSnapshot: {},
            items: [
              { itemId: "id", groupId: null, scoreId: null, snapshot: {} },
            ],
          },
          1,
        ),
      1000,
    )!;
    const claim = deliveries.claim(1000)!;
    deliveries.beginSend(claim, 1000);
    const action = {
      id: row.id,
      resolution: "not_sent" as const,
      providerId: null,
    };
    expect(() =>
      previewDeliveryReconciliation(store.sqlite, action, 60_999),
    ).toThrow();
    expect(deliveries.get(row.id)?.status).toBe("sending");
    const preview = previewDeliveryReconciliation(store.sqlite, action, 61_000);
    expect(preview.delivery.status).toBe("ambiguous");
    confirmDeliveryReconciliation(
      store.sqlite,
      action,
      61_000,
      preview.confirmation.hash,
      61_001,
    );
    expect(deliveries.get(row.id)?.status).toBe("pending");
  } finally {
    store.close();
  }
});
