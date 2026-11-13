import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { InboundStore } from "../src/db/inbound";
import type { InboundEmailMetadata, ReceivedEmail } from "../src/inbound";
import { DAY_MS, PURGED_INBOUND_BODY, retentionPolicy } from "../src/retention";

const DAY0 = Date.UTC(2026, 10, 1);

const metadata = (providerId: string): InboundEmailMetadata => ({
  providerId,
  receivedAt: DAY0,
  from: "sender@example.test",
  to: ["inbox@example.test"],
  receivedFor: [],
  subject: "subject",
  messageId: null,
});

const email = (providerId: string): ReceivedEmail =>
  ({
    metadata: metadata(providerId),
    text: `body of ${providerId}`,
    html: null,
    links: [],
    attachments: [],
  }) as unknown as ReceivedEmail;

function completedMessage(
  inbox: InboundStore,
  providerId: string,
  now: number,
) {
  inbox.recordEvent(
    "resend",
    { eventId: `evt-${providerId}`, metadata: metadata(providerId) },
    now,
  );
  const job = inbox.claimMessage(now, 60_000)!;
  expect(inbox.completeMessage(job, email(providerId), now)).toBe(true);
  return job;
}

function bodyOf(db: Store, providerId: string) {
  return db.sqlite
    .query<{ body: string | null }, [string]>(
      "SELECT body FROM inbound_messages WHERE provider_id=?",
    )
    .get(providerId)!.body;
}

function linkItem(db: Store, providerId: string, itemId: string) {
  db.sqlite
    .query("UPDATE inbound_messages SET item_id=? WHERE provider_id=?")
    .run(itemId, providerId);
}

function insertItem(db: Store, id: string) {
  db.sqlite
    .query(
      "INSERT INTO items(id,identity,url,title,ingested_at,status) VALUES(?,?,NULL,?,?,'ingested')",
    )
    .run(id, `identity:${id}`, id, DAY0);
}

test("inbound body retention is off by default and invalid windows fail closed", () => {
  expect(retentionPolicy({}).inboundBodyDays).toBeUndefined();
  expect(() => retentionPolicy({ RETENTION_INBOUND_BODY_DAYS: "0" })).toThrow();
});

test("only indexed, complete, unleased bodies expire; the body tombstone is idempotent", () => {
  const db = new Store(":memory:");
  const inbox = new InboundStore(db.sqlite);
  try {
    insertItem(db, "item-indexed");
    completedMessage(inbox, "indexed", DAY0);
    linkItem(db, "indexed", "item-indexed");

    // Complete but never indexed: the indexing step still reads this body.
    completedMessage(inbox, "unindexed", DAY0);

    // Indexed but still leased for a new retrieval attempt: must be protected.
    completedMessage(inbox, "leased", DAY0);
    insertItem(db, "item-leased");
    linkItem(db, "leased", "item-leased");
    db.sqlite
      .query(
        "UPDATE inbound_messages SET lease_until=?,lease_token='x',status='complete' WHERE provider_id='leased'",
      )
      .run(DAY0 + 10 * DAY_MS);

    const policy = retentionPolicy({ RETENTION_INBOUND_BODY_DAYS: "7" });
    const now = DAY0 + 8 * DAY_MS;

    const dry = db.retention(policy, { dryRun: true, now });
    expect(dry.inboundBodies).toEqual({ eligible: 1, purged: 0 });
    expect(bodyOf(db, "indexed")).toContain("body of indexed");

    const applied = db.retention(policy, { dryRun: false, now });
    expect(applied.inboundBodies).toEqual({ eligible: 1, purged: 1 });
    expect(bodyOf(db, "indexed")).toBe(PURGED_INBOUND_BODY);
    expect(bodyOf(db, "unindexed")).toContain("body of unindexed");
    expect(bodyOf(db, "leased")).toContain("body of leased");

    // Repeat cleanup selects nothing and changes nothing.
    const again = db.retention(policy, { dryRun: false, now: now + DAY_MS });
    expect(again.inboundBodies).toEqual({ eligible: 0, purged: 0 });
    expect(bodyOf(db, "indexed")).toBe(PURGED_INBOUND_BODY);
  } finally {
    db.close();
  }
});

