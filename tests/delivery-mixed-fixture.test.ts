import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { InboundStore } from "../src/db/inbound";
import { normalizeNewsletter } from "../src/adapters/newsletter";
import { ProfileStore } from "../src/profiles";
import { ProcessingWorker } from "../src/worker";
import { scoringHandler } from "../src/scoring-service";
import { DeliveryStore } from "../src/db/delivery-store";
import { DeliveryWorker } from "../src/delivery";
import { PublicationWorker } from "../src/publication-worker";
import { DigestStore } from "../src/db/digest-store";
import { localPublicationDate } from "../src/publication-schedule";

test("RSS and inbound stories retain citations in the frozen edition and fake send", async () => {
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
    const source = store.addSource("https://feed.example/rss", "Robot feed");
    store.enqueueDue();
    store.complete(store.claim()!, {
      items: [
        {
          nativeId: "rss-entry",
          url: "https://feed.example/story?utm_source=feed",
          title: "Robotics factory upgrade",
          text: "Robotics factory upgrade and practical implementation ".repeat(
            30,
          ),
        },
      ],
    });
    const now = Date.now();
    const metadata = {
      providerId: "received-1",
      receivedAt: now,
      from: "News <news@example.com>",
      to: [],
      subject: "Robotics newsletter",
      messageId: null,
      receivedFor: [],
    };
    const inbound = new InboundStore(store.sqlite);
    inbound.recordEvent("resend", { eventId: "event-1", metadata }, now);
    const claim = inbound.claimMessage(now)!;
    expect(
      inbound.completeMessage(
        claim,
        {
          metadata,
          text: "Robotics research and practical control systems ".repeat(30),
          html: null,
        },
        now,
      ),
    ).toBe(true);
    expect(store.indexNextNewsletter(normalizeNewsletter, now)).toBe(true);
    for (
      let job = store.claimProcessing("extract");
      job;
      job = store.claimProcessing("extract")
    )
      store.completeProcessing(job, "unavailable");
    store.stories.reconcile();
    await new ProcessingWorker(store, { score: scoringHandler(store) }).drain(
      "score",
    );
    const messages: { subject: string; text: string; html: string }[] = [];
    const deliveries = new DeliveryStore(store.sqlite);
    const sender = new DeliveryWorker(deliveries, {
      send: async (message) => {
        messages.push(message);
        return { id: "provider-1" };
      },
    });
    const worker = new PublicationWorker(store, deliveries, sender, {
      timezone: "Pacific/Kiritimati",
      hour: 0,
      minute: 0,
      from: "sender@example.com",
      to: "reader@example.com",
    });
    await worker.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain("rss-entry");
    expect(messages[0]!.text).toContain(
      "https://feed.example/story?utm_source=feed",
    );
    expect(messages[0]!.text).toContain("received-1");
    expect(messages[0]!.html).toContain(
      "https://feed.example/story?utm_source=feed",
    );
    expect(deliveries.list()[0]!.status).toBe("sent");
    const date = localPublicationDate(Date.now(), "Pacific/Kiritimati");
    const frozen = new DigestStore(store.sqlite).get(date)!;
    expect(frozen.items).toHaveLength(2);
    const snapshots = frozen.items.map(
      (item) =>
        item.snapshot as {
          citations: {
            sourceId: string;
            nativeId: string;
            url: string | null;
          }[];
        },
    );
    expect(
      snapshots.some((item) =>
        item.citations.some(
          (c) => c.sourceId === source.id && c.nativeId === "rss-entry",
        ),
      ),
    ).toBe(true);
    expect(
      snapshots.some((item) =>
        item.citations.some(
          (c) => c.nativeId.includes("received-1") && c.url === null,
        ),
      ),
    ).toBe(true);
  } finally {
    store.close();
  }
});
