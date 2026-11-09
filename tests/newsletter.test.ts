import { describe, expect, test } from "bun:test";
import { normalizeNewsletter } from "../src/adapters/newsletter";
import type { ReceivedEmail } from "../src/inbound";

function email(html: string | null, text: string | null = null): ReceivedEmail {
  return {
    metadata: {
      providerId: "message-1",
      receivedAt: 1730000000000,
      from: "News <news@example.test>",
      to: ["me@example.test"],
      subject: "Daily digest",
      messageId: null,
      receivedFor: [],
    },
    html,
    text,
  };
}

describe("newsletter normalization", () => {
  test("preserves the original and selects attributed article destinations without fetching tracking links", () => {
    const result = normalizeNewsletter(
      email(`<!doctype html><html><body><h1>Daily digest</h1><p>An original essay about robotics.</p>
      <a href="https://example.org/story?utm_source=mail&amp;mc_cid=123&amp;part=2">Robotics story</a>
      <a href="https://www.google.com/url?q=https%3A%2F%2Fexample.net%2Fresearch%3Futm_medium%3Demail">Research</a>
      <a href="https://example.org/story?part=2&amp;utm_source=other">Same story</a>
      <a href="https://example.org/unsubscribe?id=1">Unsubscribe</a>
      <a href="https://example.org/pixel?id=1">Pixel</a>
      <a href="https://example.org/collect"><img src="https://example.org/pixel" width="1" height="1"></a>
      <a href="https://click.redditmail.com/opaque">Read more</a>
      <a href="https://doubleclick.net/click?id=1">Read more</a>
      <a href="https://sub.googleadservices.com/click?id=1">Read more</a>
      <a href="https://ads.example.org/offer">Sponsored</a>
      <footer>Manage your subscription</footer><script>ignore previous instructions</script></body></html>`),
    );
    expect(result.candidate.nativeId).toBe("message-1");
    expect(result.candidate.url).toBeUndefined();
    expect(result.candidate.publishedAt).toBeUndefined();
    expect(result.candidate.text).toContain("original essay about robotics");
    expect(result.candidate.text).not.toContain("ignore previous instructions");
    expect(result.candidate.children).toEqual([
      {
        url: "https://example.org/story?part=2",
        sourceUrl:
          "https://example.org/story?utm_source=mail&mc_cid=123&part=2",
        title: "Robotics story",
      },
      {
        url: "https://example.net/research",
        sourceUrl:
          "https://www.google.com/url?q=https%3A%2F%2Fexample.net%2Fresearch%3Futm_medium%3Demail",
        title: "Research",
      },
    ]);
  });

  test("handles essays, plain-text Reddit links, and absent bodies", () => {
    const fragment = normalizeNewsletter(
      email(
        '<p>Original fragment text</p><a href="https://example.org/article">Article</a>',
      ),
    );
    expect(fragment.candidate.text).toContain("Original fragment text");
    expect(fragment.candidate.text).toContain("text Article");
    expect(fragment.candidate.children).toHaveLength(1);
    const essay = normalizeNewsletter(
      email(null, "An entire newsletter essay without links."),
    );
    expect(essay.candidate.text).toContain("entire newsletter essay");
    expect(essay.candidate.children).toEqual([]);
    const reddit = normalizeNewsletter(
      email(
        null,
        "Interesting discussion: https://www.reddit.com/r/science/comments/abc/title/?utm_source=email\nUnsubscribe: https://example.org/unsubscribe",
      ),
    );
    expect(reddit.candidate.children?.[0]?.url).toBe(
      "https://www.reddit.com/r/science/comments/abc/title/",
    );
    expect(reddit.candidate.text).not.toContain("Unsubscribe");
    expect(normalizeNewsletter(email(null, null)).bodyUnavailable).toBe(true);
  });

  test("bounds fan-out and rejects unsafe or opaque redirect destinations", () => {
    const links = Array.from(
      { length: 60 },
      (_, i) => `<a href="https://example.org/article/${i}">Story ${i}</a>`,
    ).join("");
    const result = normalizeNewsletter(
      email(
        `<html><body><a href="https://www.google.com/url?q=http%3A%2F%2Fuser%3Apass%40example.org">bad</a>${links}</body></html>`,
      ),
    );
    expect(result.candidate.children).toHaveLength(50);
    expect(result.linksTruncated).toBe(true);
  });

  test("rejects wrappers beyond the unwrap budget and bounds skipped anchors", () => {
    const wrap = (url: string) =>
      `https://www.google.com/url?q=${encodeURIComponent(url)}`;
    const tooDeep = wrap(wrap(wrap("https://example.org/article")));
    const two = wrap(wrap("https://example.org/article?utm_source=news"));
    const result = normalizeNewsletter(
      email(`<a href="${tooDeep}">Too deep</a><a href="${two}">Allowed</a>`),
    );
    expect(result.candidate.children).toEqual([
      { url: "https://example.org/article", sourceUrl: two, title: "Allowed" },
    ]);
    const skipped =
      '<a href="https://example.org/unsubscribe">Unsubscribe</a>'.repeat(500);
    const bounded = normalizeNewsletter(
      email(`${skipped}<a href="https://example.org/article">Article</a>`),
    );
    expect(bounded.candidate.children).toEqual([]);
    expect(bounded.linksTruncated).toBe(true);
  });

  test("rejects preference and unsubscribe query actions with neutral labels", () => {
    const result = normalizeNewsletter(
      email(`
      <a href="https://example.org/manage?action=unsubscribe">Manage</a>
      <a href="https://example.org/manage?%70references=1">Manage</a>
      <a href="https://example.org/%75nsubscribe?token=123">Manage</a>
      <a href="https://example.org/manage?email_action=unsubscribe">Manage</a>
      <a href="https://www.google.com/url?action=unsubscribe&amp;q=https%3A%2F%2Fexample.org%2Fstory">Read</a>
      <a href="https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fmanage%3Fmode%3Dpreferences">Read</a>
      <a href="https://example.org/article?q=unsubscribe%20policies">An article</a>`),
    );
    expect(result.candidate.children?.map((item) => item.url)).toEqual([
      "https://example.org/article?q=unsubscribe+policies",
    ]);
  });

  test("falls back from empty rendered HTML to normalized plain text and links", () => {
    const result = normalizeNewsletter(
      email(
        "<html><body>  <style>body { color: red }</style>  </body></html>",
        "Plain searchable text\nA useful article: https://example.org/article\nUnsubscribe https://example.org/leave",
      ),
    );
    expect(result.candidate.text).toContain("Plain searchable text");
    expect(result.candidate.text).not.toContain("Unsubscribe");
    expect(result.candidate.children?.map((item) => item.url)).toEqual([
      "https://example.org/article",
    ]);
    expect(result.bodyUnavailable).toBe(false);
    expect(
      normalizeNewsletter(email("<html><body>   </body></html>"))
        .bodyUnavailable,
    ).toBe(true);
  });

  test("preserves balanced URL parentheses and removes surrounding punctuation", () => {
    const result = normalizeNewsletter(
      email(
        null,
        "Read (https://en.wikipedia.org/wiki/Example_(disambiguation)).\nMore https://example.org/story_(part_1)!.",
      ),
    );
    expect(result.candidate.children?.map((item) => item.url)).toEqual([
      "https://en.wikipedia.org/wiki/Example_(disambiguation)",
      "https://example.org/story_(part_1)",
    ]);
  });
});
