import { describe, expect, test } from "bun:test";
import { GitHubSourceAdapter } from "../src/adapters/github";
import { isGithubSourceUrl } from "../src/domain";
import { HttpError, RssAdapter } from "../src/adapters/rss";
import { SourceRouter, Worker } from "../src/worker";
import { Store } from "../src/db/store";

const releasesUrl = "https://github.com/acme/widgets/releases";
const eventsUrl = "https://github.com/acme/widgets/events";

interface Recorded {
  url: URL;
  headers: Record<string, string>;
}

function recordingFetcher(
  route: (request: Recorded) => Response | Promise<Response>,
) {
  const requests: Recorded[] = [];
  // Shared with the RSS adapter, which passes string URLs.
  const fetcher = ((input: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request: Recorded = { url: new URL(String(input)), headers };
    requests.push(request);
    return route(request);
  }) as (input: URL, init?: RequestInit) => Promise<Response>;
  return { fetcher, requests, requestsUntyped: fetcher };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers });

function releaseRow(
  id: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    tag_name: `v1.0.${id}`,
    name: `Release ${id}`,
    html_url: `https://github.com/acme/widgets/releases/tag/v1.0.${id}`,
    author: { login: "octo-author" },
    body: `Notes for release ${id}`,
    published_at: "2026-01-02T03:04:05Z",
    updated_at: "2026-01-02T03:04:05Z",
    created_at: "2026-01-02T03:04:05Z",
    draft: false,
    prerelease: false,
    ...overrides,
  };
}

const limits = { maxEntries: 4, maxBytes: 1_000_000 };
const poll = (
  fetcher: (input: URL, init?: RequestInit) => Promise<Response>,
  url: string,
  state = {},
  override = limits,
) => new GitHubSourceAdapter(undefined, fetcher).poll(url, state, override);

