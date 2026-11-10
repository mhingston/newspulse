import { describe, expect, test } from "bun:test";
import {
  HackerNewsSearchProvider,
  type HackerNewsFetcher,
} from "../src/adapters/hackernews";
import { Store } from "../src/db/store";
import { runDiscovery } from "../src/discovery-service";
import { planHnQueries, runScheduledHnDiscovery } from "../src/hn-discovery";
import { ProfileStore, type Interest } from "../src/profiles";
import type { SearchProvider } from "../src/search-provider";
import type { HnDiscoveryConfig } from "../src/hn-discovery-config";

describe("Hacker News search provider", () => {
  const hit = (overrides: Record<string, unknown> = {}) => ({
    objectID: "22238335",
    title: "Why Discord switched to Rust",
    url: "https://blog.example.com/rust",
    author: "Sikul",
    points: 1582,
    num_comments: 642,
    created_at: "2020-02-04T17:30:40Z",
    created_at_i: 1_580_837_440,
    ...overrides,
  });

  const page = (hits: unknown[], overrides: Record<string, unknown> = {}) =>
    new Response(
      JSON.stringify({
        hits,
        nbHits: hits.length,
        nbPages: 1,
        page: 0,
        hitsPerPage: hits.length,
        ...overrides,
      }),
    );

  const search = (route: (url: URL) => Response | Promise<Response>) => {
    const requests: URL[] = [];
    const fetcher: HackerNewsFetcher = async (url) => {
      requests.push(url);
      return route(url);
    };
    return {
      provider: new HackerNewsSearchProvider(fetcher),
      requests,
    };
  };

  test("maps hits to bounded results with discussion provenance", async () => {
    const { provider, requests } = search(() => page([hit()]));
    const result = await provider.search({ query: "rust", limit: 25 });
    expect(requests[0]!.searchParams.get("query")).toBe("rust");
    expect(requests[0]!.searchParams.get("tags")).toBe("story");
    expect(requests[0]!.searchParams.get("hitsPerPage")).toBe("25");
    expect(result.results).toEqual([
      {
        url: "https://blog.example.com/rust",
        title: "Why Discord switched to Rust",
        snippet:
          "Points: 1582; Comments: 642; Discussion: https://news.ycombinator.com/item?id=22238335",
        publishedAt: 1_580_837_440_000,
      },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  test("text-only stories fall back to the discussion URL", async () => {
    const { provider } = search(() =>
      page([hit({ url: null, story_text: "Ask HN: what now?" })]),
    );
    const result = await provider.search({ query: "ask", limit: 10 });
    expect(result.results[0]!.url).toBe(
      "https://news.ycombinator.com/item?id=22238335",
    );
    expect(result.results[0]!.snippet).toContain("Ask HN: what now?");
  });

  test("paginates with a bounded cursor", async () => {
    const { provider, requests } = search((url) =>
      page(
        url.searchParams.get("page") === "1"
          ? [hit({ objectID: "2" })]
          : [hit({ objectID: "1" })],
        { nbPages: 3 },
      ),
    );
    const first = await provider.search({ query: "rust", limit: 1 });
    expect(first.nextCursor).toBe("1");
    expect(first.truncated).toBe(true);
    const second = await provider.search({
      query: "rust",
      limit: 1,
      cursor: "1",
    });
    expect(requests[1]!.searchParams.get("page")).toBe("1");
    expect(second.results[0]!.url).toBe("https://blog.example.com/rust");
    expect(second.nextCursor).toBe("2");
    await expect(
      provider.search({ query: "rust", limit: 1, cursor: "999" }),
    ).rejects.toThrow("Invalid Hacker News search cursor");
    await expect(
      provider.search({ query: "rust", limit: 1, cursor: "x" }),
    ).rejects.toThrow("Invalid Hacker News search cursor");
  });

  test("rate limits and malformed responses fail closed", async () => {
    await expect(
      search(() => new Response("slow", { status: 429 })).provider.search({
        query: "rust",
        limit: 10,
      }),
    ).rejects.toThrow("Hacker News search HTTP 429");
    await expect(
      search(() => new Response("nope")).provider.search({
        query: "rust",
        limit: 10,
      }),
    ).rejects.toThrow("Invalid Hacker News search JSON");
    await expect(
      search(() => page([hit()])).provider.search({ query: "", limit: 10 }),
    ).rejects.toThrow("Invalid Hacker News search query");
  });
});

describe("HN interest query planning", () => {
  const interest: Interest = {
    kind: "interest",
    id: "rust-compilers",
    version: 2,
    description: "Rust compilers",
    entities: ["rust"],
    keywords: ["compilers", "LLVM"],
    priority: 3,
    positive: [],
    negative: ["crypto"],
    queries: [],
    lifetime: "persistent",
    feedbackRefs: [],
  };

  test("builds one deterministic query per interest", () => {
    const queries = planHnQueries([interest]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      query: "rust compilers LLVM",
      kind: "interest",
      interestId: "rust-compilers",
      interestVersion: 2,
      interestLineage: [{ id: "rust-compilers", version: 2 }],
      negative: ["crypto"],
    });
  });
});

describe("scheduled HN discovery", () => {
  const config: HnDiscoveryConfig = {
    limits: {
      maxQueriesPerDay: 10,
      maxQueriesPerRun: 1,
      maxResultsPerDay: 50,
      maxResultsPerRun: 25,
      maxCostMicrosPerDay: 100,
      maxCostMicrosPerRun: 20,
      reservedCostMicrosPerQuery: 10,
    },
    intervalMs: 24 * 3_600_000,
  };
  const start = Date.parse("2026-03-01T00:00:00Z");
  const interest: Interest = {
    kind: "interest",
    id: "rust-compilers",
    version: 1,
    description: "Rust compilers",
    entities: ["rust"],
    keywords: ["compilers"],
    priority: 3,
    positive: [],
    negative: [],
    queries: [],
    lifetime: "persistent",
    feedbackRefs: [],
  };
  const ticking = (from = start) => {
    let time = from;
    return () => {
      time += 6010;
      return time;
    };
  };
  const storyHit = (overrides: Record<string, unknown> = {}) =>
    new Response(
      JSON.stringify({
        hits: [
          {
            objectID: "22238335",
            title: "A Rust compiler",
            url: "https://example.com/rust-compiler",
            points: 42,
            num_comments: 3,
            created_at_i: 1_770_000_000,
            ...overrides,
          },
        ],
        nbHits: 1,
        nbPages: 1,
        page: 0,
        hitsPerPage: 25,
      }),
    );
  const provider = (fetcher: HackerNewsFetcher) =>
    new HackerNewsSearchProvider(fetcher) satisfies SearchProvider;

  test("an un-followed relevant story enters the shared pipeline", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([interest]);
      const requests: URL[] = [];
      const fetcher: HackerNewsFetcher = async (url) => {
        requests.push(url);
        return storyHit();
      };
      const dispatched = await runScheduledHnDiscovery(
        store,
        config,
        start,
        provider(fetcher),
        ticking(),
      );
      expect(dispatched).toBe(1);
      expect(requests).toHaveLength(1);

      const run = store.sqlite
        .query<
          {
            provider: string;
            status: string;
            query_kind: string;
            schedule_key: string;
            interest_lineage: string;
          },
          []
        >(
          "SELECT provider,status,query_kind,schedule_key,interest_lineage FROM discovery_runs",
        )
        .get()!;
      expect(run.provider).toBe("hackernews");
      expect(run.status).toBe("completed");
      expect(run.query_kind).toBe("interest");
      expect(run.schedule_key).toBe("hackernews:rust-compilers@1");
      expect(JSON.parse(run.interest_lineage)).toEqual([
        { id: "rust-compilers", version: 1 },
      ]);

      const result = store.sqlite
        .query<{ origin: string; url: string; item_id: string }, []>(
          "SELECT origin,url,item_id FROM discovery_results",
        )
        .get()!;
      expect(result.origin).toBe("discovered");
      expect(result.url).toBe("https://example.com/rust-compiler");

      const item = store.sqlite
        .query<{ id: string; url: string }, []>("SELECT id,url FROM items")
        .get()!;
      expect(item.id).toBe(result.item_id);
      expect(item.url).toBe("https://example.com/rust-compiler");
      expect(
        store.sqlite
          .query<{ source_id: string }, []>(
            "SELECT source_id FROM item_sources",
          )
          .all(),
      ).toEqual([{ source_id: "discovery:hackernews" }]);
    } finally {
      store.close();
    }
  });

  test("a followed discussion is not reported as a new discovery", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([interest]);
      store.addSource(
        "https://news.ycombinator.com/item?id=22238335",
        "Followed discussion",
      );
      const fetcher: HackerNewsFetcher = async () => storyHit();
      const dispatched = await runScheduledHnDiscovery(
        store,
        config,
        start,
        provider(fetcher),
        ticking(),
      );
      expect(dispatched).toBe(1);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM discovery_results",
          )
          .get()!.n,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("negative interest terms filter matching stories", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([
        { ...interest, negative: ["compiler"] },
      ]);
      const fetcher: HackerNewsFetcher = async () => storyHit();
      const dispatched = await runScheduledHnDiscovery(
        store,
        config,
        start,
        provider(fetcher),
        ticking(),
      );
      expect(dispatched).toBe(1);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM discovery_results",
          )
          .get()!.n,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("the durable interval prevents a second dispatch before it elapses", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([interest]);
      const fetcher: HackerNewsFetcher = async () => storyHit();
      const first = await runScheduledHnDiscovery(
        store,
        config,
        start,
        provider(fetcher),
        ticking(),
      );
      expect(first).toBe(1);
      const soon = start + 3_600_000;
      const second = await runScheduledHnDiscovery(
        store,
        config,
        soon,
        provider(fetcher),
        ticking(soon),
      );
      expect(second).toBe(0);
    } finally {
      store.close();
    }
  });

  test("provider pacing blocks a second dispatch inside the search gap", async () => {
    const store = new Store(":memory:");
    try {
      const fixed = () => start;
      const fetcher: HackerNewsFetcher = async () => storyHit();
      const first = await runDiscovery(
        store,
        provider(fetcher),
        "rust",
        config.limits,
        fixed,
      );
      expect(first.status).toBe("complete");
      const second = await runDiscovery(
        store,
        provider(fetcher),
        "rust",
        config.limits,
        fixed,
      );
      expect(second.status).toBe("budget_exhausted");
      expect(second.pages).toBe(0);
    } finally {
      store.close();
    }
  });

  test("the discovery run snapshot includes followed Hacker News sources", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([interest]);
      const followed = store.addSource(
        "https://news.ycombinator.com/item?id=999999",
        "Followed discussion",
      );
      const fetcher: HackerNewsFetcher = async () => storyHit();
      const dispatched = await runScheduledHnDiscovery(
        store,
        config,
        start,
        provider(fetcher),
        ticking(),
      );
      expect(dispatched).toBe(1);
      const snapshot = store.sqlite
        .query<{ subscription_snapshot: string }, []>(
          "SELECT subscription_snapshot FROM discovery_runs",
        )
        .get()!;
      expect(
        (JSON.parse(snapshot.subscription_snapshot) as { sources: string[] })
          .sources,
      ).toContain(followed.id);
    } finally {
      store.close();
    }
  });
});
