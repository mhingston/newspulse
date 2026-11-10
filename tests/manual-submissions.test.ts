import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { submitUrl, submissionFor, validateManualUrl } from "../src/manual";
import type { ProcessingHandler } from "../src/worker";

const article = "https://example.com/posts/interesting-article";

describe("manual URL validation", () => {
  test("accepts absolute HTTP(S) URLs and normalizes them", () => {
    expect(validateManualUrl("https://example.com/a?b=1#frag")).toBe(
      "https://example.com/a?b=1#frag",
    );
    expect(validateManualUrl("http://example.com/a b")).toBe(
      "http://example.com/a%20b",
    );
  });

  test("rejects unsupported schemes, credentials and private destinations", () => {
    for (const value of [
      "ftp://example.com/a",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "mailto:someone@example.com",
      "https://user:pass@example.com/a",
      "http://127.0.0.1/a",
      "http://10.1.2.3/a",
      "http://[::1]/a",
      "http://localhost:8080/a",
      "https://build.internal/a",
      "https://printer.local/a",
    ])
      expect(() => validateManualUrl(value)).toThrow();
    expect(() => validateManualUrl("not a url")).toThrow(
      "absolute HTTP(S) URL",
    );
    expect(() => validateManualUrl("")).toThrow("Invalid URL");
  });
});

