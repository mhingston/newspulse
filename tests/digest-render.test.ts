import { expect, test } from "bun:test";
import { renderDigest } from "../src/digest-render";

test("digest escapes untrusted content, retains original citations and URL-less identities", () => {
  const output = renderDigest("2026-11-09", [
    {
      itemId: "item-1",
      title: "<script>alert(1)</script>",
      why: "Why <important>",
      summary: "<img src=x onerror=alert(1)>",
      uncertainty: ["<script>uncertain</script>", "Evidence unavailable"],
      references: [
        {
          source: "News & Co",
          nativeId: "one",
          url: "https://example.com/a?x=1&y=2",
        },
        { source: "Newsletter", nativeId: "message-2", url: null },
        { source: "Bad", nativeId: "bad", url: "javascript:alert(1)" },
      ],
    },
  ]);
  expect(output.html).not.toContain("<script>");
  expect(output.html).not.toContain("<img");
  expect(output.html).not.toContain('href="javascript:');
  expect(output.html).toContain("https://example.com/a?x=1&amp;y=2");
  expect(output.html).toContain("Newsletter (message-2)");
  expect(output.html).toContain("Model uncertainty:");
  expect(output.html).toContain("&lt;script&gt;uncertain&lt;/script&gt;");
  expect(output.text).toContain(
    "Model uncertainty:\n- <script>uncertain</script>\n- Evidence unavailable",
  );
  expect(output.feedbackTargets).toEqual([
    { itemId: "item-1", actions: ["useful", "not_useful"] },
  ]);
  expect(output.text).toContain("https://example.com/a?x=1&y=2");
});
