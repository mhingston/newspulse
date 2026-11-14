/**
 * Deterministic full-system acceptance run (issue #23 slice).
 *
 * One bounded run wires the real HTTP app with an authenticated official MCP
 * client over a persistent SQLite file and drives every stage through fakes at
 * the adapter boundary: a local RSS feed server, a signed Resend inbound
 * webhook plus a fake Receiving API, an OpenAI-compatible analysis fake, a
 * fake search provider, and a fake outbound email provider. No live providers,
 * no real email and no external model calls.
 */
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { InboundStore } from "../src/db/inbound";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryStore, type Delivery } from "../src/db/delivery-store";
import { RssAdapter } from "../src/adapters/rss";
import { ResendInbound } from "../src/adapters/resend-inbound";
import { normalizeNewsletter } from "../src/adapters/newsletter";
import { OpenAICompatibleAnalysis } from "../src/adapters/analysis";
import { AnalysisBudget } from "../src/analysis-budget";
import { analysisHandler } from "../src/analysis-service";
import { scoringHandler } from "../src/scoring-service";
import { Worker, ProcessingWorker, SourceRouter } from "../src/worker";
import { InboundWorker, inboundWebhook } from "../src/inbound-worker";
import { createApp } from "../src/http";
import { PublicationWorker } from "../src/publication-worker";
import { DeliveryWorker, type DeliveryMessage } from "../src/delivery";
import { FeedbackLinkDelivery } from "../src/delivery-feedback";
import { localPublicationDate } from "../src/publication-schedule";
import type { SearchPage, SearchProvider } from "../src/search-provider";
import type { ReceivedEmail } from "../src/inbound";

const token = "full-system-token-with-at-least-24-chars";
const recipient = "reader@example.test";
const sender = "digest@newspulse.example.test";
const feedbackSecret = "feedback-secret-with-at-least-32-chars!";
const webhookSecretBytes = Buffer.from("0123456789abcdef0123456789abcdef");
const webhookSecret = `whsec_${webhookSecretBytes.toString("base64")}`;

const interest = {
  id: "robotics",
  description: "Robotics and automation",
  entities: [],
  keywords: ["robotics", "automation"],
  priority: 3,
  positive: [],
  negative: [],
  queries: [],
  lifetime: "persistent",
  feedbackRefs: [],
};

const discoveryEnv = {
  DISCOVERY_DAILY_QUERIES: "5",
  DISCOVERY_RUN_QUERIES: "1",
  DISCOVERY_DAILY_RESULTS: "20",
  DISCOVERY_RUN_RESULTS: "10",
  DISCOVERY_DAILY_MICROS: "5000",
  DISCOVERY_RUN_MICROS: "1000",
  DISCOVERY_QUERY_MICROS: "100",
};

// Long enough for the substance component; deliberately free of interest
// keywords so it scores as an unmatched item.
const filler = "Seasonal composting guidance for the garden. ".repeat(64);
const roboticsHtml =
  "Robotics toolkit release covering implementation and security tradeoffs. " +
  "Automation case studies follow. ".repeat(64);
const rssFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Engineering</title><item><guid>robotics-1</guid><title>Robotics toolkit for automation released</title><link>https://example.com/robotics</link><description><![CDATA[${roboticsHtml}]]></description></item><item><guid>garden-1</guid><title>Home gardening notes on seasonal composting</title><link>https://example.com/gardening</link><description><![CDATA[${filler}]]></description></item></channel></rss>`;

const newsletterHtml =
  '<p>Unique narrative unrepeatable string from the newsletter</p><a href="https://example.com/newsletter-article?utm_source=email">An unusual attributed article</a>';
const newsletterText =
  "Unique narrative unrepeatable string from the newsletter";
const wireMetadata = {
  id: "newsletter-1",
  created_at: "2026-06-01T08:00:00Z",
  from: "newsletter@news.example.test",
  to: ["inbox@example.test"],
  subject: "Weekly engineering digest",
  message_id: "<original@news.example.test>",
  received_for: ["inbox@example.test"],
};

function mcpCall(client: Client) {
  return async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError === true,
      data: JSON.parse(
        (result.content as { text: string }[])[0]!.text,
      ) as Record<string, unknown>,
    };
  };
}

