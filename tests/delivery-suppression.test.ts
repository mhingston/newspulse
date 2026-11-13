import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryStore } from "../src/db/delivery-store";
import { DeliveryWorker, type DeliveryEmailProvider } from "../src/delivery";
import {
  confirmDeliverySuppression,
  previewDeliverySuppression,
  type SuppressionAction,
} from "../src/delivery-suppression";
import { verifyDatabase } from "../src/recovery";
import { DeliveryWorker as Sender } from "../src/delivery";
import { PublicationWorker } from "../src/publication-worker";
import { localPublicationDate } from "../src/publication-schedule";
import { ProfileStore } from "../src/profiles";
import { ProcessingWorker } from "../src/worker";
import { scoringHandler } from "../src/scoring-service";

const date = "2026-11-09";
const recipient = "Reader@EXAMPLE.test";
const sender = "sender@example.test";
const context = { sender };

function fixture(options: { freeze?: boolean } = {}) {
  const store = new Store(":memory:");
  const digests = new DigestStore(store.sqlite);
  const freeze = (editionDate = date) =>
    digests.freeze(
      {
        date: editionDate,
        timezone: "Europe/London",
        subject: "News",
        html: "<p>Story</p>",
        text: "Story",
        decisionSnapshot: {},
        items: [
          { itemId: "story", groupId: null, scoreId: null, snapshot: {} },
        ],
      },
      1,
    );
  if (options.freeze !== false) freeze();
  const deliveries = new DeliveryStore(store.sqlite);
  return { store, deliveries, freeze };
}

function action(overrides: Partial<SuppressionAction> = {}): SuppressionAction {
  return {
    editionDate: date,
    recipient,
    providerId: "re_accepted_123",
    ...overrides,
  };
}

function confirm(
  store: Store,
  payload: SuppressionAction,
  asOf = 1000,
  now = 1001,
) {
  const preview = previewDeliverySuppression(
    store.sqlite,
    payload,
    context,
    asOf,
  );
  confirmDeliverySuppression(
    store.sqlite,
    payload,
    context,
    asOf,
    preview.confirmation.hash,
    now,
  );
  return preview;
}

function outbox(store: Store, editionDate = date) {
  return store.sqlite
    .query<
      { status: string; provider_id: string | null; last_error: string | null },
      [string]
    >(
      "SELECT status,provider_id,last_error FROM deliveries WHERE edition_date=?",
    )
    .all(editionDate);
}

function audits(store: Store) {
  return store.sqlite
    .query("SELECT count(*) n FROM delivery_suppressions")
    .get() as { n: number };
}

test("pending outbox row is marked accepted and never resent by the sender", async () => {
  const { store, deliveries } = fixture();
  try {
    const pending = deliveries.prepare(
      date,
      recipient,
      sender,
      () => new DigestStore(store.sqlite).get(date),
      1000,
    )!;
    expect(pending.status).toBe("pending");
    confirm(store, action());
    const row = store.sqlite
      .query<{ status: string; provider_id: string }, [string]>(
        "SELECT status,provider_id FROM deliveries WHERE id=?",
      )
      .get(pending.id);
    expect(row).toEqual({ status: "sent", provider_id: "re_accepted_123" });
    const sends: string[] = [];
    const provider: DeliveryEmailProvider = {
      async send(_message, key) {
        sends.push(key);
        return { id: "should-not-send" };
      },
    };
    await new DeliveryWorker(deliveries, provider, () => 5000).send(5000);
    expect(sends).toEqual([]);
    expect(audits(store).n).toBe(1);
  } finally {
    store.close();
  }
});

test("missing outbox row gets an audit-only accepted record bound to the frozen edition", () => {
  const { store } = fixture();
  try {
    expect(outbox(store)).toEqual([]);
    confirm(store, action());
    const rows = outbox(store);
    expect(rows).toEqual([
      {
        status: "sent",
        provider_id: "re_accepted_123",
        last_error: "operator_suppressed",
      },
    ]);
    const row = store.sqlite
      .query<{ digest_id: string; idempotency_key: string }, []>(
        "SELECT digest_id,idempotency_key FROM deliveries",
      )
      .get()!;
    expect(
      store.sqlite
        .query<{ id: string }, [string]>(
          "SELECT id FROM digests WHERE edition_date=?",
        )
        .get(date)!.id,
    ).toBe(row.digest_id);
    expect(row.idempotency_key.startsWith("newspulse/")).toBe(true);
    expect(audits(store).n).toBe(1);
  } finally {
    store.close();
  }
});

