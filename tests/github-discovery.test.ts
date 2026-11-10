import { describe, expect, test } from "bun:test";
import { GithubSearchProvider } from "../src/adapters/github";
import { Store } from "../src/db/store";
import { runDiscovery } from "../src/discovery-service";
import { planGithubQueries } from "../src/github-discovery";
import {
  githubDiscoveryConfig,
  type GithubDiscoveryConfig,
} from "../src/github-discovery-config";
import { runScheduledGithubDiscovery } from "../src/github-discovery";
import type { GithubFetcher } from "../src/adapters/github";
import { ProfileStore, type Interest } from "../src/profiles";
import type { SearchProvider } from "../src/search-provider";

describe("GitHub repository search provider", () => {
  const repo = (name: string, overrides: Record<string, unknown> = {}) => ({
    full_name: name,
    html_url: `https://github.com/${name}`,
    description: `Description for ${name}`,
    stargazers_count: 42,
    language: "TypeScript",
    pushed_at: "2026-02-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  });

  const json = (items: unknown[], headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ total_count: items.length, items }), {
      headers,
    });

  const search = (
    route: (url: URL, headers: Record<string, string>) => Response,
    token?: string,
  ) => {
    const requests: Array<{ url: URL; headers: Record<string, string> }> = [];
    const fetcher: GithubFetcher = async (input, init) => {
      const request = {
        url: input,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      requests.push(request);
      return route(request.url, request.headers);
    };
    const provider = new GithubSearchProvider(token, fetcher);
    return { provider, requests };
  };

  test("maps repository rows to bounded search results with visible signals", async () => {
    const { provider, requests } = search((url) => {
      expect(url.pathname).toBe("/search/repositories");
      expect(url.searchParams.get("sort")).toBe("stars");
      expect(url.searchParams.get("order")).toBe("desc");
      return json([repo("acme/widgets")]);
    });
    const page = await provider.search({
      query: "widgets",
      limit: 25,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.searchParams.get("per_page")).toBe("25");
    expect(requests[0]!.url.searchParams.get("page")).toBe("1");
    expect(page.results).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
    expect(page.results[0]).toEqual({
      url: "https://github.com/acme/widgets",
      title: "acme/widgets — Description for acme/widgets",
      snippet:
        "Stars: 42; Language: TypeScript; Pushed: 2026-02-01. Description for acme/widgets",
      publishedAt: Date.parse("2026-01-01T00:00:00Z"),
    });
  });

  test("paginates with numeric cursors bounded by the API's 1000 result window", async () => {
    const { provider, requests } = search((url) => {
      if (url.searchParams.get("page") === "2")
        return json([repo("acme/second")]);
      return json(Array.from({ length: 100 }, (_, i) => repo(`acme/r${i}`)));
    });
    const first = await provider.search({ query: "widgets", limit: 150 });
    expect(requests[0]!.url.searchParams.get("per_page")).toBe("100");
    expect(first.results).toHaveLength(100);
    expect(first.nextCursor).toBe("2");
    const second = await provider.search({
      query: "widgets",
      limit: 150,
      cursor: "2",
    });
    expect(second.results.map((result) => result.title)).toEqual([
      "acme/second — Description for acme/second",
    ]);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      provider.search({ query: "widgets", limit: 150, cursor: "11" }),
    ).rejects.toThrow("Invalid GitHub search cursor");
    await expect(
      provider.search({ query: "widgets", limit: 150, cursor: "page" }),
    ).rejects.toThrow("Invalid GitHub search cursor");
  });

  test("rejects invalid queries and limits before any request", async () => {
    const { provider, requests } = search(() => json([]));
    await expect(provider.search({ query: "", limit: 10 })).rejects.toThrow(
      "Invalid GitHub search query",
    );
    await expect(
      provider.search({ query: "bad\nquery", limit: 10 }),
    ).rejects.toThrow("Invalid GitHub search query");
    await expect(
      provider.search({ query: "x".repeat(257), limit: 10 }),
    ).rejects.toThrow("Invalid GitHub search query");
    await expect(provider.search({ query: "ok", limit: 0 })).rejects.toThrow(
      "Invalid GitHub search result limit",
    );
    await expect(provider.search({ query: "ok", limit: 251 })).rejects.toThrow(
      "Invalid GitHub search result limit",
    );
    expect(requests).toHaveLength(0);
  });

  test("rate limits, invalid queries and auth failures fail the search", async () => {
    await expect(
      search(
        () =>
          new Response(null, {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          }),
      ).provider.search({ query: "widgets", limit: 10 }),
    ).rejects.toThrow("GitHub search rate limit exhausted");
    await expect(
      search(() => new Response(null, { status: 429 })).provider.search({
        query: "widgets",
        limit: 10,
      }),
    ).rejects.toThrow("GitHub search rate limit exhausted");
    await expect(
      search(() => new Response(null, { status: 422 })).provider.search({
        query: "widgets",
        limit: 10,
      }),
    ).rejects.toThrow("GitHub search rejected the query as invalid");
    await expect(
      search(() => new Response(null, { status: 401 })).provider.search({
        query: "widgets",
        limit: 10,
      }),
    ).rejects.toThrow("GitHub search authentication failed");
  });

  test("the optional token authenticates and stays out of stored output", async () => {
    const { provider, requests } = search((_url, headers) => {
      expect(headers.authorization).toBe("Bearer discovery-token");
      return json([]);
    }, "discovery-token");
    const page = await provider.search({ query: "widgets", limit: 10 });
    expect(page.results).toEqual([]);
    expect(requests).toHaveLength(1);
  });
});

describe("planGithubQueries", () => {
  const now = Date.parse("2026-03-01T12:00:00Z");
  const interest = (
    id: string,
    overrides: Partial<Interest> = {},
  ): Interest => ({
    id,
    version: 1,
    kind: "interest",
    description: `${id} interest`,
    entities: ["rust"],
    keywords: [],
    priority: 3,
    positive: [],
    negative: [],
    queries: [],
    lifetime: "persistent",
    feedbackRefs: [],
    ...overrides,
  });

  test("builds one deterministic star-floored, windowed query per interest", () => {
    const interests = [
      interest("b", {
        priority: 2,
        entities: ["build systems"],
        keywords: ["bazel", "builds", "incremental"],
      }),
      interest("a", { entities: ["rust", "compilers"] }),
    ];
    const planned = planGithubQueries(interests, now, 90);
    expect(planned).toHaveLength(2);
    expect(planned[0]!.interestId).toBe("a");
    expect(planned[0]!.query).toBe(
      "rust compilers in:description,readme pushed:>2025-12-01 stars:>10",
    );
    expect(planned[1]!.query).toBe(
      '"build systems" bazel builds in:description,readme pushed:>2025-12-01 stars:>10',
    );
    expect(planned[1]!.negative).toEqual([]);
    expect(planGithubQueries(interests, now + 60_000, 90)).toEqual(planned);
    expect(planned[0]!.kind).toBe("interest");
    expect(planned[0]!.priority).toBe(300);
  });

  test("deduplicates identical normalized queries and merges lineage", () => {
    const planned = planGithubQueries(
      [
        interest("one", {
          entities: ["rust"],
          priority: 4,
          negative: ["web3"],
        }),
        interest("two", { entities: ["rust"], priority: 1 }),
      ],
      now,
      30,
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]!.interestLineage.map((entry) => entry.id)).toEqual([
      "one",
      "two",
    ]);
    expect(planned[0]!.priority).toBe(400);
    expect(
      planGithubQueries(
        [
          interest("empty", {
            entities: [],
            keywords: [],
          }),
        ],
        now,
        90,
      ),
    ).toHaveLength(0);
  });

  test("degrades long term lists under the 256-character API limit", () => {
    const planned = planGithubQueries(
      [
        interest("long", {
          entities: [
            "distributed realtime stream processing engines",
            "very long secondary expansion term that also describes systems",
            "tertiary filler term number three for stream processing",
          ],
        }),
      ],
      now,
      365,
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]!.query.length).toBeLessThanOrEqual(256);
  });

  test("rejects windows outside the supported range", () => {
    expect(() => planGithubQueries([], now, 0)).toThrow(
      "Invalid GitHub discovery window",
    );
    expect(() => planGithubQueries([], now, 366)).toThrow(
      "Invalid GitHub discovery window",
    );
  });
});

