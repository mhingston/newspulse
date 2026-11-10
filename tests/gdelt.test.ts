import { describe, expect, test } from "bun:test";
import { GdeltSearchProvider } from "../src/adapters/gdelt";

const json = (value: unknown) => new Response(JSON.stringify(value));
describe("GDELT discovery adapter", () => {
  test("requests bounded JSON and distinguishes observation from publication", async () => {
    const provider = new GdeltSearchProvider(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(
        "https://api.gdeltproject.org/api/v2/doc/doc",
      );
      expect(url.searchParams.get("query")).toBe("clean energy");
      expect(url.searchParams.get("mode")).toBe("artlist");
      expect(url.searchParams.get("format")).toBe("json");
      expect(url.searchParams.get("maxrecords")).toBe("2");
      expect(init?.redirect).toBe("error");
      return json({
        articles: [
          {
            url: "https://example.org/news?utm_source=x",
            title: "<b>New</b> development",
            seendate: "20260102T030405Z",
          },
          { url: "javascript:alert(1)", title: "ignored" },
        ],
      });
    });
    const page = await provider.search({ query: "clean energy", limit: 2 });
    expect(page.truncated).toBe(true);
    expect(page.results).toEqual([
      {
        url: "https://example.org/news?utm_source=x",
        title: "New development",
        observedAt: Date.parse("2026-01-02T03:04:05Z"),
      },
    ]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.results[0]?.publishedAt).toBeUndefined();
  });
  test("handles empty results and missing or invalid observation dates", async () => {
    await expect(
      new GdeltSearchProvider(async () => json({})).search({
        query: "news",
        limit: 10,
      }),
    ).rejects.toThrow("Invalid GDELT response");
    const empty = new GdeltSearchProvider(async () => json({ articles: [] }));
    expect(await empty.search({ query: "news", limit: 10 })).toEqual({
      results: [],
      truncated: false,
    });
    const provider = new GdeltSearchProvider(async () =>
      json({
        articles: [
          {
            url: "https://example.org/",
            title: "Title",
            seendate: "20260231T030405Z",
          },
        ],
      }),
    );
    expect(
      (await provider.search({ query: "news", limit: 10 })).results[0]
        ?.observedAt,
    ).toBeUndefined();
  });
  test("rejects invalid inputs, transport failures, oversize and malformed responses", async () => {
    const provider = new GdeltSearchProvider(
      async () => new Response("x".repeat(1_000_001)),
    );
    await expect(provider.search({ query: "x", limit: 251 })).rejects.toThrow(
      "limit",
    );
    await expect(
      provider.search({ query: "x", limit: 2, cursor: "1" }),
    ).rejects.toThrow("cursor");
    await expect(provider.search({ query: "x", limit: 2 })).rejects.toThrow(
      "byte limit",
    );
    await expect(
      new GdeltSearchProvider(
        async () => new Response("rate", { status: 429 }),
      ).search({ query: "x", limit: 2 }),
    ).rejects.toThrow("HTTP 429");
    await expect(
      new GdeltSearchProvider(async () => {
        throw new Error("secret details");
      }).search({ query: "x", limit: 2 }),
    ).rejects.toThrow("failed or timed out");
    await expect(
      new GdeltSearchProvider(async () =>
        json({ error: "service unavailable" }),
      ).search({ query: "x", limit: 2 }),
    ).rejects.toThrow("Invalid GDELT response");
    await expect(
      new GdeltSearchProvider(async () =>
        json({ message: "service unavailable" }),
      ).search({ query: "x", limit: 2 }),
    ).rejects.toThrow("Invalid GDELT response");
    await expect(
      new GdeltSearchProvider(async () => new Response("bad json")).search({
        query: "x",
        limit: 2,
      }),
    ).rejects.toThrow("Invalid GDELT JSON");
  });
});
