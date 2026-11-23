import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { ProfileStore } from "../src/profiles";
import { AnalysisBudget } from "../src/analysis-budget";
import { analysisConfig } from "../src/analysis-config";
import {
  CompletedAnalysisError,
  OpenAICompatibleAnalysis,
} from "../src/adapters/analysis";
import { analysisHandler } from "../src/analysis-service";
import {
  isCandidateChildLink,
  isYouTubeShortUrl,
  parseFeed,
  RssAdapter,
} from "../src/adapters/rss";
import { normalizeNewsletter } from "../src/adapters/newsletter";
import { HttpContentExtractor } from "../src/adapters/extraction";
import { ProcessingWorker } from "../src/worker";
import { scoringHandler } from "../src/scoring-service";
import { digestDefaults, previewDigest } from "../src/digest-service";
import { renderDigest } from "../src/digest-render";

describe("digest quality improvements", () => {
  test("analysisConfig parses optional maxOutputTokens and reasoningEffort", () => {
    const base = {
      ANALYSIS_ENDPOINT: "http://127.0.0.1:8081/v1/chat/completions",
      ANALYSIS_KEY: "secret",
      ANALYSIS_MODEL: "m",
      ANALYSIS_TOTAL_TOKENS: "100000",
      ANALYSIS_TOTAL_MICROS: "100000",
      ANALYSIS_CALL_MICROS: "100",
    };
    expect(analysisConfig(base)).toMatchObject({
      maxOutputTokens: 4000,
      reasoningEffort: undefined,
    });
    expect(
      analysisConfig({
        ...base,
        ANALYSIS_MAX_OUTPUT_TOKENS: "6000",
        ANALYSIS_REASONING_EFFORT: "low",
      }),
    ).toMatchObject({
      maxOutputTokens: 6000,
      reasoningEffort: "low",
    });
    expect(
      analysisConfig({ ...base, ANALYSIS_REASONING_EFFORT: "" }),
    ).toMatchObject({ reasoningEffort: undefined });
  });

  test("analysis adapter strips JSON fences, passes reasoning_effort, and attaches usage on CompletedAnalysisError", async () => {
    let sentBody: Record<string, unknown> | null = null;
    const fenced = new OpenAICompatibleAnalysis(
      {
        endpoint: "http://127.0.0.1:8081/v1/chat/completions",
        model: "m",
        apiKey: "k",
        maxInputChars: 4000,
        maxOutputTokens: 4000,
        timeoutMs: 5000,
        reasoningEffort: "low",
      },
      async (_url, init) => {
        sentBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content:
                    '```json\n{"summary":"Concise summary.","classification":"release","claims":[{"statement":"Fact one.","citation":"https://example.com/a"}],"uncertainty":[]}\n```',
                },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 80 },
          }),
          { status: 200 },
        );
      },
    );
    const ok = await fenced.analyse(
      "body text",
      "https://example.com/a",
      undefined,
      [],
    );
    expect(sentBody).toMatchObject({
      max_completion_tokens: 4000,
      reasoning_effort: "low",
    });
    expect(ok.analysis.summary).toBe("Concise summary.");
    expect(ok.usage).toEqual({ inputTokens: 120, outputTokens: 80 });

    // Reasoning-exhausted response with finish_reason="length" and content=null
    const truncated = new OpenAICompatibleAnalysis(
      {
        endpoint: "http://127.0.0.1:8081/v1/chat/completions",
        model: "m",
        apiKey: "k",
        maxInputChars: 4000,
        maxOutputTokens: 1000,
        timeoutMs: 5000,
      },
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "length", message: { content: null } }],
            usage: { prompt_tokens: 500, completion_tokens: 1000 },
          }),
          { status: 200 },
        ),
    );
    let caught: unknown;
    try {
      await truncated.analyse(
        "body text",
        "https://example.com/a",
        undefined,
        [],
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CompletedAnalysisError);
    expect((caught as CompletedAnalysisError).usage).toEqual({
      inputTokens: 500,
      outputTokens: 1000,
    });
  });

  test("analysisHandler reconciles actual reported tokens on CompletedAnalysisError and prepends title", async () => {
    const store = new Store(":memory:");
    try {
      store.addSource("https://example.com/feed");
      store.enqueueDue(1);
      store.complete(
        store.claim(1)!,
        {
          items: [
            {
              nativeId: "a",
              url: "https://example.com/item",
              title: "Distinctive Article Title",
              text: "Body without repeating the headline.",
            },
          ],
        },
        2,
      );
      store.completeProcessing(
        store.claimProcessing("extract", 3)!,
        "extracted",
        4,
        JSON.stringify({
          text: "Body without repeating the headline.",
          sourceUrl: "https://example.com/item",
        }),
      );
      const job = store.claimProcessing("analyse", 5)!;
      const budget = new AnalysisBudget(store.sqlite, {
        maxTokens: 10000,
        maxMicros: 1000,
        maxConcurrent: 1,
      });
      let seenText = "";
      const client = new OpenAICompatibleAnalysis(
        {
          endpoint: "http://127.0.0.1:8081/v1/chat/completions",
          model: "m",
          apiKey: "k",
          maxInputChars: 4000,
          maxOutputTokens: 1000,
          timeoutMs: 5000,
        },
        async (_url, init) => {
          const body = JSON.parse(String(init.body));
          seenText = JSON.parse(body.messages[1].content).text;
          return new Response(
            JSON.stringify({
              choices: [
                { finish_reason: "length", message: { content: null } },
              ],
              usage: { prompt_tokens: 400, completion_tokens: 900 },
            }),
            { status: 200 },
          );
        },
      );
      await expect(
        analysisHandler(store, client, budget, {
          provider: "openai-compatible",
          model: "m",
          promptVersion: "v1",
          reserveTokens: 5000,
          reserveMicros: 100,
        })(job, new AbortController().signal),
      ).rejects.toThrow("Analysis output incomplete");
      expect(seenText).toContain("Distinctive Article Title");
      const row = store.sqlite
        .query<{ status: string; tokens: number; micros: number }, []>(
          "SELECT status, tokens, micros FROM analysis_reservations",
        )
        .get();
      expect(row).toEqual({ status: "reconciled", tokens: 1300, micros: 100 });
    } finally {
      store.close();
    }
  });

  test("RSS fanout gating, child link filtering, YouTube Shorts filtering, and media:description", async () => {
    const linksHtml = [
      '<a href="https://a.example/post-1">Post One</a>',
      '<a href="https://b.example/post-2">Post Two</a>',
      '<a href="https://c.example/post-3">Post Three</a>',
      '<a href="https://d.example/post-4">Post Four</a>',
      '<a href="https://e.example/post-5">Post Five</a>',
      '<a href="https://elevenlabs.io/">Eleven Labs</a>',
      '<a href="https://promo.example/deal">Tool (Sponsored)</a>',
      '<a href="https://www.youtube.com/shorts/abc123">Short clip</a>',
      '<a href="https://example.org/here">Click here</a>',
    ].join(" ");
    const rssXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
      <item>
        <guid>roundup-1</guid>
        <title>Daily Roundup</title>
        <link>https://roundup.example/issue-1</link>
        <description><![CDATA[${linksHtml}]]></description>
      </item>
    </channel></rss>`;

    // With fanout enabled (default on parseFeed), only real article links survive
    const withFanout = parseFeed(rssXml, "https://roundup.example/feed");
    expect(withFanout[0]!.children?.map((c) => c.url)).toEqual([
      "https://a.example/post-1",
      "https://b.example/post-2",
      "https://c.example/post-3",
      "https://d.example/post-4",
      "https://e.example/post-5",
    ]);

    // RssAdapter respects explicit fanout allowlist
    const gated = new RssAdapter(
      async () => new Response(rssXml),
      undefined,
      new Set(["https://allowed.example/feed"]),
    );
    const blockedRes = await gated.poll("https://blocked.example/feed", {});
    expect(blockedRes.items[0]!.children).toEqual([]);
    const allowedRes = await gated.poll("https://allowed.example/feed", {});
    expect(allowedRes.items[0]!.children).toHaveLength(5);

    // YouTube Atom feed: media:description fallback + Shorts skipped
    const ytAtom = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
        <title>Channel</title>
        <entry>
          <id>yt:video:short1</id>
          <title>Quick Short</title>
          <link rel="alternate" href="https://www.youtube.com/shorts/short1"/>
          <media:group><media:description>Short desc</media:description></media:group>
        </entry>
        <entry>
          <id>yt:video:full1</id>
          <title>Agent Harness Deep Dive</title>
          <link rel="alternate" href="https://www.youtube.com/watch?v=full1"/>
          <media:group><media:description>Deep dive on coding agent harnesses and token economics.</media:description></media:group>
        </entry>
      </feed>`;
    const ytItems = parseFeed(
      ytAtom,
      "https://www.youtube.com/feeds/videos.xml",
    );
    expect(ytItems).toHaveLength(1);
    expect(ytItems[0]!.title).toBe("Agent Harness Deep Dive");
    expect(ytItems[0]!.text).toContain("token economics");
    expect(isYouTubeShortUrl("https://www.youtube.com/shorts/abc")).toBe(true);
    expect(isCandidateChildLink("https://elevenlabs.io/", "Eleven Labs")).toBe(
      false,
    );
  });

  test("newsletter normalization drops bare root homepages and YouTube Shorts", () => {
    const result = normalizeNewsletter({
      metadata: {
        providerId: "m-1",
        receivedAt: 1730000000000,
        from: "Digest <digest@example.test>",
        to: ["me@example.test"],
        subject: "AI News",
        messageId: null,
        receivedFor: [],
      },
      html: `<p>Intro</p>
        <a href="https://elevenlabs.io/">Eleven Labs</a>
        <a href="https://www.youtube.com/shorts/xyz123">Short</a>
        <a href="https://example.org/posts/real-story">Real Story</a>`,
      text: null,
    });
    expect(result.candidate.children?.map((c) => c.url)).toEqual([
      "https://example.org/posts/real-story",
    ]);
  });

  test("empty-text child re-link to an existing item records provenance without bumping digest_activity", () => {
    const store = new Store(":memory:");
    try {
      const origin = store.addSource("https://origin.example/feed");
      const roundup = store.addSource("https://roundup.example/feed");
      store.enqueueDue(1_000);
      store.complete(
        store.claim(1_000)!,
        {
          items: [
            {
              nativeId: "orig-1",
              url: "https://origin.example/old-article",
              title: "Old Article",
              text: "Substantive original article text.",
            },
          ],
        },
        1_000,
      );
      const itemId = store.search("Substantive")[0]!.id;
      const before = store.sqlite
        .query<{ activity_at: number }, [string]>(
          "SELECT activity_at FROM digest_activity WHERE item_id=?",
        )
        .get(itemId)!.activity_at;
      expect(before).toBe(1_000);

      // Days later, another feed re-links the same URL as a child with no text
      store.enqueueDue(9_000_000_000, true);
      let job = store.claim(9_000_000_000);
      while (job && job.source_id !== roundup.id) {
        store.complete(job, { items: [] }, 9_000_000_000);
        job = store.claim(9_000_000_000);
      }
      store.complete(
        job!,
        {
          items: [
            {
              nativeId: "roundup-99",
              url: "https://roundup.example/issue-99",
              title: "Roundup 99",
              text: "Links of the week",
              children: [
                {
                  url: "https://origin.example/old-article",
                  title: "Old Article",
                },
              ],
            },
          ],
        },
        9_000_000_000,
      );

      const after = store.sqlite
        .query<{ activity_at: number }, [string]>(
          "SELECT activity_at FROM digest_activity WHERE item_id=?",
        )
        .get(itemId)!.activity_at;
      expect(after).toBe(1_000);
      const sources = store.sqlite
        .query<{ source_id: string }, [string]>(
          "SELECT source_id FROM item_sources WHERE item_id=?",
        )
        .all(itemId)
        .map((r) => r.source_id);
      expect(sources).toContain(origin.id);
      expect(sources).toContain(roundup.id);
    } finally {
      store.close();
    }
  });

  test("HttpContentExtractor parses ytInitialPlayerResponse, rejects YouTube boilerplate, and skips Shorts", async () => {
    const playerJson = JSON.stringify({
      videoDetails: {
        title: "Taming the token: The economics of the agent harness",
        author: "Thoughtworks",
        shortDescription:
          "Speakers discuss harness engineering and coding agent token economics.",
      },
    });
    const ytHtml = `<!doctype html><html><head><title>- YouTube</title></head><body>
      <script>var ytInitialPlayerResponse = ${playerJson};</script>
      <div>About Press Copyright Contact us Creators Advertise Developers Terms Privacy</div>
    </body></html>`;
    const extractor = new HttpContentExtractor(
      async () => ["93.184.216.34"],
      async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: ytHtml,
      }),
    );

    const shortRes = await extractor.extract(
      "https://www.youtube.com/shorts/abc123",
    );
    expect(shortRes.status).toBe("unavailable");

    const watchRes = await extractor.extract(
      "https://www.youtube.com/watch?v=Z-q5FDDdW5w",
    );
    expect(watchRes.status).toBe("extracted");
    expect(watchRes.method).toBe("youtube-metadata");
    expect(watchRes.title).toBe(
      "Taming the token: The economics of the agent harness",
    );
    expect(watchRes.text).toContain("Channel: Thoughtworks");
    expect(watchRes.text).toContain("token economics");

    const boilerplateOnly = new HttpContentExtractor(
      async () => ["93.184.216.34"],
      async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body>AboutPressCopyrightContact usCreatorAdvertiseDevelopers</body></html>",
      }),
    );
    const badRes = await boilerplateOnly.extract(
      "https://www.youtube.com/watch?v=broken",
    );
    expect(badRes.status).toBe("unavailable");
  });

  test("digest excludes sponsored titles and Shorts, and renders single-source attribution cleanly", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([
        {
          kind: "interest",
          id: "agents",
          version: 1,
          description: "AI coding agents",
          entities: ["Claude Code"],
          keywords: ["coding agent", "agent harness"],
          priority: 5,
          positive: [],
          negative: [],
          queries: [],
          lifetime: "persistent",
          feedbackRefs: [],
        },
      ]);
      const now = Date.now();
      const today = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
      store.addSource("https://example.com/feed");
      store.enqueueDue(now);
      store.complete(
        store.claim(now)!,
        {
          items: [
            {
              nativeId: "ad-1",
              url: "https://example.com/ad",
              title: "AI coding agent tool (Sponsored)",
              text: "Coding agent harness benchmark and practical workflow ".repeat(
                20,
              ),
              publishedAt: now,
            },
            {
              nativeId: "short-1",
              url: "https://www.youtube.com/shorts/xyz999",
              title: "Coding agent harness quick tip",
              text: "Coding agent harness benchmark and practical workflow ".repeat(
                20,
              ),
              publishedAt: now,
            },
            {
              nativeId: "real-1",
              url: "https://example.com/real",
              title: "Inside modern coding agent harnesses",
              text: "Coding agent harness benchmark and practical workflow ".repeat(
                20,
              ),
              publishedAt: now,
            },
          ],
        },
        now,
      );
      while (true) {
        const ex = store.claimProcessing("extract", now);
        if (!ex) break;
        store.completeProcessing(ex, "unavailable", now);
      }
      const worker = new ProcessingWorker(store, {
        score: scoringHandler(store),
      });
      await worker.drain("score");
      store.stories.reconcile();
      await worker.drain("score");

      const preview = previewDigest(store, {
        ...digestDefaults(today),
        minScore: 0,
      });
      expect(preview.draft.status).toBe("ready");
      if (preview.draft.status === "ready") {
        expect(preview.draft.selected.map((i) => i.title)).toEqual([
          "Inside modern coding agent harnesses",
        ]);
      }

      const rendered = renderDigest(today, [
        {
          itemId: "single",
          title: "Single source story",
          why: "interest:agents@1: coding agent",
          summary: "Summary text.",
          uncertainty: [],
          references: [
            {
              source: "s1",
              nativeId: "n1",
              url: "https://example.com/real",
              title: "Single source story",
            },
          ],
        },
      ]);
      expect(rendered.html).not.toContain(">Sources</p>");
      expect(rendered.html).toContain('href="https://example.com/real"');
    } finally {
      store.close();
    }
  });
});
