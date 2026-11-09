import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryStore } from "../src/db/delivery-store";
import { DeliveryWorker } from "../src/delivery";
import { PublicationWorker } from "../src/publication-worker";
import { localPublicationDate } from "../src/publication-schedule";
import { ProfileStore } from "../src/profiles";
import { ProcessingWorker } from "../src/worker";
import { scoringHandler } from "../src/scoring-service";

async function fixture(store: Store) {
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
}

function worker(store: Store, calls: string[]) {
  const deliveries = new DeliveryStore(store.sqlite);
  const sender = new DeliveryWorker(deliveries, {
    send: async (_message, key) => {
      calls.push(key);
      return { id: "provider-1" };
    },
  });
  const publication = new PublicationWorker(store, deliveries, sender, {
    timezone: "Pacific/Kiritimati",
    hour: 0,
    minute: 0,
    from: "sender@example.com",
    to: "reader@example.com",
  });
  return { publication, deliveries };
}

test("scheduler freezes and persists an outbox before sending in the configured timezone", async () => {
  const store = new Store(":memory:");
  try {
    await fixture(store);
    const calls: string[] = [];
    const { publication, deliveries } = worker(store, calls);
    const now = Date.now();
    const date = localPublicationDate(now, "Pacific/Kiritimati");
    await publication.tick(now);
    expect(new DigestStore(store.sqlite).get(date)?.plain_text).toContain(
      "msg-1",
    );
    expect(deliveries.list()).toHaveLength(1);
    expect(deliveries.list()[0]!.status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(
      store.sqlite
        .query("SELECT date,status FROM publication_schedule_history")
        .all(),
    ).toEqual([{ date, status: "prepared" }]);
    await publication.tick(now);
    expect(calls).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("empty edition is recorded without a delivery", async () => {
  const store = new Store(":memory:");
  try {
    const calls: string[] = [];
    const { publication, deliveries } = worker(store, calls);
    await publication.tick(Date.now());
    expect(deliveries.list()).toEqual([]);
    expect(calls).toEqual([]);
    expect(
      store.sqlite
        .query("SELECT status FROM publication_schedule_history")
        .all(),
    ).toEqual([{ status: "empty" }]);
  } finally {
    store.close();
  }
});

test("failure writing outbox rolls back frozen edition and schedule and permits retry", async () => {
  const store = new Store(":memory:");
  try {
    await fixture(store);
    const calls: string[] = [];
    const { publication, deliveries } = worker(store, calls);
    const now = Date.now();
    const date = localPublicationDate(now, "Pacific/Kiritimati");
    store.sqlite.exec(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    await expect(publication.tick(now)).rejects.toThrow("injected failure");
    expect(new DigestStore(store.sqlite).get(date)).toBeNull();
    expect(deliveries.list()).toEqual([]);
    expect(
      store.sqlite.query("SELECT * FROM publication_schedule_history").all(),
    ).toEqual([]);
    expect(calls).toEqual([]);
    store.sqlite.exec("DROP TRIGGER fail_delivery");
    await publication.tick(now);
    expect(deliveries.list()).toHaveLength(1);
    expect(calls).toHaveLength(1);
  } finally {
    store.close();
  }
});
