import { describe, expect, test } from "bun:test";
import {
  canonicalItemUrl,
  identity,
  parseRedditDiscussion,
} from "../src/domain";

describe("Reddit discussion identity", () => {
  test("hosts, short links and trailing paths share one canonical URL", () => {
    const forms = [
      "https://www.reddit.com/r/rust/comments/abc123/some_title/",
      "https://old.reddit.com/r/rust/comments/abc123/some_title/",
      "https://m.reddit.com/r/rust/comments/abc123/some_title/",
      "https://www.reddit.com/comments/abc123/",
      "https://redd.it/abc123",
      "https://www.reddit.com/r/Rust/comments/ABC123/some_title?utm_source=share&share_id=x",
      "https://www.reddit.com/r/rust/comments/abc123/some_title/def456/?context=3",
    ];
    for (const form of forms)
      expect(canonicalItemUrl(form)).toBe(
        "https://www.reddit.com/comments/abc123",
      );
  });

  test("preserves subreddit and original URL", () => {
    expect(
      parseRedditDiscussion(
        "https://old.reddit.com/r/rust/comments/abc123/some_title/",
      ),
    ).toEqual({
      postId: "abc123",
      subreddit: "rust",
      canonicalUrl: "https://www.reddit.com/comments/abc123",
      originalUrl: "https://old.reddit.com/r/rust/comments/abc123/some_title/",
    });
    expect(parseRedditDiscussion("https://redd.it/abc123")).toMatchObject({
      postId: "abc123",
      subreddit: undefined,
    });
  });

  test("rejects non-Reddit and non-discussion URLs", () => {
    expect(
      parseRedditDiscussion("https://example.com/r/x/comments/abc123/"),
    ).toBeNull();
    expect(parseRedditDiscussion("https://www.reddit.com/r/rust/")).toBeNull();
    expect(
      parseRedditDiscussion("https://www.reddit.com/user/someone"),
    ).toBeNull();
    expect(parseRedditDiscussion("ftp://redd.it/abc123")).toBeNull();
    expect(
      parseRedditDiscussion("https://user:pass@redd.it/abc123"),
    ).toBeNull();
    // Non-Reddit URLs keep the ordinary canonical form.
    expect(canonicalItemUrl("https://example.com/a?utm_source=x#frag")).toBe(
      "https://example.com/a",
    );
  });

  test("identity uses the discussion URL when one exists", () => {
    const base = { nativeId: "x", title: "t", text: "" };
    expect(
      identity(
        { ...base, url: "https://old.reddit.com/r/rust/comments/abc123/t/" },
        "rss",
      ),
    ).toBe("url:https://www.reddit.com/comments/abc123");
    expect(
      identity(
        {
          ...base,
          url: "https://example.com/a",
          sourceUrl: "https://example.com/a?u=1",
        },
        "rss",
      ),
    ).toBe("url:https://example.com/a");
  });
});