test("a purged body writes one audit row per item and leaves the search index consistent", () => {
  const db = new Store(":memory:");
  const inbox = new InboundStore(db.sqlite);
  try {
    insertItem(db, "item-audit");
    completedMessage(inbox, "audit", DAY0);
    linkItem(db, "audit", "item-audit");
    const policy = retentionPolicy({ RETENTION_INBOUND_BODY_DAYS: "1" });
    const now = DAY0 + 2 * DAY_MS;
    const applied = db.retention(policy, { dryRun: false, now });
    expect(applied.inboundBodies.purged).toBe(1);
    const audits = db.sqlite
      .query<{ item_id: string; class: string; generation: number }, []>(
        "SELECT item_id,class,generation FROM retention_purges WHERE class='inbound_body'",
      )
      .all();
    expect(audits).toEqual([
      { item_id: "item-audit", class: "inbound_body", generation: 0 },
    ]);
    const fts = db.sqlite
      .query<{ text: string }, []>(
        "SELECT text FROM items_fts JOIN items i ON i.rowid=items_fts.rowid WHERE i.id='item-audit'",
      )
      .get();
    expect(fts?.text ?? "").not.toContain("body of audit");
  } finally {
    db.close();
  }
});

test("dry run reports eligible bodies without changing them or the audit table", () => {
  const db = new Store(":memory:");
  const inbox = new InboundStore(db.sqlite);
  try {
    insertItem(db, "item-dry");
    completedMessage(inbox, "dry", DAY0);
    linkItem(db, "dry", "item-dry");
    const policy = retentionPolicy({ RETENTION_INBOUND_BODY_DAYS: "1" });
    const report = db.retention(policy, {
      dryRun: true,
      now: DAY0 + 2 * DAY_MS,
    });
    expect(report.inboundBodies).toEqual({ eligible: 1, purged: 0 });
    expect(bodyOf(db, "dry")).toContain("body of dry");
    const count = db.sqlite
      .query<{ n: number }, []>(
        "SELECT count(*) n FROM retention_purges WHERE class='inbound_body'",
      )
      .get()!.n;
    expect(count).toBe(0);
  } finally {
    db.close();
  }
});

test("a purged body is never parsed as an email by the indexer", () => {
  const db = new Store(":memory:");
  const inbox = new InboundStore(db.sqlite);
  try {
    insertItem(db, "item-tomb");
    completedMessage(inbox, "tomb", DAY0);
    linkItem(db, "tomb", "item-tomb");
    db.retention(retentionPolicy({ RETENTION_INBOUND_BODY_DAYS: "1" }), {
      dryRun: false,
      now: DAY0 + 2 * DAY_MS,
    });
    db.sqlite.query("UPDATE inbound_messages SET item_id=NULL").run();
    const indexed = db.indexNextNewsletter(
      () => {
        throw new Error("tombstone must not reach the normalizer");
      },
      DAY0 + 3 * DAY_MS,
    );
    expect(indexed).toBe(false);
    const row = db.sqlite
      .query<{ index_diagnostics: string | null }, []>(
        "SELECT index_diagnostics FROM inbound_messages WHERE provider_id='tomb'",
      )
      .get()!;
    expect(row.index_diagnostics).toBeNull();
  } finally {
    db.close();
  }
});

test("an inbound message keeps its identity and item linkage after its body expires", () => {
  const db = new Store(":memory:");
  const inbox = new InboundStore(db.sqlite);
  try {
    insertItem(db, "item-kept");
    completedMessage(inbox, "kept", DAY0);
    linkItem(db, "kept", "item-kept");
    db.retention(retentionPolicy({ RETENTION_INBOUND_BODY_DAYS: "1" }), {
      dryRun: false,
      now: DAY0 + 2 * DAY_MS,
    });
    const row = db.sqlite
      .query<{ provider_id: string; item_id: string; status: string }, []>(
        "SELECT provider_id,item_id,status FROM inbound_messages WHERE provider_id='kept'",
      )
      .get()!;
    expect(row).toEqual({
      provider_id: "kept",
      item_id: "item-kept",
      status: "complete",
    });
  } finally {
    db.close();
  }
});
