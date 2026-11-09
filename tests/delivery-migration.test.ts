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
    "INSERT INTO items(id,identity,title,ingested_at) VALUES('prior','identity','Prior',1); INSERT INTO content(item_id,text) VALUES('prior','searchable provenance')",
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
    expect(restoredDeliveries.claim(now + 60_001)?.id).toBe(claim.id);
  } finally {
    store?.close();
    restored?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
