import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { InboundStore } from "../src/db/inbound";
import type { InboundEmailMetadata } from "../src/inbound";
const metadata = (providerId: string): InboundEmailMetadata => ({
  providerId,
  receivedAt: 1,
  from: "sender@example.test",
  to: ["inbox@example.test"],
  receivedFor: [],
  subject: "test",
  messageId: null,
});

test("event and reconciliation deduplicate messages atomically", () => {
  const db = new Store(":memory:");
  const inbox = new InboundStore(db.sqlite);
  try {
    expect(
      inbox.recordEvent(
        "resend",
        { eventId: "e1", metadata: metadata("m1") },
        10,
      ),
    ).toEqual({ eventInserted: true, messageInserted: true });
    expect(
      inbox.recordEvent(
        "resend",
        { eventId: "e1", metadata: metadata("m1") },
        11,
      ),
    ).toEqual({ eventInserted: false, messageInserted: false });
    expect(() =>
      inbox.recordEvent(
        "resend",
        { eventId: "e1", metadata: metadata("m2") },
        12,
      ),
    ).toThrow("identity conflict");
    const page = inbox.claimReconciliation("resend", 12)!;
    expect(
      inbox.commitPage(
        page,
        [metadata("m1"), metadata("m2")],
        { after: "m2" },
        13,
        13,
      ),
    ).toBe(true);
    expect(
      inbox.recordEvent(
        "resend",
        { eventId: "e2", metadata: metadata("m2") },
        14,
      ),
    ).toEqual({ eventInserted: true, messageInserted: false });
    expect(
      db.sqlite.query("SELECT count(*) AS n FROM inbound_messages").get(),
    ).toEqual({ n: 2 });
    expect(
      db.sqlite.query("SELECT count(*) AS n FROM inbound_events").get(),
    ).toEqual({ n: 2 });
  } finally {
    db.close();
  }
});

test("failed event persistence rolls back its message and job", () => {
  const db = new Store(":memory:");
  const inbox = new InboundStore(db.sqlite);
  try {
    db.sqlite.exec(
      "CREATE TRIGGER fail_inbound BEFORE INSERT ON inbound_events BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    expect(() =>
      inbox.recordEvent(
        "resend",
        { eventId: "e1", metadata: metadata("m1") },
        10,
      ),
    ).toThrow();
    expect(
      db.sqlite.query("SELECT count(*) AS n FROM inbound_messages").get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test("expired or forged claims cannot commit; transient retries survive eight failures", () => {
  const db = new Store(":memory:");
  const inbox = new InboundStore(db.sqlite);
  try {
    inbox.recordEvent("resend", { eventId: "e1", metadata: metadata("m1") }, 0);
    const stale = inbox.claimMessage(0, 5)!;
    const live = inbox.claimMessage(5, 5)!;
    const body = { metadata: metadata("m1"), text: "body", html: null };
    expect(inbox.completeMessage(stale, body, 6)).toBe(false);
    expect(() =>
      inbox.completeMessage({ ...live, providerId: "other" }, body, 6),
    ).toThrow();
    expect(inbox.failMessage(live, "transient", 1, false, 6)).toBe(true);
    let now = 7;
    for (let n = 0; n < 9; n++) {
      const job = inbox.claimMessage(now, 5)!;
      expect(job).not.toBeNull();
      expect(inbox.failMessage(job, "transient", 1, false, now)).toBe(true);
      now++;
    }
    const final = inbox.claimMessage(now, 5)!;
    expect(inbox.completeMessage(final, body, now)).toBe(true);
    expect(
      db.sqlite
        .query<{ status: string }, []>("SELECT status FROM inbound_messages")
        .get()!.status,
    ).toBe("complete");
  } finally {
    db.close();
  }
});

test("reconciliation cursor commits with page, fences stale leases and survives restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "inbound-store-")),
    path = join(dir, "db.sqlite");
  let db: Store | undefined;
  try {
    db = new Store(path);
    let inbox = new InboundStore(db.sqlite);
    const stale = inbox.claimReconciliation("resend", 10, 5)!;
    const current = inbox.claimReconciliation("resend", 15, 5)!;
    expect(
      inbox.commitPage(stale, [metadata("lost")], { after: "bad" }, 16, 16),
    ).toBe(false);
    expect(() =>
      inbox.commitPage(
        current,
        [metadata("rolled-back"), metadata("")],
        { after: "bad" },
        16,
        16,
      ),
    ).toThrow();
    expect(
      db.sqlite.query("SELECT count(*) AS n FROM inbound_messages").get(),
    ).toEqual({ n: 0 });
    expect(
      inbox.commitPage(current, [metadata("safe")], { after: "safe" }, 17, 16),
    ).toBe(true);
    db.close();
    db = new Store(path);
    inbox = new InboundStore(db.sqlite);
    const next = inbox.claimReconciliation("resend", 17)!;
    expect(next.state).toEqual({ after: "safe" });
    expect(
      db.sqlite.query("SELECT count(*) AS n FROM inbound_messages").get(),
    ).toEqual({ n: 1 });
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("populated prior version migrates and inbox survives backup restoration", () => {
  const dir = mkdtempSync(join(tmpdir(), "inbound-migrate-")),
    path = join(dir, "old.sqlite"),
    backup = join(dir, "backup.sqlite"),
    prior = join(dir, "migrations");
  mkdirSync(join(prior, "meta"), { recursive: true });
  const root = fileURLToPath(new URL("../drizzle/", import.meta.url));
  for (const name of readdirSync(root))
    if (name.endsWith(".sql"))
      copyFileSync(join(root, name), join(prior, name));
  const journal = JSON.parse(
    readFileSync(join(root, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx < 35);
  writeFileSync(join(prior, "meta/_journal.json"), JSON.stringify(journal));
  const old = new Database(path);
  migrate(drizzle(old), { migrationsFolder: prior });
  old.exec(
    "INSERT INTO items(id,identity,title,ingested_at) VALUES('prior','prior','Prior',1); INSERT INTO content(item_id,text) VALUES('prior','searchable original')",
  );
  old.close();
  let store: Store | undefined, restored: Store | undefined;
  try {
    store = new Store(path);
    expect(store.search("searchable")[0]!.id).toBe("prior");
    new InboundStore(store.sqlite).recordEvent(
      "resend",
      { eventId: "event", metadata: metadata("message") },
      2,
    );
    store.backup(backup);
    restored = new Store(backup);
    expect(restored.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(restored.search("searchable")[0]!.id).toBe("prior");
    expect(new InboundStore(restored.sqlite).claimMessage(3)?.providerId).toBe(
      "message",
    );
  } finally {
    restored?.close();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
