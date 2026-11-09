import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { InboundStore } from "../src/db/inbound";
import { InboundWorker, inboundWebhook } from "../src/inbound-worker";
import {
  InboundProviderError,
  type InboundEmailMetadata,
  type InboundEmailProvider,
} from "../src/inbound";

const metadata = (id: string): InboundEmailMetadata => ({
  providerId: id,
  receivedAt: 1000,
  from: "source@example.test",
  to: ["inbox@example.test"],
  subject: "Issue",
  messageId: null,
  receivedFor: [],
});

test("webhook and paginated reconciliation share durable identities across retries and restart", async () => {
  const db = new Store(":memory:");
  const inbox = new InboundStore(db.sqlite);
  let listCalls = 0,
    fetchCalls = 0,
    fail = true;
  const provider: InboundEmailProvider = {
    verifyWebhook: () => ({ eventId: "event1", metadata: metadata("one") }),
    get: async (id) => {
      fetchCalls++;
      if (fail) throw new InboundProviderError("transient", "429");
      return { metadata: metadata(id), text: "original", html: null };
    },
    list: async (after) => {
      listCalls++;
      return after
        ? { items: [metadata("two")], hasMore: false }
        : {
            items: [metadata(listCalls === 1 ? "one" : "three")],
            hasMore: true,
          };
    },
  };
  try {
    const hook = inboundWebhook(inbox, provider);
    hook("raw", new Headers());
    hook("raw", new Headers());
    expect(fetchCalls).toBe(0);
    await new InboundWorker(inbox, provider).reconcile();
    db.sqlite.query("UPDATE inbound_reconciliation SET available_at=0").run();
    await new InboundWorker(new InboundStore(db.sqlite), provider).reconcile();
    db.sqlite.query("UPDATE inbound_reconciliation SET available_at=0").run();
    await new InboundWorker(new InboundStore(db.sqlite), provider).reconcile();
    expect(listCalls).toBe(3);
    expect(
      db.sqlite.query("SELECT count(*) n FROM inbound_messages").get(),
    ).toEqual({ n: 3 });
    expect(
      db.sqlite.query("SELECT count(*) n FROM inbound_events").get(),
    ).toEqual({ n: 1 });
    await new InboundWorker(inbox, provider).retrieve();
    expect(
      db.sqlite
        .query("SELECT count(*) n FROM inbound_messages WHERE status='pending'")
        .get(),
    ).toEqual({ n: 3 });
    fail = false;
    db.sqlite.query("UPDATE inbound_messages SET available_at=0").run();
    await new InboundWorker(inbox, provider).retrieve();
    await new InboundWorker(inbox, provider).retrieve();
    await new InboundWorker(inbox, provider).retrieve();
    expect(
      db.sqlite
        .query(
          "SELECT count(*) n FROM inbound_messages WHERE status='complete'",
        )
        .get(),
    ).toEqual({ n: 3 });
  } finally {
    db.close();
  }
});

test("shutdown does not claim a retrieval after an active reconciliation finishes", async () => {
  const { schedule, Worker } = await import("../src/worker");
  const db = new Store(":memory:");
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let retrievals = 0;
  const scheduler = schedule(
    db,
    new Worker(db, { poll: async () => ({ items: [] }) }),
    undefined,
    {
      reconcile: async () => {
        began();
        await pending;
      },
      retrieve: async () => {
        retrievals++;
      },
    },
  );
  try {
    await started;
    const stopped = scheduler.stop();
    release();
    await stopped;
    expect(retrievals).toBe(0);
  } finally {
    db.close();
  }
});
