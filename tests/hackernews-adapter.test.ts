import { describe, expect, test } from "bun:test";
import { HackerNewsAdapter } from "../src/adapters/hackernews";
import { isHackerNewsSourceUrl, parseHackerNewsSource } from "../src/domain";
import { HttpError, RssAdapter } from "../src/adapters/rss";
import { SourceRouter, Worker } from "../src/worker";
import { Store } from "../src/db/store";

const itemUrl = "https://news.ycombinator.com/item?id=100";
const listUrl = "https://news.ycombinator.com/best";

interface Recorded {
  url: URL;
}

function recordingFetcher(
  route: (request: Recorded) => Response | Promise<Response>,
) {
  const requests: Recorded[] = [];
  const fetcher = ((input: string | URL, init?: RequestInit) => {
    const request: Recorded = { url: new URL(String(input)) };
    requests.push(request);
    void init;
    return route(request);
  }) as (input: URL, init?: RequestInit) => Promise<Response>;
  return { fetcher, requests, requestsUntyped: fetcher };
}

const json = (body: unknown) => new Response(JSON.stringify(body));

const story = (overrides: Record<string, unknown> = {}) => ({
  id: 100,
  type: "story",
  by: "alice",
  time: 1_700_000_000,
  title: "A linked article",
  url: "https://example.com/article",
  score: 120,
  descendants: 1,
  kids: [101],
  ...overrides,
});

const poll = (
  fetcher: (input: URL, init?: RequestInit) => Promise<Response>,
  url: string,
  state: Parameters<HackerNewsAdapter["poll"]>[1] = {},
  limits = { maxEntries: 50, maxBytes: 5_000_000 },
) => new HackerNewsAdapter(fetcher).poll(url, state, limits);

describe("Hacker News source parsing", () => {
  test("recognizes discussion items and list feeds only", () => {
    expect(parseHackerNewsSource(itemUrl)).toEqual({ kind: "item", id: 100 });
    expect(parseHackerNewsSource("https://news.ycombinator.com/")).toEqual({
      kind: "list",
      list: "top",
    });
    expect(parseHackerNewsSource("https://news.ycombinator.com/best")).toEqual({
      kind: "list",
      list: "best",
    });
    expect(parseHackerNewsSource("https://news.ycombinator.com/jobs")).toEqual({
      kind: "list",
      list: "job",
    });
    expect(
      isHackerNewsSourceUrl("https://news.ycombinator.com/user?id=pg"),
    ).toBe(false);
    expect(
      isHackerNewsSourceUrl("https://news.ycombinator.com/item?id=0"),
    ).toBe(false);
    expect(
      isHackerNewsSourceUrl("https://news.ycombinator.com/item?id=100&x=1"),
    ).toBe(false);
    expect(isHackerNewsSourceUrl("https://example.com/item?id=100")).toBe(
      false,
    );
  });
});

