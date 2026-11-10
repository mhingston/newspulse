import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { InboundStore } from "../src/db/inbound";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryStore } from "../src/db/delivery-store";
import { DeliveryWorker, type DeliveryMessage } from "../src/delivery";
import { FeedbackLinkDelivery } from "../src/delivery-feedback";
import { createApp } from "../src/http";
import { renderDigest } from "../src/digest-render";
import { normalizeNewsletter } from "../src/adapters/newsletter";
import type { ReceivedEmail } from "../src/inbound";

const token = "feedback-test-token-at-least-24-chars";
const secret = "feedback-secret-at-least-32-characters";
const baseUrl = "https://feedback.example.com";
const date = "2026-11-09";

function complete(store: Store, message: ReceivedEmail) {
  const inbound = new InboundStore(store.sqlite);
  inbound.recordEvent(
    "resend",
    {
      eventId: `event-${message.metadata.providerId}`,
      metadata: message.metadata,
    },
    1,
  );
  const claim = inbound.claimMessage(2)!;
  expect(inbound.completeMessage(claim, message, 3)).toBe(true);
}

/**
 * A real edition: an RSS item and a newsletter (inbound) item, each with a
 * citation, frozen and delivered through the feedback-injecting provider.
 */
async function deliverEdition() {
  const store = new Store(":memory:");
  const feed = store.addSource("https://feed.example/rss", "Feed");
  store.enqueueDue(1, true);
  store.complete(
    store.claim(2)!,
    {
      items: [
        {
          nativeId: "rss-entry",
          url: "https://example.com/rss-article",
          title: "RSS article",
          text: "RSS article body",
        },
      ],
    },
    3,
  );
  complete(store, {
    metadata: {
      providerId: "newsletter-one",
      receivedAt: 10,
      from: "One <one@example.com>",
      to: [],
      subject: "Newsletter",
      messageId: null,
      receivedFor: [],
    },
    text: null,
    html: '<p>Newsletter original narrative</p><a href="https://example.com/newsletter-article">An article</a>',
  });
  expect(store.indexNextNewsletter(normalizeNewsletter, 4)).toBe(true);
  const rss = store.search("RSS article body")[0]!;
  const newsletter = store.search("narrative")[0]!;

  const rendered = renderDigest(date, [
    {
      itemId: rss.id,
      title: "RSS article",
      why: "matches robotics",
      summary: "A summary",
      uncertainty: ["model estimate"],
      references: [
        {
          source: feed.id,
          nativeId: "rss-entry",
          url: "https://example.com/rss-article",
        },
      ],
    },
    {
      itemId: newsletter.id,
      title: "Newsletter article",
      why: "matches robotics",
      summary: null,
      uncertainty: [],
      references: [
        {
          source: "inbound",
          nativeId: "newsletter-one",
          url: "https://example.com/newsletter-article",
        },
      ],
    },
  ]);

  const now = Date.now();
  const deliveries = new DeliveryStore(store.sqlite);
  deliveries.prepare(
    date,
    "reader@example.com",
    "sender@example.com",
    () =>
      new DigestStore(store.sqlite).freeze(
        {
          date,
          timezone: "Europe/London",
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          decisionSnapshot: { feedbackTargets: rendered.feedbackTargets },
          items: rendered.feedbackTargets.map((target) => ({
            itemId: target.itemId,
            groupId: null,
            scoreId: null,
            snapshot: {},
          })),
        },
        now,
      ),
    now,
  );

  const sent: DeliveryMessage[] = [];
  const worker = new DeliveryWorker(
    deliveries,
    new FeedbackLinkDelivery(
      store.sqlite,
      {
        send: async (message) => {
          sent.push(message);
          return { id: "provider-1" };
        },
      },
      { secret, baseUrl },
    ),
    () => now,
  );
  await worker.send(now);

  const app = createApp(store, {
    token,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
    feedbackOrigin: baseUrl,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  return {
    store,
    rss,
    newsletter,
    message: sent[0]!,
    async close() {
      await server.stop(true);
      store.close();
    },
    url: server.url,
  };
}

function linkFrom(html: string, itemId: string, action: string): string {
  const pattern = new RegExp(
    `href="([^"]*\\/feedback\\/v1\\.[^"]*action=${action}[^"]*)"[^>]*>`,
  );
  const match = pattern.exec(html);
  if (!match) throw new Error(`No ${action} link for ${itemId}`);
  return match[1]!.replace(/&amp;/g, "&");
}

/** The link points at the public origin; route it at the local test server. */
function local(base: URL, link: string): string {
  const parsed = new URL(link);
  return new URL(parsed.pathname + parsed.search, base).href;
}

test("delivery injects scoped feedback links without modifying the frozen edition", async () => {
  const edition = await deliverEdition();
  try {
    const { message, store } = edition;
    expect(message.html).toContain("<!--np:feedback:");
    expect(message.html).toContain("Useful");
    expect(message.html).toContain("Not useful");
    // The frozen digest row is untouched: the links live in the token table.
    const frozen = store.sqlite
      .query<{ html: string }, [string]>(
        "SELECT html FROM digests WHERE edition_date=?",
      )
      .get(date)!;
    expect(frozen.html).not.toContain("/feedback/");
    expect(message.text).toContain("/feedback/");
    expect(
      store.sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM digest_feedback_tokens",
        )
        .get()!.n,
    ).toBe(4);
    // Re-rendering for a retry reuses the same tokens rather than adding more.
    const deliveries = new DeliveryStore(store.sqlite);
    const retry = new FeedbackLinkDelivery(
      store.sqlite,
      { send: async () => ({ id: "provider-2" }) },
      { secret, baseUrl },
    );
    const again = await retry.send(
      message,
      "key",
      new AbortController().signal,
    );
    expect(again.id).toBe("provider-2");
    expect(
      store.sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM digest_feedback_tokens",
        )
        .get()!.n,
    ).toBe(4);
  } finally {
    await edition.close();
  }
});