describe("GitHub followed-repository adapter", () => {
  test("ingests stable release IDs with metadata and bounded paging", async () => {
    const { fetcher, requests } = recordingFetcher(({ url }) => {
      expect(url.hostname).toBe("api.github.com");
      expect(url.pathname).toBe("/repos/acme/widgets/releases");
      expect(url.searchParams.get("per_page")).toBe("100");
      const page = Number(url.searchParams.get("page") ?? "1");
      if (page === 1)
        return json(
          Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
          { etag: '"page1"' },
        );
      return json([releaseRow(101)], { etag: '"page2"' });
    });
    const result = await new GitHubSourceAdapter(undefined, fetcher).poll(
      releasesUrl,
      {},
      { maxEntries: 200, maxBytes: 10_000_000 },
    );
    expect(result.items).toHaveLength(101);
    expect(result.items[0]!.nativeId).toBe("github-release:1");
    expect(result.items.at(-1)!.nativeId).toBe("github-release:101");
    expect(result.entryCount).toBe(101);
    expect(result.truncated).toBe(false);
    expect(result.items[0]).toMatchObject({
      title: "acme/widgets Release 1",
      url: "https://github.com/acme/widgets/releases/tag/v1.0.1",
      publishedAt: Date.parse("2026-01-02T03:04:05Z"),
    });
    expect(result.items[0]!.text).toContain("Author: octo-author");
    expect(result.items[0]!.text).toContain("untrusted source text");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url.searchParams.get("page")).toBe("2");
    expect(requests.every((r) => !r.headers.authorization)).toBe(true);
    expect(JSON.parse(result.cursor!).stream).toBe("releases");
    expect(result.cursor!).not.toContain("token");
  });

  test("release edits become new observations without repeating unchanged releases", async () => {
    let first = true;
    const { fetcher, requests } = recordingFetcher(() => {
      if (first) {
        first = false;
        return json([releaseRow(1), releaseRow(2)], { etag: '"v1"' });
      }
      return json(
        [
          releaseRow(1, { name: "Edited release", body: "New notes" }),
          releaseRow(2),
        ],
        { etag: '"v2"' },
      );
    });
    const firstPage = await poll(fetcher, releasesUrl);
    expect(firstPage.items).toHaveLength(2);
    const secondPage = await poll(fetcher, releasesUrl, {
      cursor: firstPage.cursor,
      etag: firstPage.etag,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]!.nativeId).toBe("github-release:1");
    expect(secondPage.items[0]!.title).toBe("acme/widgets Edited release");
    expect(secondPage.items[0]!.text).toContain("New notes");
    expect(requests[1]!.headers["if-none-match"]).toBe('"v1"');
  });

  test("removed releases are recorded once both snapshots fully enumerate", async () => {
    let first = true;
    const { fetcher } = recordingFetcher(() => {
      if (first) {
        first = false;
        return json([releaseRow(1), releaseRow(2)]);
      }
      return json([releaseRow(1)]);
    });
    const firstPage = await poll(fetcher, releasesUrl);
    const secondPage = await poll(fetcher, releasesUrl, {
      cursor: firstPage.cursor,
      etag: firstPage.etag,
    });
    // Release 1 is re-listed unchanged, so only the removal is new.
    expect(secondPage.items.map((item) => [item.nativeId, item.title])).toEqual(
      [["github-release:2", "[Removed release] Release 2"]],
    );
    expect(secondPage.items[0]!.url).toBe(
      "https://github.com/acme/widgets/releases/tag/v1.0.2",
    );
  });

  test("conditional requests keep cursors across 304 pages", async () => {
    const { fetcher, requests } = recordingFetcher(({ url, headers }) => {
      if (headers["if-none-match"] === '"v1"')
        return new Response(null, { status: 304 });
      const page = Number(url.searchParams.get("page") ?? "1");
      return json(page === 1 ? [releaseRow(1)] : [], {
        etag: page === 1 ? '"v1"' : '"empty"',
      });
    });
    const initial = await poll(fetcher, releasesUrl);
    expect(initial.cursor).toBeDefined();
    const second = await poll(fetcher, releasesUrl, {
      cursor: initial.cursor,
      etag: initial.etag,
    });
    expect(second.items).toHaveLength(0);
    expect(second.cursor).toBe(initial.cursor);
    expect(second.etag).toBe('"v1"');
    expect(JSON.parse(second.cursor!).releases).toHaveProperty("1");
    expect(requests[1]!.headers["if-none-match"]).toBe('"v1"');
  });

  test("a fully 304'd complete snapshot reports notModified", async () => {
    // maxEntries 4 keeps the snapshot to one page; two rows make it fully
    // enumerated, so completeness and removals carry across a 304.
    const { fetcher, requests } = recordingFetcher(({ headers }) => {
      if (headers["if-none-match"] === '"p1"')
        return new Response(null, { status: 304 });
      return json([releaseRow(1), releaseRow(2)], { etag: '"p1"' });
    });
    const first = await poll(fetcher, releasesUrl);
    expect(JSON.parse(first.cursor!).complete).toBe(true);
    const second = await poll(fetcher, releasesUrl, {
      cursor: first.cursor,
      etag: first.etag,
    });
    expect(second.items).toHaveLength(0);
    expect(second.notModified).toBe(true);
    expect(second.cursor).toBe(first.cursor);
    expect(second.etag).toBe('"p1"');
    expect(JSON.parse(second.cursor!).releases).toHaveProperty("1");
    expect(requests[1]!.headers["if-none-match"]).toBe('"p1"');
  });

  test("entry limits cap ingestion and mark the window truncated", async () => {
    const { fetcher } = recordingFetcher(({ url }) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      return json(
        Array.from({ length: 100 }, (_, index) =>
          releaseRow((page - 1) * 100 + index + 1),
        ),
        { etag: `"p${page}"` },
      );
    });
    const result = await new GitHubSourceAdapter(undefined, fetcher).poll(
      releasesUrl,
      {},
      { maxEntries: 150, maxBytes: 10_000_000 },
    );
    expect(result.items).toHaveLength(150);
    expect(result.entryCount).toBe(150);
    expect(result.truncated).toBe(true);
    const cursor = JSON.parse(result.cursor!);
    expect(Object.keys(cursor.releases)).toHaveLength(150);
    // The partially consumed page is refetched rather than cached as complete.
    expect(cursor.pages[1].etag).toBeUndefined();
  });

  test("a changed earlier page keeps terminal-page completeness across a 304", async () => {
    const page1 = Array.from({ length: 100 }, (_, index) =>
      releaseRow(index + 1),
    );
    let first = true;
    const { fetcher } = recordingFetcher(({ url, headers }) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      if (page === 2 && headers["if-none-match"] === '"p2"')
        return new Response(null, { status: 304 });
      if (first)
        return json(page === 1 ? page1 : [releaseRow(101)], {
          etag: page === 1 ? '"p1"' : '"p2"',
        });
      return json(page === 1 ? [releaseRow(102), ...page1.slice(0, 99)] : [], {
        etag: page === 1 ? '"p1b"' : '"p2"',
      });
    });
    const initial = await poll(
      fetcher,
      releasesUrl,
      {},
      { maxEntries: 200, maxBytes: 10_000_000 },
    );
    expect(JSON.parse(initial.cursor!).complete).toBe(true);
    first = false;
    const second = await poll(
      fetcher,
      releasesUrl,
      { cursor: initial.cursor, etag: initial.etag },
      { maxEntries: 200, maxBytes: 10_000_000 },
    );
    // Page 1 changed, but the unchanged terminal page still proves completeness.
    expect(JSON.parse(second.cursor!).complete).toBe(true);
    expect(second.items.map((item) => item.nativeId)).toContain(
      "github-release:102",
    );
  });

  test("a repository rename produces a new observation for the same release", async () => {
    let first = true;
    const { fetcher } = recordingFetcher(() => {
      if (first) {
        first = false;
        return json([releaseRow(1)]);
      }
      return json([
        releaseRow(1, {
          html_url: "https://github.com/acme/renamed/releases/tag/v1.0.1",
        }),
      ]);
    });
    const initial = await poll(fetcher, releasesUrl);
    expect(initial.items).toHaveLength(1);
    const second = await poll(fetcher, releasesUrl, {
      cursor: initial.cursor,
      etag: initial.etag,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.url).toBe(
      "https://github.com/acme/renamed/releases/tag/v1.0.1",
    );
  });

  test("still-visible events survive history trimming", async () => {
    const seen = Array.from({ length: 300 }, (_, index) => String(index + 1));
    const cursor = JSON.stringify({
      version: 1,
      stream: "events",
      pages: [],
      releases: {},
      seenEvents: seen,
    });
    const { fetcher } = recordingFetcher(() =>
      json([
        {
          id: "1",
          type: "IssuesEvent",
          payload: {
            action: "closed",
            issue: {
              number: 1,
              html_url: "https://github.com/acme/widgets/issues/1",
            },
          },
        },
        {
          id: "301",
          type: "IssuesEvent",
          payload: {
            action: "closed",
            issue: {
              number: 2,
              html_url: "https://github.com/acme/widgets/issues/2",
            },
          },
        },
      ]),
    );
    const result = await poll(fetcher, eventsUrl, { cursor });
    expect(result.items.map((item) => item.nativeId)).toEqual([
      "github-event:301",
    ]);
    const next = JSON.parse(result.cursor!);
    expect(next.seenEvents).toContain("1");
    expect(next.seenEvents).toContain("301");
    expect(next.seenEvents).toHaveLength(300);
  });

  test("repository renames switch API paths and keep stable item identity", async () => {
    let first = true;
    const { fetcher, requests } = recordingFetcher(() => {
      if (first) {
        first = false;
        return json([
          releaseRow(9, {
            html_url:
              "https://github.com/acme/widgets-renamed/releases/tag/v1.0.1",
          }),
        ]);
      }
      return json([releaseRow(9)]);
    });
    const firstPage = await poll(fetcher, releasesUrl);
    expect(firstPage.items[0]!.title).toContain("acme/widgets-renamed");
    expect(firstPage.items[0]!.nativeId).toBe("github-release:9");
    await poll(fetcher, releasesUrl, {
      cursor: firstPage.cursor,
      etag: firstPage.etag,
    });
    expect(requests[1]!.url.pathname).toBe(
      "/repos/acme/widgets-renamed/releases",
    );
  });

  test("follows bounded repository redirects after renames", async () => {
    const { fetcher, requests } = recordingFetcher(({ url, headers }) => {
      if (url.pathname === "/repos/acme/widgets/releases") {
        expect(headers["x-github-api-version"]).toBe("2022-11-28");
        return new Response(null, {
          status: 301,
          headers: {
            location: "https://api.github.com/repositories/123/releases",
          },
        });
      }
      expect(url.pathname).toBe("/repositories/123/releases");
      expect(url.searchParams.get("per_page")).toBe("4");
      return json([
        releaseRow(9, {
          html_url:
            "https://github.com/acme/widgets-renamed/releases/tag/v1.0.1",
        }),
      ]);
    });
    const result = await poll(fetcher, releasesUrl);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.title).toContain("acme/widgets-renamed");
    expect(requests).toHaveLength(2);
  });

  test("redirects to a different stream or host fail closed", async () => {
    await expect(
      poll(
        recordingFetcher(
          () =>
            new Response(null, {
              status: 302,
              headers: {
                location: "https://api.github.com/repositories/123/events",
              },
            }),
        ).fetcher,
        releasesUrl,
      ),
    ).rejects.toThrow("redirect destination is not allowed");
    await expect(
      poll(
        recordingFetcher(
          () =>
            new Response(null, {
              status: 302,
              headers: {
                location: "https://evil.example.com/repositories/123/releases",
              },
            }),
        ).fetcher,
        releasesUrl,
      ),
    ).rejects.toThrow("redirect destination is not allowed");
  });

  test("rate exhaustion returns a durable retry delay", async () => {
    const error = await poll(
      recordingFetcher(
        () =>
          new Response("rate limited", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "2000000000",
              "retry-after": "60",
            },
          }),
      ).fetcher,
      releasesUrl,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toContain("rate limit");
    expect(error.retryAfterMs).toBe(60_000);
    const rate = await poll(
      recordingFetcher(
        () =>
          new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      ).fetcher,
      releasesUrl,
    ).catch((e) => e);
    expect(rate.retryAfterMs).toBe(30_000);
  });

  test("permission and authentication failures fail the poll", async () => {
    const denied = await poll(
      recordingFetcher(
        () =>
          new Response(null, {
            status: 403,
            headers: { "x-ratelimit-remaining": "40" },
          }),
      ).fetcher,
      releasesUrl,
    ).catch((e) => e);
    expect(denied).toBeInstanceOf(HttpError);
    expect(denied.message).toContain("denied access");
    expect(denied.retryAfterMs).toBe(0);
    await expect(
      poll(
        recordingFetcher(() => new Response(null, { status: 401 })).fetcher,
        releasesUrl,
      ),
    ).rejects.toThrow("authentication failed");
    await expect(
      poll(
        recordingFetcher(() => new Response(null, { status: 404 })).fetcher,
        releasesUrl,
      ),
    ).rejects.toThrow("not found");
  });

  test("a configured token is sent as a header and never persisted", async () => {
    const { fetcher, requests } = recordingFetcher(({ headers }) => {
      expect(headers.authorization).toBe("Bearer secret-token-for-tests");
      return json([releaseRow(1)]);
    });
    const result = await new GitHubSourceAdapter(
      "secret-token-for-tests",
      fetcher,
    ).poll(releasesUrl, {}, limits);
    expect(requests).toHaveLength(1);
    expect(result.cursor).not.toContain("secret-token-for-tests");
    expect(JSON.stringify(result)).not.toContain("secret-token-for-tests");
  });

  test("byte budgets and malformed responses fail closed", async () => {
    await expect(
      poll(
        recordingFetcher(() => new Response(`[${"x".repeat(2000)}]`)).fetcher,
        releasesUrl,
        {},
        { maxEntries: 4, maxBytes: 1000 },
      ),
    ).rejects.toThrow("byte budget");
    await expect(
      poll(
        recordingFetcher(() => new Response("not json")).fetcher,
        releasesUrl,
      ),
    ).rejects.toThrow("Invalid GitHub JSON");
    await expect(
      poll(recordingFetcher(() => json({ items: [] })).fetcher, releasesUrl),
    ).rejects.toThrow("Invalid GitHub releases response");
  });

  test("corrupt cursors fail the poll instead of silently re-ingesting", async () => {
    await expect(
      poll(recordingFetcher(() => json([releaseRow(1)])).fetcher, releasesUrl, {
        cursor: "{not-json",
      }),
    ).rejects.toThrow("Invalid persisted GitHub cursor");
  });

  test("scoped activity ingests finished issue and PR milestones only", async () => {
    const { fetcher, requests } = recordingFetcher(() =>
      json(
        [
          {
            id: "1",
            type: "PushEvent",
            payload: { commits: [{ sha: "abc" }] },
            repo: { id: 2, name: "acme/widgets" },
          },
          {
            id: "2",
            type: "IssuesEvent",
            payload: {
              action: "closed",
              issue: {
                number: 7,
                title: "Broken build",
                html_url: "https://github.com/acme/widgets/issues/7",
              },
            },
            repo: { id: 2, name: "acme/widgets" },
            actor: { login: "maintainer" },
            created_at: "2026-02-03T04:05:06Z",
          },
          {
            id: "3",
            type: "IssuesEvent",
            payload: {
              action: "opened",
              issue: { html_url: "https://github.com/acme/widgets/issues/8" },
            },
          },
          {
            id: "4",
            type: "PullRequestEvent",
            payload: {
              action: "closed",
              pull_request: {
                number: 9,
                title: "Refactor auth",
                merged: true,
                merged_at: "2026-02-04T06:07:08Z",
                html_url: "https://github.com/acme/widgets/pull/9",
              },
            },
            actor: { login: "maintainer" },
          },
          {
            id: "5",
            type: "PullRequestEvent",
            payload: {
              action: "closed",
              pull_request: {
                html_url: "https://github.com/acme/widgets/pull/10",
              },
            },
          },
          {
            id: "6",
            type: "PullRequestEvent",
            payload: {
              action: "closed",
              pull_request: {
                number: 11,
                title: "Abandoned change",
                merged: false,
                merged_at: null,
                html_url: "https://github.com/acme/widgets/pull/11",
              },
            },
          },
        ],
        { etag: '"events-v1"' },
      ),
    );
    const result = await poll(
      fetcher,
      eventsUrl,
      {},
      {
        maxEntries: 20,
        maxBytes: 1_000_000,
      },
    );
    expect(requests[0]!.url.pathname).toBe("/repos/acme/widgets/events");
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.nativeId)).toEqual([
      "github-event:2",
      "github-event:4",
    ]);
    expect(result.items[0]!.title).toBe(
      "acme/widgets issue closed: Broken build",
    );
    expect(result.items[1]!.title).toBe(
      "acme/widgets pull request merged: Refactor auth",
    );
    expect(result.items[0]!.publishedAt).toBe(
      Date.parse("2026-02-03T04:05:06Z"),
    );
    expect(result.items[0]!.text).toContain("untrusted source content");
    expect(result.etag).toBe('"events-v1"');
    expect(JSON.parse(result.cursor!).seenEvents).toEqual(["2", "4"]);
  });

  test("seen event IDs suppress repeats across unconditional repolls", async () => {
    const { fetcher, requests } = recordingFetcher(() =>
      json(
        [
          {
            id: "2",
            type: "IssuesEvent",
            payload: {
              action: "closed",
              issue: {
                number: 7,
                html_url: "https://github.com/acme/widgets/issues/7",
              },
            },
          },
        ],
        { etag: '"events-v1"' },
      ),
    );
    const initial = await poll(fetcher, eventsUrl);
    expect(initial.items).toHaveLength(1);
    const repeat = await poll(fetcher, eventsUrl, {
      cursor: initial.cursor,
      etag: initial.etag,
    });
    expect(repeat.items).toHaveLength(0);
    expect(requests[1]!.headers["if-none-match"]).toBe('"events-v1"');
  });

  test("unreadable source URLs are rejected", async () => {
    await expect(
      poll(recordingFetcher(() => json([])).fetcher, "https://github.com/acme"),
    ).rejects.toThrow("Invalid GitHub repository source URL");
    expect(isGithubSourceUrl(releasesUrl)).toBe(true);
    expect(isGithubSourceUrl("https://github.com/acme/releases")).toBe(false);
    expect(isGithubSourceUrl("http://github.com/acme/widgets/releases")).toBe(
      false,
    );
  });
});