describe("Hacker News discussion adapter", () => {
  test("link posts keep the discussion item and link the article as a child", async () => {
    const { fetcher, requests } = recordingFetcher(({ url }) => {
      if (url.pathname.endsWith("/item/100.json")) return json(story());
      if (url.pathname.endsWith("/item/101.json"))
        return json({
          id: 101,
          type: "comment",
          by: "bob",
          time: 1_700_000_100,
          parent: 100,
          text: "First!",
        });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const result = await poll(fetcher, itemUrl);
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/v0/item/100.json",
      "/v0/item/101.json",
    ]);
    expect(result.items).toHaveLength(1);
    const candidate = result.items[0]!;
    expect(candidate.nativeId).toBe("hn-item:100");
    expect(candidate.url).toBe(itemUrl);
    expect(candidate.sourceUrl).toBe(itemUrl);
    expect(candidate.title).toBe("A linked article");
    expect(candidate.publishedAt).toBe(1_700_000_000_000);
    expect(candidate.children).toEqual([
      { url: "https://example.com/article", title: "A linked article" },
    ]);
    expect(candidate.text).toContain("Hacker News discussion: " + itemUrl);
    expect(candidate.text).toContain("Submitter: alice");
    expect(candidate.text).toContain("bob: First!");
    expect(result.notModified).toBe(false);
  });

  test("Ask HN text posts have no linked article child", async () => {
    const { fetcher } = recordingFetcher(({ url }) =>
      url.pathname.endsWith("/item/100.json")
        ? json(
            story({
              title: "Ask HN: How do you test?",
              url: undefined,
              text: "What is your strategy?",
              kids: [],
              descendants: 0,
            }),
          )
        : new Response(null, { status: 404 }),
    );
    const result = await poll(fetcher, itemUrl);
    const candidate = result.items[0]!;
    expect(candidate.children).toBeUndefined();
    expect(candidate.url).toBe(itemUrl);
    expect(candidate.text).toContain("What is your strategy?");
  });

  test("deleted and dead content is recorded explicitly", async () => {
    const { fetcher } = recordingFetcher(({ url }) => {
      if (url.pathname.endsWith("/item/100.json"))
        return json(story({ kids: [101, 102], descendants: 2 }));
      if (url.pathname.endsWith("/item/101.json"))
        return json({ id: 101, type: "comment", deleted: true, kids: [] });
      return json({
        id: 102,
        type: "comment",
        dead: true,
        by: "spammer",
        text: "buy now",
        kids: [],
      });
    });
    const result = await poll(fetcher, itemUrl);
    const candidate = result.items[0]!;
    expect(candidate.text).toContain("[deleted]");
    expect(candidate.text).toContain("[dead] spammer: buy now");
  });

  test("a deleted parent is still recorded with an explicit marker", async () => {
    const { fetcher } = recordingFetcher(() =>
      json({ id: 100, type: "story", deleted: true, kids: [] }),
    );
    const result = await poll(fetcher, itemUrl);
    expect(result.items[0]!.title).toBe("[deleted] Hacker News item 100");
    expect(result.items[0]!.text).toContain("Status: [deleted]");
  });

  test("an unchanged discussion is not re-fetched or re-emitted", async () => {
    const { fetcher, requests } = recordingFetcher(({ url }) =>
      url.pathname.endsWith("/item/100.json")
        ? json(story({ kids: [] }))
        : json({ id: 101, type: "comment", by: "bob", text: "hi", kids: [] }),
    );
    const first = await poll(fetcher, itemUrl);
    expect(first.items).toHaveLength(1);
    const before = requests.length;
    const second = await poll(fetcher, itemUrl, { cursor: first.cursor });
    expect(second.items).toHaveLength(0);
    expect(second.notModified).toBe(true);
    // Only the root item is fetched when the structural fingerprint matches.
    expect(requests.length - before).toBe(1);
  });

  test("new comments update the discussion text", async () => {
    let version = 1;
    const { fetcher } = recordingFetcher(({ url }) => {
      if (url.pathname.endsWith("/item/100.json"))
        return json(
          version === 1
            ? story({ kids: [101], descendants: 1 })
            : story({ kids: [101, 103], descendants: 2 }),
        );
      if (url.pathname.endsWith("/item/101.json"))
        return json({
          id: 101,
          type: "comment",
          by: "bob",
          text: "first",
          kids: [],
        });
      return json({
        id: 103,
        type: "comment",
        by: "carol",
        text: "second",
        kids: [],
      });
    });
    const first = await poll(fetcher, itemUrl);
    expect(first.items[0]!.text).toContain("bob: first");
    expect(first.items[0]!.text).not.toContain("carol: second");
    version = 2;
    const second = await poll(fetcher, itemUrl, { cursor: first.cursor });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.text).toContain("carol: second");
  });

  test("deep trees are bounded by depth and comment count", async () => {
    const { fetcher } = recordingFetcher(({ url }) => {
      const id = Number(/item\/(\d+)\.json/.exec(url.pathname)![1]);
      if (id === 100)
        return json(story({ kids: [101], descendants: 1_000_000 }));
      // Each comment points at the next id, forming an unbounded chain.
      return json({
        id,
        type: "comment",
        by: `user${id}`,
        text: `comment ${id}`,
        kids: [id + 1],
      });
    });
    const result = await poll(fetcher, itemUrl);
    const candidate = result.items[0]!;
    expect(result.truncated).toBe(true);
    expect(candidate.text).toContain(
      "[discussion truncated by ingestion bounds]",
    );
    // Depth 0..4 rendered, then the bound stops the walk.
    expect(candidate.text).toContain("user104: comment 104");
    expect(candidate.text).not.toContain("user106: comment 106");
  });

  test("rate limits and server errors surface a durable retry delay", async () => {
    const rate = recordingFetcher(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    );
    await expect(poll(rate.fetcher, itemUrl)).rejects.toBeInstanceOf(HttpError);
    try {
      await poll(rate.fetcher, itemUrl);
    } catch (error) {
      expect((error as HttpError).retryAfterMs).toBe(30_000);
    }
    const missing = recordingFetcher(() => new Response(null, { status: 404 }));
    await expect(poll(missing.fetcher, itemUrl)).rejects.toThrow(
      "Hacker News API HTTP 404",
    );
  });

  test("byte budgets and malformed responses fail closed", async () => {
    await expect(
      poll(
        recordingFetcher(() => new Response(JSON.stringify(story()))).fetcher,
        itemUrl,
        {},
        { maxEntries: 50, maxBytes: 10 },
      ),
    ).rejects.toThrow("byte budget");
    await expect(
      poll(recordingFetcher(() => new Response("not json")).fetcher, itemUrl),
    ).rejects.toThrow("Invalid Hacker News JSON");
  });

  test("list feeds ingest only unseen stories and persist a restart cursor", async () => {
    const { fetcher, requests } = recordingFetcher(({ url }) => {
      if (url.pathname.endsWith("/beststories.json"))
        return json([100, 200, 300]);
      const id = Number(/item\/(\d+)\.json/.exec(url.pathname)![1]);
      return json(
        story({
          id,
          title: `Story ${id}`,
          url: `https://example.com/${id}`,
          kids: [],
          descendants: 0,
        }),
      );
    });
    const first = await poll(fetcher, listUrl);
    expect(first.items.map((item) => item.nativeId)).toEqual([
      "hn-item:100",
      "hn-item:200",
      "hn-item:300",
    ]);
    const itemFetches = requests.filter((request) =>
      request.url.pathname.includes("/item/"),
    ).length;
    expect(itemFetches).toBe(3);
    // A restart with the persisted cursor skips the already-seen stories.
    const second = await poll(fetcher, listUrl, { cursor: first.cursor });
    expect(second.items).toHaveLength(0);
    expect(second.notModified).toBe(true);
    const newItemFetches =
      requests.filter((request) => request.url.pathname.includes("/item/"))
        .length - itemFetches;
    expect(newItemFetches).toBe(0);
  });

  test("a corrupt cursor fails closed instead of skipping content", async () => {
    await expect(
      poll(recordingFetcher(() => json(story())).fetcher, itemUrl, {
        cursor: "{not json",
      }),
    ).rejects.toThrow("Invalid persisted Hacker News cursor");
    await expect(
      poll(recordingFetcher(() => json([100])).fetcher, listUrl, {
        cursor: JSON.stringify({
          version: 1,
          kind: "list",
          list: "top",
          seen: [],
        }),
      }),
    ).rejects.toThrow("Invalid persisted Hacker News cursor");
  });
});