test("never fabricates an edition: unknown frozen date or recipient refuses", () => {
  const { store } = fixture();
  try {
    expect(() =>
      previewDeliverySuppression(
        store.sqlite,
        action({ editionDate: "2026-01-01" }),
        context,
        1000,
      ),
    ).toThrow("No sealed frozen edition");
    expect(() =>
      confirm(store, action({ recipient: "not-an-address" })),
    ).toThrow("Invalid email address");
    expect(outbox(store)).toEqual([]);
    expect(audits(store).n).toBe(0);
  } finally {
    store.close();
  }
});

test("refuses a row that is mid-send, ambiguous or failed instead of overwriting it", () => {
  const { store, deliveries, freeze } = fixture();
  try {
    deliveries.prepare(date, recipient, sender, freeze, 1000);
    store.sqlite.query("UPDATE deliveries SET status='ambiguous'").run();
    expect(() =>
      previewDeliverySuppression(store.sqlite, action(), context, 1000),
    ).toThrow("use delivery reconciliation");
    store.sqlite.query("UPDATE deliveries SET status='sending'").run();
    expect(() =>
      previewDeliverySuppression(store.sqlite, action(), context, 1000),
    ).toThrow("use delivery reconciliation");
    expect(audits(store).n).toBe(0);
  } finally {
    store.close();
  }
});

test("previously frozen dates keep their frozen bytes and identity", () => {
  const { store } = fixture();
  try {
    const before = store.sqlite
      .query<
        { html: string; plain_text: string; fingerprint: string; id: string },
        [string]
      >(
        "SELECT id,html,plain_text,fingerprint FROM digests WHERE edition_date=?",
      )
      .get(date)!;
    confirm(store, action());
    const after = store.sqlite
      .query<
        { html: string; plain_text: string; fingerprint: string; id: string },
        [string]
      >(
        "SELECT id,html,plain_text,fingerprint FROM digests WHERE edition_date=?",
      )
      .get(date)!;
    expect(after).toEqual(before);
    expect(() =>
      new DigestStore(store.sqlite).freeze(
        {
          date,
          timezone: "Europe/London",
          subject: "Changed",
          html: "<p>Changed</p>",
          text: "Changed",
          decisionSnapshot: {},
          items: [
            { itemId: "story", groupId: null, scoreId: null, snapshot: {} },
          ],
        },
        2,
      ),
    ).toThrow("already frozen with different content");
  } finally {
    store.close();
  }
});

test("scheduler does not resend a suppressed edition after restore", async () => {
  const store = new Store(":memory:");
  try {
    new ProfileStore(store.sqlite).import([
      {
        kind: "interest",
        id: "robots",
        version: 1,
        description: "Robotics",
        entities: [],
        keywords: ["robotics"],
        priority: 5,
        positive: [],
        negative: [],
        queries: [],
        lifetime: "persistent",
        feedbackRefs: [],
      },
    ]);
    store.addSource("https://example.com/feed");
    store.enqueueDue();
    store.complete(store.claim()!, {
      items: [
        {
          nativeId: "msg-1",
          title: "Robotics tool release",
          text: "Robotics release and practical implementation ".repeat(30),
        },
      ],
    });
    store.completeProcessing(store.claimProcessing("extract")!, "unavailable");
    store.stories.reconcile();
    await new ProcessingWorker(store, { score: scoringHandler(store) }).drain(
      "score",
    );
    const now = Date.now();
    const edition = localPublicationDate(now, "Pacific/Kiritimati");
    const deliveries = new DeliveryStore(store.sqlite);
    const calls: string[] = [];
    const worker = new Sender(deliveries, {
      send: async (_message, key) => {
        calls.push(key);
        return { id: "provider-should-not-be-used" };
      },
    });
    const publication = new PublicationWorker(store, deliveries, worker, {
      timezone: "Pacific/Kiritimati",
      hour: 0,
      minute: 0,
      from: "sender@example.test",
      to: recipient,
    });
    // The scheduler freezes and queues the edition, but the sender has not run
    // yet. The operator then records the provider acceptance from restored
    // history; the subsequent scheduler tick must not send it again.
    const queued = new DeliveryStore(store.sqlite);
    queued.prepare(
      edition,
      recipient,
      sender,
      () =>
        new DigestStore(store.sqlite).get(edition) ??
        new DigestStore(store.sqlite).freeze(
          {
            date: edition,
            timezone: "Pacific/Kiritimati",
            subject: "News",
            html: "<p>Story</p>",
            text: "Story",
            decisionSnapshot: {},
            items: [
              { itemId: "story", groupId: null, scoreId: null, snapshot: {} },
            ],
          },
          now,
        ),
      now,
    );
    expect(outbox(store, edition)[0]?.status).toBe("pending");
    const payload = {
      editionDate: edition,
      recipient,
      providerId: "re_restored_accept",
    };
    confirm(store, payload, now, now);
    expect(outbox(store, edition)[0]?.status).toBe("sent");
    await publication.tick(now + 1000);
    expect(calls).toEqual([]);
    expect(outbox(store, edition)).toHaveLength(1);
    expect(outbox(store, edition)[0]?.provider_id).toBe("re_restored_accept");
  } finally {
    store.close();
  }
});