test("deterministic full-system run: RSS, signed newsletter webhook, interests, discovery, digest send and restart", async () => {
  // --- Local fakes -------------------------------------------------------
  let conditional = false;
  const feed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("if-none-match") === '"full-system-v1"') {
        conditional = true;
        return new Response(null, { status: 304 });
      }
      return new Response(rssFeed, {
        headers: {
          etag: '"full-system-v1"',
          "content-type": "application/xml",
        },
      });
    },
  });

  const receivingCalls: string[] = [];
  const receiving = async (url: string | URL | Request) => {
    receivingCalls.push(String(url));
    return Response.json(
      String(url).includes("/receiving/")
        ? {
            ...wireMetadata,
            object: "email",
            html: newsletterHtml,
            text: newsletterText,
          }
        : {
            object: "list",
            has_more: false,
            data: [wireMetadata],
          },
    );
  };

  const analysisRequests: {
    model: string;
    source: string;
    profiles: unknown[];
  }[] = [];
  const analysisSettings = {
    endpoint: "https://analysis.fake.internal/v1/chat/completions",
    model: "newspulse-fake-model",
    apiKey: "test-analysis-key",
    maxInputChars: 16000,
    maxOutputTokens: 1000,
    timeoutMs: 5000,
  };
  const analysisClient = new OpenAICompatibleAnalysis(
    analysisSettings,
    async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      const context = JSON.parse(body.messages[1].content);
      analysisRequests.push({
        model: body.model,
        source: context.source,
        profiles: context.profiles,
      });
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                summary: `Model summary for ${context.source}`,
                classification: "news",
                claims: [
                  {
                    statement:
                      "Statement attributed to the original cited source",
                    citation: context.source,
                  },
                ],
                uncertainty: [
                  "Automated summary; verify against the cited source",
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  );

  const searchQueries: string[] = [];
  const discoveryProvider: SearchProvider = {
    name: "fake-search",
    version: "1",
    async search({ query }): Promise<SearchPage> {
      searchQueries.push(query);
      return {
        results: [
          {
            url: "https://example.com/robotics",
            title: "Duplicate of the followed source item",
          },
          {
            url: "https://outside.example/lab-notes/recent-robotics-survey?utm_ref=abc",
            title: "Independent robotics survey",
            snippet:
              "Unverified search snippet for a lab outside the followed subscriptions",
          },
          {
            url: "https://outside.example/lab-notes/recent-robotics-survey",
            title: "Independent robotics survey",
          },
        ],
        truncated: false,
      };
    },
  };

  const sends: { message: DeliveryMessage; key: string }[] = [];
  const outboundEmail = {
    async send(message: DeliveryMessage, key: string) {
      sends.push({ message, key });
      return { id: `re_fake_${sends.length}` };
    },
  };

  // --- Persistent state on a real file -----------------------------------
  const dir = mkdtempSync(join(tmpdir(), "newspulse-full-system-"));
  const path = join(dir, "data.sqlite");
  let store = new Store(path);
  let api: ReturnType<typeof Bun.serve> | undefined;
  let client: Client | undefined;
  const pubOptions = {
    timezone: "Europe/London",
    hour: 0,
    minute: 0,
    from: sender,
    to: recipient,
  };
  try {
    const appConfig = (current: Store) =>
      createApp(current, {
        token,
        allowedHosts: ["127.0.0.1"],
        allowedOrigins: [],
        inboundWebhook: inboundWebhook(
          new InboundStore(current.sqlite),
          new ResendInbound("re_test_placeholder", webhookSecret, receiving),
        ),
        mcp: { discoveryProvider, env: discoveryEnv, dbPath: path },
      });
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: appConfig(store).fetch,
    });
    client = new Client({ name: "full-system-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("mcp", api.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const call = mcpCall(client);

    // Explicit interest configuration through the confirmed mutation flow,
    // before any ingestion so processing and scoring inherit it.
    const preview = await call("update_interest", { interest });
    expect(preview.isError).toBe(false);
    const confirmed = await call("update_interest", {
      confirm_token: preview.data.confirm_token,
    });
    expect((confirmed.data.interest as { version: number }).version).toBe(1);

    // (a) RSS ingestion: poll the local feed with the real adapter.
    store.addSource(`${feed.url}rss`, "Engineering");
    store.enqueueDue();
    const committed = await new Worker(
      store,
      new SourceRouter([], new RssAdapter()),
    ).drain();
    expect(committed).toBe(1);

    let search = await call("search_items", { query: "robotics" });
    expect(search.isError).toBe(false);
    const rssItems = search.data.items as {
      id: string;
      url: string | null;
      analysis_status: string;
    }[];
    expect(rssItems.length).toBeGreaterThanOrEqual(1);
    expect(
      rssItems.some((item) => item.url === "https://example.com/robotics"),
    ).toBe(true);
    // Queryability begins at ingestion, before AI completes.
    expect(rssItems.every((item) => item.analysis_status === "pending")).toBe(
      true,
    );
    const roboticsId = (await store.search("robotics toolkit"))[0]!.id;
    const unrelatedId = (await store.search("composting"))[0]!.id;

    // (b) Signed newsletter webhook through the only public route.
    const payload = JSON.stringify({
      type: "email.received",
      data: { ...wireMetadata, email_id: wireMetadata.id },
    });
    const signedHeaders = (body: string, timestamp: string, id: string) => ({
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${createHmac("sha256", webhookSecretBytes).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
    });
    const tampered = await fetch(`${api.url}webhooks/resend`, {
      method: "POST",
      headers: signedHeaders(
        `${payload} `,
        String(Math.floor(Date.now() / 1000)),
        "evt-bad",
      ),
      body: payload,
    });
    expect(tampered.status).toBe(400);
    const delivered = await fetch(`${api.url}webhooks/resend`, {
      method: "POST",
      headers: signedHeaders(
        payload,
        String(Math.floor(Date.now() / 1000)),
        "evt-newsletter-1",
      ),
      body: payload,
    });
    expect(await delivered.json()).toEqual({ ok: true });

    const inbound = new InboundWorker(
      new InboundStore(store.sqlite),
      new ResendInbound("re_test_placeholder", webhookSecret, receiving),
    );
    await inbound.reconcile();
    await inbound.retrieve();
    expect(
      store.sqlite
        .query<{ status: string }, []>("SELECT status FROM inbound_messages")
        .get(),
    ).toEqual({ status: "complete" });
    expect(receivingCalls.some((url) => url.includes("/receiving/"))).toBe(
      true,
    );
    expect(store.indexNextNewsletter(normalizeNewsletter)).toBe(true);

    // Original (no public URL) and attributed article are both searchable.
    const originals = store.search("unrepeatable");
    expect(originals).toHaveLength(1);
    const originalId = originals[0]!.id;
    expect(originals[0]!.url).toBeNull();
    search = await call("search_items", { query: "unusual attributed" });
    const attributed = (
      search.data.items as { id: string; url: string | null }[]
    ).find((item) => item.url !== null);
    expect(attributed?.url).toBe("https://example.com/newsletter-article");
    const originalItem = store.getItem(originalId)!;
    expect(
      (originalItem.references as { newsletter_sender: string }[])[0]!
        .newsletter_sender,
    ).toBe("newsletter@news.example.test");
    const attributedDetail = JSON.parse(
      (
        (
          await client.callTool({
            name: "get_item",
            arguments: { id: attributed!.id },
          })
        ).content as { text: string }[]
      )[0]!.text,
    ) as { references: { parent_item_id: string | null }[] };
    expect(
      attributedDetail.references.some(
        (ref) => ref.parent_item_id === originalId,
      ),
    ).toBe(true);

    // (c) Process the whole pipeline: extract (unavailable keeps feed text),
    // analyse against the OpenAI-compatible fake, group and score.
    const processing = new ProcessingWorker(store, {
      extract: async () => ({ status: "unavailable" }),
      analyse: analysisHandler(
        store,
        analysisClient,
        new AnalysisBudget(store.sqlite, {
          maxTokens: 200_000,
          maxMicros: 200_000,
          maxConcurrent: 1,
        }),
        {
          provider: "fake-analysis",
          model: analysisSettings.model,
          promptVersion: "1",
          reserveTokens: 18_000,
          reserveMicros: 200,
        },
      ),
      group: async () => {
        const result = store.stories.reconcile();
        if (result.stale)
          throw new Error("Story inputs changed during grouping");
        return { status: "grouped", result: JSON.stringify(result) };
      },
      score: scoringHandler(store),
    });
    for (let round = 0; round < 6; round++) {
      let done = 0;
      for (const stage of ["extract", "analyse", "group", "score"] as const)
        done += await processing.drain(stage, 50);
      if (done === 0) break;
    }
    expect(analysisRequests.length).toBeGreaterThanOrEqual(2);
    expect(
      analysisRequests.some((request) => request.source.startsWith("source:")),
    ).toBe(true);
    // The configured interest flows into processing as profile context.
    for (const request of analysisRequests)
      expect(
        request.profiles.some((p) => (p as { id: string }).id === "robotics"),
      ).toBe(true);
    const roboticsItem = store.getItem(roboticsId)!;
    expect(roboticsItem.summary).toBe(
      "Model summary for https://example.com/robotics",
    );

    // Interest configuration influences ranking: reasons record the profile
    // and the unmatched item stays ineligible.
    const roboticsScores = (
      await call("explain_ranking", {
        id: roboticsId,
      })
    ).data.scores as {
      result: { total: number; eligible: boolean; reasons: string[] };
    }[];
    expect(roboticsScores[0]!.result.eligible).toBe(true);
    expect(
      roboticsScores[0]!.result.reasons.some((reason) =>
        reason.startsWith("interest:robotics@1:"),
      ),
    ).toBe(true);
    const unrelatedScores = (
      await call("explain_ranking", {
        id: unrelatedId,
      })
    ).data.scores as typeof roboticsScores;
    expect(unrelatedScores[0]!.result.eligible).toBe(false);
    expect(roboticsScores[0]!.result.total).toBeGreaterThan(
      unrelatedScores[0]!.result.total,
    );

    // (e) Curated daily digest: frozen edition, outbox row, then a send
    // through the fake outbound provider at the adapter boundary.
    const publishNow = Date.now();
    const editionDate = localPublicationDate(publishNow, "Europe/London");
    const deliveries = new DeliveryStore(store.sqlite);
    const publication = new PublicationWorker(
      store,
      deliveries,
      new DeliveryWorker(
        new DeliveryStore(store.sqlite),
        new FeedbackLinkDelivery(store.sqlite, outboundEmail, {
          secret: feedbackSecret,
          baseUrl: "https://feedback.example.test",
        }),
      ),
      pubOptions,
    );
    await publication.tick(publishNow);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.message.to).toBe(recipient);
    expect(sends[0]!.message.from).toBe(sender);
    expect(sends[0]!.key.startsWith("newspulse/")).toBe(true);
    expect(sends[0]!.message.html).toContain("Robotics toolkit");
    expect(sends[0]!.message.html).not.toContain("composting");
    expect(sends[0]!.message.html).toContain("/feedback/v1.");
    const edition = new DigestStore(store.sqlite).get(editionDate)!;
    expect(edition.html).toContain("Robotics toolkit");
    expect(edition.items.map((row) => row.item_id)).toEqual([roboticsId]);
    const outbox = store.sqlite
      .query<
        Pick<Delivery, "status" | "provider_id" | "idempotency_key">,
        [string]
      >(
        "SELECT status,provider_id,idempotency_key FROM deliveries WHERE edition_date=?",
      )
      .all(editionDate);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      status: "sent",
      provider_id: "re_fake_1",
    });
    // Re-ticking does not rebuild the frozen edition or resend it.
    await publication.tick(publishNow);
    expect(sends).toHaveLength(1);

    // (d) Budgeted discovery via the confirmed MCP mutation: material
    // outside subscriptions with citations, canonical dedupe and budget.
    const discoveryPreview = await call("trigger_discovery", {
      query: "robotics",
    });
    expect(discoveryPreview.isError).toBe(false);
    const run = await call("trigger_discovery", {
      confirm_token: discoveryPreview.data.confirm_token,
    });
    expect(run.isError).toBe(false);
    expect(run.data).toMatchObject({ status: "complete", results: 3 });
    expect(searchQueries).toEqual(["robotics"]);
    const discoveries = (await call("get_discoveries", {})).data
      .discoveries as {
      url: string;
      origin: string;
      snippet: string | null;
    }[];
    const discovered = discoveries.filter((row) => row.origin === "discovered");
    expect(discovered).toHaveLength(2);
    expect(
      discovered.every((row) =>
        row.url.startsWith("https://outside.example/lab-notes/"),
      ),
    ).toBe(true);
    expect(discovered.some((row) => row.snippet)).toBe(true);
    search = await call("search_items", { query: "independent survey" });
    const outside = search.data.items as { id: string }[];
    expect(outside).toHaveLength(1);
    const outsideDetail = JSON.parse(
      (
        (
          await client.callTool({
            name: "get_item",
            arguments: { id: outside[0]!.id },
          })
        ).content as { text: string }[]
      )[0]!.text,
    ) as { references: { url: string }[] };
    expect(
      outsideDetail.references.some((ref) =>
        ref.url.startsWith("https://outside.example/"),
      ),
    ).toBe(true);
    // Let discovered material through the same pipeline, then verify the
    // database is quiet before restart.
    for (let round = 0; round < 6; round++) {
      let done = 0;
      for (const stage of ["extract", "analyse", "group", "score"] as const)
        done += await processing.drain(stage, 50);
      if (done === 0) break;
    }
    const itemCount = () =>
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM items")
        .get()!.n;
    expect(itemCount()).toBe(5);

    // Authentication boundary: private routes refuse unauthenticated calls,
    // authenticated MCP reads continue to work, and only the verified
    // webhook is public.
    const raw = await fetch(`${api.url}mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(raw.status).toBe(401);
    expect((await fetch(`${api.url}health`)).status).toBe(401);
    expect(
      (
        await fetch(`${api.url}health`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);

    // (f) Restart over the same SQLite file: no duplicates, search, reads.
    const countsBefore = {
      robotics: store.search("robotics").length,
      narrative: store.search("unrepeatable").length,
      unusual: store.search("unusual attributed").length,
      survey: store.search("independent survey").length,
      digest: store.search("Robotics toolkit").length,
    };
    const digestBytesBefore = structuredClone(edition);
    await client.close();
    client = undefined;
    await api.stop(true);
    api = undefined;
    store.close();

    store = new Store(path);
    conditional = false;
    store.enqueueDue(Date.now(), true);
    await new Worker(store, new SourceRouter([], new RssAdapter())).drain();
    expect(conditional).toBe(true); // conditional re-poll, nothing re-ingested
    expect(store.indexNextNewsletter(normalizeNewsletter)).toBe(false);
    expect(store.search("robotics")).toHaveLength(countsBefore.robotics);
    expect(store.search("unrepeatable")).toHaveLength(countsBefore.narrative);
    expect(store.search("unusual attributed")).toHaveLength(
      countsBefore.unusual,
    );
    expect(store.search("independent survey")).toHaveLength(
      countsBefore.survey,
    );
    expect(store.search("Robotics toolkit")).toHaveLength(countsBefore.digest);
    expect(itemCount()).toBe(5);

    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: appConfig(store).fetch,
    });
    client = new Client({ name: "full-system-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("mcp", api.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const reconnected = mcpCall(client);
    const afterSearch = await reconnected("search_items", {
      query: "robotics",
    });
    expect(afterSearch.data.items).toHaveLength(countsBefore.robotics);
    const afterDetail = await reconnected("get_item", {
      id: originalId,
    });
    expect(
      (afterDetail.data.references as { newsletter_sender: string }[])[0]!
        .newsletter_sender,
    ).toBe("newsletter@news.example.test");
    const frozenAfter = await reconnected("get_digest", {
      date: editionDate,
      view: "frozen",
    });
    expect(frozenAfter.data.id).toBe(edition.id);
    await reconnected("get_digest", {
      date: editionDate,
      view: "list",
    });
    const editionAfter = new DigestStore(store.sqlite).get(editionDate)!;
    expect(editionAfter).toEqual(digestBytesBefore); // frozen bytes immutable
    const afterDiscoveries = (
      (await reconnected("get_discoveries", {})).data.discoveries as {
        origin: string;
      }[]
    ).filter((row) => row.origin === "discovered");
    expect(afterDiscoveries.length).toBe(2);
    expect(
      (await reconnected("get_interests", {})).data.interests,
    ).toHaveLength(1);
    // The restart must not resend the already-sent edition, and a quiet new
    // civil day freezes nothing and sends nothing.
    await new PublicationWorker(
      store,
      new DeliveryStore(store.sqlite),
      new DeliveryWorker(
        new DeliveryStore(store.sqlite),
        new FeedbackLinkDelivery(store.sqlite, outboundEmail, {
          secret: feedbackSecret,
          baseUrl: "https://feedback.example.test",
        }),
      ),
      pubOptions,
    ).tick(Date.now());
    expect(sends).toHaveLength(1);
    expect(itemCount()).toBe(5);
    expect(
      store.sqlite
        .query<{ status: string }, []>("SELECT status FROM deliveries")
        .get(),
    ).toEqual({ status: "sent" });
  } finally {
    await client?.close();
    await api?.stop(true);
    await feed.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