describe("Hacker News store integration", () => {
  const feedFetcher = () =>
    ((input: string) => {
      void input;
      return Promise.resolve(
        new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><item><title>Article</title><link>https://example.com/article</link><guid>article-1</guid><description>Body</description></item></channel></rss>`,
          { headers: { "content-type": "application/rss+xml" } },
        ),
      );
    }) as unknown as ConstructorParameters<typeof RssAdapter>[0];

  test("a discussion and its linked RSS article stay separately retrievable", async () => {
    const store = new Store(":memory:");
    try {
      const hnSource = store.addSource(itemUrl, "HN discussion");
      store.addSource("https://example.com/feed.xml", "Example feed");
      const fetcher = recordingFetcher(({ url }) => {
        if (url.pathname.endsWith("/item/100.json")) return json(story());
        return json({
          id: 101,
          type: "comment",
          by: "bob",
          text: "first",
          kids: [],
        });
      }).fetcher;
      const router = new SourceRouter(
        [
          {
            matches: isHackerNewsSourceUrl,
            adapter: new HackerNewsAdapter(fetcher),
          },
        ],
        new RssAdapter(feedFetcher()),
      );
      store.enqueueDue(Date.now(), true);
      await new Worker(store, router).drain(10);
      const rows = store.sqlite
        .query<{ id: string; url: string | null }, []>(
          "SELECT id,url FROM items ORDER BY url",
        )
        .all();
      expect(rows).toHaveLength(2);
      const article = rows.find(
        (row) => row.url === "https://example.com/article",
      )!;
      const discussion = rows.find((row) => row.url === itemUrl)!;
      expect(article).toBeDefined();
      expect(discussion).toBeDefined();
      expect(article.id).not.toBe(discussion.id);
      const refs = store.sqlite
        .query<{ source_id: string; parent_item_id: string | null }, [string]>(
          "SELECT source_id,parent_item_id FROM item_sources WHERE item_id=? ORDER BY source_id",
        )
        .all(article.id);
      expect(refs).toHaveLength(2);
      const hnRef = refs.find((ref) => ref.source_id === hnSource.id)!;
      expect(hnRef.parent_item_id).toBe(discussion.id);
      // The discussion is its own item, not merged into the article.
      expect(
        store.sqlite
          .query<{ n: number }, [string]>(
            "SELECT count(*) AS n FROM item_sources WHERE item_id=?",
          )
          .get(discussion.id)!.n,
      ).toBe(1);
    } finally {
      store.close();
    }
  });

  test("a failing discussion source does not block an unrelated feed", async () => {
    const store = new Store(":memory:");
    try {
      store.addSource(itemUrl, "HN discussion");
      store.addSource("https://example.com/feed.xml", "Example feed");
      const router = new SourceRouter(
        [
          {
            matches: isHackerNewsSourceUrl,
            adapter: new HackerNewsAdapter(
              recordingFetcher(() => new Response(null, { status: 500 }))
                .fetcher,
            ),
          },
        ],
        new RssAdapter(feedFetcher()),
      );
      store.enqueueDue(Date.now(), true);
      await new Worker(store, router).drain(10);
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) AS n FROM items")
          .get()!.n,
      ).toBe(1);
    } finally {
      store.close();
    }
  });
});
