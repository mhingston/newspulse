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

test("restarts after today's due time and publishes the edition once", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "newspulse-catchup-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  try {
    await fixture(store);
    const now = Date.now();
    const date = localPublicationDate(now, "Pacific/Kiritimati");
    store.sqlite
      .query(
        "INSERT INTO publication_schedule_state(id,next_date,timezone,hour,minute,updated_at) VALUES(1,?,'Pacific/Kiritimati',0,0,?)",
      )
      .run(date, now - 120_000);
    store.close();
    store = new Store(path);
    const calls: string[] = [];
    const { publication, deliveries } = worker(store, calls);
    await publication.tick(now);
    await publication.tick(now);
    expect(deliveries.list()).toHaveLength(1);
    expect(deliveries.list()[0]!.status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(
      store.sqlite
        .query("SELECT date,status FROM publication_schedule_history")
        .all(),
    ).toEqual([{ date, status: "prepared" }]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restarts with a missed frozen edition and sends the original snapshot once", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "newspulse-frozen-catchup-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  try {
    const now = Date.now();
    const today = localPublicationDate(now, "Pacific/Kiritimati");
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    store.sqlite
      .query(
        "INSERT INTO items(id,identity,title,ingested_at) VALUES('old-item','old-identity','Original',1)",
      )
      .run();
    const original = new DigestStore(store.sqlite).freeze(
      {
        date: yesterday,
        timezone: "Pacific/Kiritimati",
        subject: "Original edition",
        html: "<p>Original</p>",
        text: "Original",
        decisionSnapshot: {},
        items: [
          {
            itemId: "old-item",
            groupId: null,
            scoreId: null,
            snapshot: { title: "Original" },
          },
        ],
      },
      now - 86_400_000,
    );
    store.sqlite
      .query(
        "INSERT INTO publication_schedule_state(id,next_date,timezone,hour,minute,updated_at) VALUES(1,?,'Pacific/Kiritimati',0,0,?)",
      )
      .run(yesterday, now - 86_400_000);
    store.close();
    store = new Store(path);
    const calls: string[] = [];
    const { publication, deliveries } = worker(store, calls);
    await publication.tick(now);
    await publication.tick(now);
    expect(deliveries.list()).toHaveLength(1);
    expect(deliveries.list()[0]!.digest_id).toBe(original.id);
    expect(deliveries.list()[0]!.status).toBe("sent");
    expect(new DigestStore(store.sqlite).get(yesterday)?.plain_text).toBe(
      "Original",
    );
    expect(calls).toHaveLength(1);
    expect(
      store.sqlite
        .query<{ status: string }, [string]>(
          "SELECT status FROM publication_schedule_history WHERE date=?",
        )
        .get(yesterday)?.status,
    ).toBe("prepared");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a scheduling failure does not starve a previously prepared delivery", async () => {
  const store = new Store(":memory:");
  try {
    await fixture(store);
    const now = Date.now();
    const today = localPublicationDate(now, "Pacific/Kiritimati");
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const item = store.sqlite
      .query<{ id: string }, []>("SELECT id FROM items LIMIT 1")
      .get()!;
    const previous = new DigestStore(store.sqlite).freeze(
      {
        date: yesterday,
        timezone: "Pacific/Kiritimati",
        subject: "Previous edition",
        html: "<p>Previous</p>",
        text: "Previous",
        decisionSnapshot: {},
        items: [
          { itemId: item.id, groupId: null, scoreId: null, snapshot: {} },
        ],
      },
      now - 86_400_000,
    );
    const deliveries = new DeliveryStore(store.sqlite);
    deliveries.prepare(
      yesterday,
      "reader@example.com",
      "sender@example.com",
      () => previous,
      now,
    );
    store.sqlite.exec(
      "CREATE TRIGGER fail_next_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    const calls: string[] = [];
    const { publication } = worker(store, calls);
    await expect(publication.tick(now)).rejects.toThrow("injected failure");
    expect(deliveries.list()[0]!.status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(new DigestStore(store.sqlite).get(today)).toBeNull();
  } finally {
    store.close();
  }
});