describe("GitHub sources in the polling pipeline", () => {
  const atomFeed = `<?xml version="1.0" encoding="utf-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <title>Release notes from Widgets</title>
    <id>tag:github.com,2008:https://github.com/acme/widgets/releases</id>
    <updated>2026-01-02T03:04:05Z</updated>
    <entry>
      <id>tag:github.com,2008:Repository/000000001/v1.0.1</id>
      <updated>2026-01-02T03:04:05Z</updated>
      <link rel="alternate" type="text/html" href="https://github.com/acme/widgets/releases/tag/v1.0.1"/>
      <title type="html">Version 1.0.1</title>
      <author><name>octo-author</name></author>
      <content type="html">Notes for release 1</content>
    </entry>
  </feed>`;

  test("the same release via GitHub API and RSS is one canonical item", async () => {
    const { fetcher } = recordingFetcher(({ url }) => {
      if (url.hostname === "api.github.com") return json([releaseRow(1)]);
      return new Response(atomFeed, {
        headers: { "content-type": "application/atom+xml" },
      });
    });
    const store = new Store(":memory:");
    try {
      const rss = store.addSource(
        "https://github.com/acme/widgets/releases.atom",
        "Widgets releases (Atom)",
      );
      const github = store.addSource(releasesUrl, "Widgets releases (API)");
      expect(rss.kind).toBe("rss");
      expect(github.kind).toBe("github");
      store.enqueueDue(100, true);
      await new Worker(
        store,
        new SourceRouter(
          [
            {
              matches: isGithubSourceUrl,
              adapter: new GitHubSourceAdapter(undefined, fetcher),
            },
          ],
          new RssAdapter(
            fetcher as unknown as ConstructorParameters<typeof RssAdapter>[0],
          ),
        ),
      ).drain(10);
      const items = store.sqlite
        .query<{ url: string }, []>("SELECT * FROM items")
        .all();
      expect(items).toHaveLength(1);
      expect(items[0]!.url).toBe(
        "https://github.com/acme/widgets/releases/tag/v1.0.1",
      );
      const sources = store.sqlite
        .query(
          "SELECT r.source_id,s.kind FROM item_sources r JOIN sources s ON s.id=r.source_id ORDER BY s.kind",
        )
        .all();
      expect(sources).toEqual([
        { source_id: github.id, kind: "github" },
        { source_id: rss.id, kind: "rss" },
      ]);
      expect(
        store.sqlite
          .query<{ native_id: string }, []>(
            "SELECT native_id FROM item_sources ORDER BY native_id",
          )
          .all()
          .map((row) => row.native_id),
      ).toEqual([
        "github-release:1",
        "tag:github.com,2008:Repository/000000001/v1.0.1",
      ]);
    } finally {
      store.close();
    }
  });

  test("budget changes clear the GitHub cursor so paging restarts cleanly", async () => {
    const store = new Store(":memory:");
    try {
      const github = store.addSource(releasesUrl, "Widgets releases");
      store.enqueueDue(100, true);
      const job = store.claim(100)!;
      expect(
        store.complete(
          job,
          {
            items: [],
            etag: '"v1"',
            cursor: '{"version":1,"stream":"releases"}',
          },
          101,
        ),
      ).toBe(true);
      expect(store.state(github.id).cursor).toBe(
        '{"version":1,"stream":"releases"}',
      );
      store.updateSource(github.id, { maxEntries: 100 });
      expect(store.state(github.id).cursor).toBeUndefined();
      expect(store.state(github.id).etag).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("GitHub sources can be managed and removed like RSS sources", async () => {
    const store = new Store(":memory:");
    try {
      const github = store.addSource(eventsUrl, "Widgets activity");
      expect(store.sources().map((s) => s.kind)).toEqual(["github"]);
      expect(store.updateSource(github.id, { title: "Activity" }).title).toBe(
        "Activity",
      );
      store.removeSource(github.id);
      expect(store.sources()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("invalid GitHub URLs are rejected at subscription time", () => {
    const store = new Store(":memory:");
    try {
      expect(() => store.addSource("https://github.com/acme")).toThrow(
        "GitHub sources",
      );
      expect(() =>
        store.addSource("https://github.com/acme/widgets/wiki"),
      ).toThrow("GitHub sources");
      store.addSource("https://github.com/acme/widgets/releases.atom", "Atom");
      expect(store.sources()[0]!.kind).toBe("rss");
    } finally {
      store.close();
    }
  });
});