test("a feedback link records once, never on GET, and cannot mutate sources or spend", async () => {
  const edition = await deliverEdition();
  try {
    const { message, store, url } = edition;
    const link = linkFrom(message.html, edition.rss.id, "useful");

    // A link scanner or prefetcher only sees a confirmation page.
    const form = await fetch(local(url, link));
    expect(form.status).toBe(200);
    expect(await form.text()).toContain("Confirm feedback");
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM item_feedback")
        .get()!.n,
    ).toBe(0);
    expect(
      store.sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM digest_feedback_tokens WHERE used_at IS NOT NULL",
        )
        .get()!.n,
    ).toBe(0);

    // The explicit POST the user submits records exactly one event.
    const recorded = await fetch(local(url, link), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=useful",
    });
    expect(recorded.status).toBe(200);
    const feedback = store.sqlite
      .query<
        {
          item_id: string;
          useful: number;
          source: string;
          edition_date: string;
        },
        []
      >("SELECT item_id,useful,source,edition_date FROM item_feedback")
      .all();
    expect(feedback).toEqual([
      {
        item_id: edition.rss.id,
        useful: 1,
        source: "email",
        edition_date: date,
      },
    ]);
    // The event is attributed to the edition it came from.
    expect(
      store.sqlite
        .query<{ digest_id: string }, []>("SELECT digest_id FROM item_feedback")
        .get()!.digest_id,
    ).toBeTruthy();

    // Replaying the same link is rejected and records nothing new.
    const replay = await fetch(local(url, link), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=useful",
    });
    expect(replay.status).toBe(400);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM item_feedback")
        .get()!.n,
    ).toBe(1);

    // The link is scoped: it cannot change a source or trigger spending.
    expect(store.sources()).toHaveLength(2);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM discovery_pages")
        .get()!.n,
    ).toBe(0);
    expect(
      store.sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM mutation_confirmations",
        )
        .get()!.n,
    ).toBe(0);
  } finally {
    await edition.close();
  }
});

test("a link cannot flip its action, and an unknown link is refused", async () => {
  const edition = await deliverEdition();
  try {
    const { message, store, url } = edition;
    const link = linkFrom(message.html, edition.rss.id, "useful");
    const oversized = await fetch(local(url, link), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `action=useful&extra=${"a".repeat(1024)}`,
    });
    expect(oversized.status).toBe(413);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM item_feedback")
        .get()!.n,
    ).toBe(0);
    expect(
      store.sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM digest_feedback_tokens WHERE used_at IS NOT NULL",
        )
        .get()!.n,
    ).toBe(0);

    // Changing the submitted action does not match the token's bound action.
    const flipped = await fetch(local(url, link), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=not_useful",
    });
    expect(flipped.status).toBe(400);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM item_feedback")
        .get()!.n,
    ).toBe(0);
    // A fabricated token is rejected without touching the database.
    const forged = await fetch(
      new URL(
        `/feedback/v1.${"a".repeat(24)}.${"b".repeat(43)}?action=useful`,
        url,
      ).href,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "action=useful",
      },
    );
    expect(forged.status).toBe(400);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM item_feedback")
        .get()!.n,
    ).toBe(0);
  } finally {
    await edition.close();
  }
});

test("a feedback link expires after its window", async () => {
  const edition = await deliverEdition();
  try {
    const { message, store, url } = edition;
    const link = linkFrom(message.html, edition.newsletter.id, "useful");
    // Age the token past the 30-day window.
    store.sqlite
      .query(
        "UPDATE digest_feedback_tokens SET created_at=created_at-(31*86400000)",
      )
      .run();
    const response = await fetch(local(url, link), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=useful",
    });
    expect(response.status).toBe(400);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM item_feedback")
        .get()!.n,
    ).toBe(0);
    // The expired token is not consumed, so it stays visible for auditing.
    expect(
      store.sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM digest_feedback_tokens WHERE used_at IS NOT NULL",
        )
        .get()!.n,
    ).toBe(0);
  } finally {
    await edition.close();
  }
});

test("the feedback POST accepts the configured origin and rejects others", async () => {
  const edition = await deliverEdition();
  try {
    const { message, store, url } = edition;
    const link = linkFrom(message.html, edition.rss.id, "useful");
    // A browser opening the emailed link posts from the feedback origin, which
    // is allowed even with an empty ALLOWED_ORIGINS.
    const allowed = await fetch(local(url, link), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: baseUrl,
      },
      body: "action=useful",
    });
    expect(allowed.status).toBe(200);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM item_feedback")
        .get()!.n,
    ).toBe(1);
    // Any other origin is still refused before the token is considered.
    const other = linkFrom(message.html, edition.newsletter.id, "useful");
    const denied = await fetch(local(url, other), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: "action=useful",
    });
    expect(denied.status).toBe(403);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM item_feedback")
        .get()!.n,
    ).toBe(1);
  } finally {
    await edition.close();
  }
});

test("an oversized feedback body is rejected without recording", async () => {
  const edition = await deliverEdition();
  try {
    const { message, store, url } = edition;
    const link = linkFrom(message.html, edition.rss.id, "useful");
    const response = await fetch(local(url, link), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `action=useful&pad=${"x".repeat(8000)}`,
    });
    expect(response.status).toBe(413);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM item_feedback")
        .get()!.n,
    ).toBe(0);
    // The token remains usable once a well-formed request arrives.
    const ok = await fetch(local(url, link), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=useful",
    });
    expect(ok.status).toBe(200);
  } finally {
    await edition.close();
  }
});