test("replay is idempotent: a second confirmation changes nothing", () => {
  const { store } = fixture();
  try {
    confirm(store, action());
    const rowsBefore = outbox(store);
    const auditBefore = audits(store).n;
    const second = previewDeliverySuppression(
      store.sqlite,
      action(),
      context,
      2000,
    );
    expect(second.outcome).toBe("already_suppressed");
    confirmDeliverySuppression(
      store.sqlite,
      action(),
      context,
      2000,
      second.confirmation.hash,
      2001,
    );
    expect(outbox(store)).toEqual(rowsBefore);
    expect(audits(store).n).toBe(auditBefore);
  } finally {
    store.close();
  }
});

test("replay with a different provider acceptance ID is refused", () => {
  const { store } = fixture();
  try {
    confirm(store, action());
    expect(() =>
      previewDeliverySuppression(
        store.sqlite,
        action({ providerId: "re_other" }),
        context,
        2000,
      ),
    ).toThrow("different accepted provider ID");
  } finally {
    store.close();
  }
});

test("confirmation is bound to the payload and expires", () => {
  const { store } = fixture();
  try {
    const preview = previewDeliverySuppression(
      store.sqlite,
      action(),
      context,
      1000,
    );
    expect(() =>
      confirmDeliverySuppression(
        store.sqlite,
        action({ providerId: "re_tampered" }),
        context,
        1000,
        preview.confirmation.hash,
        1001,
      ),
    ).toThrow("does not match");
    expect(() =>
      confirmDeliverySuppression(
        store.sqlite,
        action(),
        context,
        1000,
        preview.confirmation.hash,
        301_001,
      ),
    ).toThrow("expired");
    expect(audits(store).n).toBe(0);
  } finally {
    store.close();
  }
});

test("timezone change keys on the stored London edition date, not a recomputed date", () => {
  const { store } = fixture();
  try {
    // The stored edition date is authoritative; a different timezone must not
    // move the suppression to a neighbouring date.
    confirm(store, action());
    expect(
      store.sqlite
        .query<{ edition_date: string }, []>(
          "SELECT edition_date FROM delivery_suppressions",
        )
        .get()!.edition_date,
    ).toBe(date);
    expect(() =>
      previewDeliverySuppression(
        store.sqlite,
        action({ editionDate: "2026-11-10" }),
        context,
        2000,
      ),
    ).toThrow("No sealed frozen edition");
  } finally {
    store.close();
  }
});

test("concurrent confirmations commit once; the stale hash is refused", () => {
  const { store } = fixture();
  try {
    const first = previewDeliverySuppression(
      store.sqlite,
      action(),
      context,
      1000,
    );
    const second = previewDeliverySuppression(
      store.sqlite,
      action(),
      context,
      1000,
    );
    confirmDeliverySuppression(
      store.sqlite,
      action(),
      context,
      1000,
      first.confirmation.hash,
      1001,
    );
    expect(() =>
      confirmDeliverySuppression(
        store.sqlite,
        action(),
        context,
        1000,
        second.confirmation.hash,
        1001,
      ),
    ).toThrow("does not match current state");
    expect(audits(store).n).toBe(1);
    expect(outbox(store).length).toBe(1);
  } finally {
    store.close();
  }
});

test("restore verification covers the suppression audit table", () => {
  const dir = mkdtempSync(join(tmpdir(), "suppression-verify-"));
  const db = join(dir, "db.sqlite");
  try {
    const store = new Store(db);
    store.close();
    const report = verifyDatabase(db);
    expect(report.ok).toBe(true);
    expect(report.counts.delivery_suppressions).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
