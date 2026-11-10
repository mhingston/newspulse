import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
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
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryStore } from "../src/db/delivery-store";
import { runPublicationSchedule } from "../src/publication-schedule";

test("populated pre-delivery database migrates and delivery state survives backup and restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-delivery-migration-"));
  const prior = join(dir, "prior"),
    path = join(dir, "prior.sqlite"),
    backup = join(dir, "backup.sqlite");
  mkdirSync(join(prior, "meta"), { recursive: true });
  const root = fileURLToPath(new URL("../drizzle/", import.meta.url));
  for (const name of readdirSync(root))
    if (name.endsWith(".sql"))
      copyFileSync(join(root, name), join(prior, name));
  const journal = JSON.parse(
    readFileSync(join(root, "meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx < 37,
  );
  writeFileSync(join(prior, "meta/_journal.json"), JSON.stringify(journal));
  const db = new Database(path);
  migrate(drizzle(db), { migrationsFolder: prior });
  db.exec(
    "INSERT INTO sources(id,url,title) VALUES('prior-source','https://example.com/feed','Prior feed'); INSERT INTO items(id,identity,title,ingested_at) VALUES('prior','identity','Prior',1); INSERT INTO content(item_id,text) VALUES('prior','searchable provenance'); INSERT INTO content_versions(item_id,source_id,native_id,url,title,text,observed_at) VALUES('prior','prior-source','native','https://example.com/prior','Prior','searchable provenance',1)",
  );
  const frozen = new DigestStore(db).freeze(
    {
      date: "2026-11-09",
      timezone: "Europe/London",
      subject: "Discovery",
      html: "<p>prior</p>",
      text: "prior",
      decisionSnapshot: { citations: ["https://example.com/prior"] },
      items: [
        {
          itemId: "prior",
          groupId: null,
          scoreId: null,
          snapshot: { title: "Prior" },
        },
      ],
    },
    1,
  );
  db.close();
  let store: Store | undefined, restored: Store | undefined;
  try {
    store = new Store(path);
    expect(store.search("searchable")[0]!.id).toBe("prior");
    expect(
      store.sqlite
        .query(
          "SELECT count(*) AS count FROM digest_activity_events WHERE item_id='prior'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      store.sqlite
        .query("SELECT evidence_from FROM digest_history_state WHERE id=1")
        .get(),
    ).toMatchObject({ evidence_from: expect.any(Number) });
    expect(store.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    store.sqlite.exec(
      "INSERT INTO items_fts(items_fts) VALUES('integrity-check')",
    );
    expect(new DigestStore(store.sqlite).get("2026-11-09")).toEqual(frozen);
    const deliveries = new DeliveryStore(store.sqlite);
    const now = Date.parse("2026-11-09T06:00:00Z");
    expect(
      runPublicationSchedule(
        store.sqlite,
        { timezone: "Europe/London", hour: 6, minute: 0 },
        (date, at) => {
          deliveries.prepare(
            date,
            "reader@example.com",
            "sender@example.com",
            () => frozen,
            at,
          );
          return "prepared";
        },
        now,
      ),
    ).toEqual([{ date: "2026-11-09", status: "prepared" }]);
    const claim = deliveries.claim(now)!;
    expect(deliveries.beginSend(claim, now)).toBe(true);
    store.backup(backup);
    store.close();
    store = undefined;
    restored = new Store(backup);
    expect(restored.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(restored.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(restored.search("searchable")[0]!.id).toBe("prior");
    expect(new DigestStore(restored.sqlite).get("2026-11-09")).toEqual(frozen);
    const restoredDeliveries = new DeliveryStore(restored.sqlite);
    expect(restoredDeliveries.get(claim.id)).toMatchObject({
      status: "sending",
      idempotency_key: claim.idempotency_key,
      first_attempt_at: now,
    });
    expect(
      restored.sqlite
        .query("SELECT date,status FROM publication_schedule_history")
        .all(),
    ).toEqual([{ date: "2026-11-09", status: "prepared" }]);
    expect(restoredDeliveries.claim(now + 60_001)).toBeNull();
    expect(restoredDeliveries.get(claim.id)?.status).toBe("ambiguous");
    restoredDeliveries.reconcile(claim.id, "not_sent", null, now + 60_001);
    expect(restoredDeliveries.claim(now + 60_001)?.id).toBe(claim.id);
  } finally {
    store?.close();
    restored?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile a restored pending snapshot after a later confirmed provider acceptance", async () => {
  const { acquireDeliveryLock } = await import("../src/delivery-lock");
  const { previewDeliveryReconciliation, confirmDeliveryReconciliation } =
    await import("../src/delivery-reconcile");
  const dir = mkdtempSync(join(tmpdir(), "newspulse-pending-backup-"));
  const path = join(dir, "live.sqlite");
  const backup = join(dir, "backup.sqlite");
  const now = Date.now();
  let live: Store | undefined = new Store(path);
  let restored: Store | undefined;
  try {
    live.sqlite.exec(
      "INSERT INTO items(id,identity,title,ingested_at) VALUES('item','identity','Title',1)",
    );
    const digest = new DigestStore(live.sqlite).freeze(
      {
        date: "2026-11-09",
        timezone: "Europe/London",
        subject: "Digest",
        html: "<p>Digest</p>",
        text: "Digest",
        decisionSnapshot: {},
        items: [{ itemId: "item", groupId: null, scoreId: null, snapshot: {} }],
      },
      now,
    );
    const deliveries = new DeliveryStore(live.sqlite);
    const pending = deliveries.prepare(
      "2026-11-09",
      "reader@example.com",
      "sender@example.com",
      () => digest,
      now,
    )!;
    live.backup(backup);
    const claim = deliveries.claim(now)!;
    expect(deliveries.beginSend(claim, now)).toBe(true);
    expect(deliveries.sent(claim, "provider-accepted", now + 1)).toBe(true);
    live.close();
    live = undefined;
    const lock = acquireDeliveryLock(backup);
    try {
      restored = new Store(backup);
      const prior = new DeliveryStore(restored.sqlite).get(pending.id)!;
      expect(prior.status).toBe("pending");
      const action = {
        id: pending.id,
        resolution: "accepted" as const,
        providerId: "provider-accepted",
      };
      expect(() =>
        previewDeliveryReconciliation(
          restored!.sqlite,
          { id: pending.id, resolution: "not_sent", providerId: null },
          now + 2,
        ),
      ).toThrow("not eligible");
      const preview = previewDeliveryReconciliation(
        restored.sqlite,
        action,
        now + 2,
      );
      expect(() =>
        confirmDeliveryReconciliation(
          restored!.sqlite,
          { ...action, providerId: "other" },
          preview.confirmation.asOf,
          preview.confirmation.hash,
          now + 3,
        ),
      ).toThrow("does not match");
      confirmDeliveryReconciliation(
        restored.sqlite,
        action,
        preview.confirmation.asOf,
        preview.confirmation.hash,
        now + 3,
      );
      expect(new DeliveryStore(restored.sqlite).get(pending.id)).toMatchObject({
        status: "sent",
        provider_id: "provider-accepted",
        idempotency_key: pending.idempotency_key,
      });
      expect(new DeliveryStore(restored.sqlite).claim(now + 4)).toBeNull();
    } finally {
      restored?.close();
      restored = undefined;
      lock.close();
    }
  } finally {
    live?.close();
    restored?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