describe("scheduled GitHub repository discovery", () => {
  const config: GithubDiscoveryConfig = {
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
    windowDays: 90,
  };
  const since = new Date(Date.parse("2026-03-01T00:00:00Z") - 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const query = `rust compilers in:description,readme pushed:>${since} stars:>10`;
  // Ticks 6010ms per read/write so per-provider pacing stays satisfied.
  const ticking = (start = Date.parse("2026-03-01T00:00:00Z")) => {
    let time = start;
    return () => {
      time += 6010;
      return time;
    };
  };
  const provider = (fetcher: GithubFetcher) =>
    new GithubSearchProvider(undefined, fetcher) satisfies SearchProvider;

  const repoRow = (name: string, overrides: Record<string, unknown> = {}) =>
    new Response(
      JSON.stringify({
        total_count: 1,
        items: [
          {
            full_name: name,
            html_url: `https://github.com/${name}`,
            description: "A compiler toolkit",
            stargazers_count: 99,
            language: "Rust",
            pushed_at: "2026-02-20T00:00:00Z",
            created_at: "2026-02-10T00:00:00Z",
            ...overrides,
          },
        ],
      }),
    );
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

  test("an un-followed relevant repository is recorded without a browser", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([interest]);
      const requests: URL[] = [];
      const fetcher: GithubFetcher = async (url) => {
        requests.push(url);
        return repoRow("acme/widgets");
      };
      const dispatched = await runScheduledGithubDiscovery(
        store,
        config,
        start,
        provider(fetcher),
        ticking(start),
      );
      expect(dispatched).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.searchParams.get("q")).toBe(query);

      const run = store.sqlite
        .query<
          {
            provider: string;
            status: string;
            query_kind: string;
            interest_lineage: string;
          },
          []
        >(
          "SELECT provider,status,query_kind,interest_lineage FROM discovery_runs",
        )
        .get()!;
      expect(run.provider).toBe("github");
      expect(run.status).toBe("completed");
      expect(run.query_kind).toBe("interest");
      expect(JSON.parse(run.interest_lineage)).toEqual([
        { id: "rust-compilers", version: 1 },
      ]);

      const page = store.sqlite
        .query<
          { status: string; reserved_results: number; usage: string | null },
          []
        >("SELECT status,reserved_results,usage FROM discovery_pages")
        .get()!;
      expect(page.status).toBe("completed");
      expect(page.reserved_results).toBe(25);
      expect(JSON.parse(page.usage!)).toEqual({
        results: 1,
        truncated: false,
      });

      const result = store.sqlite
        .query<{ origin: string; url: string; item_id: string }, []>(
          "SELECT origin,url,item_id FROM discovery_results",
        )
        .get()!;
      expect(result.origin).toBe("discovered");
      expect(result.url).toBe("https://github.com/acme/widgets");

      const item = store.sqlite
        .query<{ id: string; url: string }, []>("SELECT id,url FROM items")
        .get()!;
      expect(item.url).toBe("https://github.com/acme/widgets");
      expect(item.id).toBe(result.item_id);

      expect(
        store.sqlite
          .query<{ source_id: string }, []>(
            "SELECT source_id FROM item_sources",
          )
          .all(),
      ).toEqual([{ source_id: "discovery:github" }]);
    } finally {
      store.close();
    }
  });

  test("a followed repository is not reported as a new project", async () => {
    const store = new Store(":memory:");
    try {
      new ProfileStore(store.sqlite).import([interest]);
      store.addSource("https://github.com/acme/widgets/releases");
      const fetcher: GithubFetcher = async () => repoRow("acme/widgets");
      const dispatched = await runScheduledGithubDiscovery(
        store,
        config,
        start,
        provider(fetcher),
        ticking(start),
      );
      expect(dispatched).toBe(1);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM discovery_results",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) AS n FROM items")
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      store.close();
    }
  });

  test("provider pacing blocks a second dispatch inside the GitHub gap", async () => {
    const store = new Store(":memory:");
    try {
      const fixed = () => start;
      const fetcher: GithubFetcher = async () => repoRow("acme/widgets");
      const first = await runDiscovery(
        store,
        provider(fetcher),
        query,
        config.limits,
        fixed,
      );
      expect(first.status).toBe("complete");
      const second = await runDiscovery(
        store,
        provider(fetcher),
        query,
        config.limits,
        fixed,
      );
      expect(second.status).toBe("budget_exhausted");
      expect(second.pages).toBe(0);
    } finally {
      store.close();
    }
  });
});