describe("manual submissions", () => {
  const fresh = () => new Store(":memory:");

  test("returns a stable item before extraction completes", () => {
    const store = fresh();
    try {
      const result = submitUrl(store, {
        submissionId: "sub-1",
        url: article,
        origin: "manual",
        title: "An interesting article",
        now: 1000,
      });
      expect(result.duplicate).toBe(false);
      expect(result.itemId).toBeTruthy();
      expect(result.status).toBe("ingested");
      const item = store.getItem(result.itemId)!;
      expect(item.url).toBe(article);
      expect(item.title).toBe("An interesting article");
      // No body has been fabricated; extraction is queued, not performed.
      expect(item.text).toBe("");
      expect(store.search("interesting")[0]?.id).toBe(result.itemId);
      const refs = item.references as { source_id: string; url: string }[];
      expect(refs).toEqual([
        expect.objectContaining({ source_id: "manual:manual", url: article }),
      ]);
      const job = store.sqlite
        .query<{ stage: string; status: string }, [string]>(
          "SELECT stage,status FROM processing_jobs WHERE item_id=?",
        )
        .all(result.itemId);
      expect(job).toContainEqual({ stage: "extract", status: "pending" });
    } finally {
      store.close();
    }
  });

  test("a repeated submission ID is idempotent, including URL spelling changes", () => {
    const store = fresh();
    try {
      const first = submitUrl(store, {
        submissionId: "sub-1",
        url: article,
        origin: "manual",
        now: 1000,
      });
      const again = submitUrl(store, {
        submissionId: "sub-1",
        url: `${article}?utm_source=mail`,
        origin: "manual",
        now: 2000,
      });
      expect(again.duplicate).toBe(true);
      expect(again.itemId).toBe(first.itemId);
      expect(again.url).toBe(article);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM manual_submissions",
          )
          .get()!.n,
      ).toBe(1);
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) AS n FROM items")
          .get()!.n,
      ).toBe(1);
    } finally {
      store.close();
    }
  });

  test("a different submission ID for the same URL reuses the canonical item", () => {
    const store = fresh();
    try {
      const first = submitUrl(store, {
        submissionId: "sub-1",
        url: article,
        origin: "manual",
        now: 1000,
      });
      const second = submitUrl(store, {
        submissionId: "sub-2",
        url: "https://example.com/posts/interesting-article#top",
        origin: "bookmark",
        now: 2000,
      });
      expect(second.duplicate).toBe(false);
      expect(second.itemId).toBe(first.itemId);
      const refs = store.getItem(first.itemId)!.references as {
        source_id: string;
      }[];
      expect(refs.map((ref) => ref.source_id).sort()).toEqual([
        "manual:bookmark",
        "manual:manual",
      ]);
    } finally {
      store.close();
    }
  });

  test("aliases and an already-known RSS article stay one item", async () => {
    const store = fresh();
    try {
      const feed = store.addSource("https://example.com/feed.xml");
      store.enqueueDue(1);
      store.complete(
        store.claim(1)!,
        {
          items: [
            {
              nativeId: "rss-1",
              url: "https://example.com/rss/article",
              title: "From RSS",
              text: "feed body",
            },
          ],
        },
        2,
      );
      const rssItem = store.search("feed")[0]!;
      const submitted = submitUrl(store, {
        submissionId: "sub-rss",
        url: "https://example.com/rss/article?utm_source=twitter",
        origin: "bookmark",
        now: 3000,
      });
      expect(submitted.itemId).toBe(rssItem.id);
      const refs = store.getItem(rssItem.id)!.references as {
        source_id: string;
      }[];
      expect(refs.map((ref) => ref.source_id).sort()).toEqual(
        [feed.id, "manual:bookmark"].sort(),
      );
      // The feed body is preserved; manual intake adds no invented text.
      expect(store.getItem(rssItem.id)!.text).toBe("feed body");
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) AS n FROM items")
          .get()!.n,
      ).toBe(1);
    } finally {
      store.close();
    }
  });

  test("Reddit results, emails and manual submissions share one discussion item", () => {
    const store = fresh();
    try {
      const search = submitUrl(store, {
        submissionId: "search-1",
        url: "https://www.reddit.com/r/programming/comments/abc123/a_title/",
        origin: "search",
        snippet: "142 points, 88 comments",
        discoveredVia: { provider: "gdelt", runId: "run-1" },
        now: 1000,
      });
      const email = submitUrl(store, {
        submissionId: "email-1",
        url: "https://old.reddit.com/r/programming/comments/ABC123/a_title/?utm_source=digest",
        origin: "email",
        now: 2000,
      });
      const manual = submitUrl(store, {
        submissionId: "manual-1",
        url: "https://redd.it/abc123",
        origin: "manual",
        now: 3000,
      });
      expect(new Set([search.itemId, email.itemId, manual.itemId]).size).toBe(
        1,
      );
      const item = store.getItem(search.itemId)!;
      expect(item.url).toBe("https://www.reddit.com/comments/abc123");
      expect(search.reddit).toEqual({
        postId: "abc123",
        subreddit: "programming",
        discussionUrl: "https://www.reddit.com/comments/abc123",
      });
      expect(item.title).toBe("Reddit r/programming post abc123");
      const provenance = submissionFor(store, search.itemId)!;
      expect(provenance).toMatchObject({
        submission_id: "search-1",
        origin: "search",
        url: "https://www.reddit.com/r/programming/comments/abc123/a_title/",
        snippet: "142 points, 88 comments",
        metadata: {
          reddit: {
            postId: "abc123",
            subreddit: "programming",
            discussionUrl: "https://www.reddit.com/comments/abc123",
          },
          discoveredVia: { provider: "gdelt", runId: "run-1" },
        },
      });
    } finally {
      store.close();
    }
  });

  test("an unavailable Reddit page keeps an honest unavailable status", async () => {
    const store = fresh();
    try {
      const result = submitUrl(store, {
        submissionId: "reddit-blocked",
        url: "https://www.reddit.com/r/programming/comments/blocked/title/",
        origin: "manual",
        now: 1000,
      });
      expect(submissionFor(store, result.itemId)!.retrieval).toMatchObject({
        status: "pending",
        text_chars: 0,
      });
      const { ProcessingWorker } = await import("../src/worker");
      // Simulate a blocked page: extraction cannot retrieve a body. No
      // browser or live Reddit request is involved.
      const extract: ProcessingHandler = async (job) => ({
        status: "unavailable",
        result: JSON.stringify({
          status: "unavailable",
          reason: "HTTP 403",
          method: "http",
          sourceUrl:
            "https://www.reddit.com/r/programming/comments/blocked/title/",
          at: 2000,
        }),
      });
      await new ProcessingWorker(store, { extract }).drain("extract");
      const item = store.getItem(result.itemId)!;
      // The item and its snippet-level provenance remain retrievable.
      expect(item.url).toBe("https://www.reddit.com/comments/blocked");
      expect(item.text).toBe("");
      const provenance = submissionFor(store, result.itemId)!;
      expect(provenance.retrieval).toEqual({
        status: "unavailable",
        method: "http",
        reason: "HTTP 403",
        text_chars: 0,
      });
      // Nothing claims the discussion was fetched.
      expect(JSON.stringify(provenance)).not.toContain("comments fetched");
    } finally {
      store.close();
    }
  });

  test("manual submissions are counted separately from discovery metrics", () => {
    const store = fresh();
    try {
      submitUrl(store, {
        submissionId: "m1",
        url: article,
        origin: "manual",
        now: 1000,
      });
      submitUrl(store, {
        submissionId: "b1",
        url: "https://example.com/other",
        origin: "bookmark",
        now: 1000,
      });
      expect(store.status().manual_submissions).toEqual([
        { origin: "bookmark", count: 1 },
        { origin: "manual", count: 1 },
      ]);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM discovery_results",
          )
          .get()!.n,
      ).toBe(0);
      // Manual sources are intake bookkeeping, never polled subscriptions.
      expect(
        store.sources().filter((source) => source.kind === "manual"),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("invalid origins and oversized fields are rejected before writing", () => {
    const store = fresh();
    try {
      expect(() =>
        submitUrl(store, {
          submissionId: "x",
          url: article,
          origin: "imap" as "manual",
        }),
      ).toThrow("Invalid submission origin");
      expect(() =>
        submitUrl(store, {
          submissionId: "y",
          url: article,
          origin: "manual",
          title: "t".repeat(1001),
        }),
      ).toThrow("Invalid title");
      expect(() =>
        submitUrl(store, {
          submissionId: "z".repeat(129),
          url: article,
          origin: "manual",
        }),
      ).toThrow("Invalid submission ID");
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) AS n FROM items")
          .get()!.n,
      ).toBe(0);
    } finally {
      store.close();
    }
  });
});
