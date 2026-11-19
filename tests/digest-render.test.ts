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

test("digest links the title to the primary public source and labels readable sources", () => {
  const output = renderDigest("2026-11-17", [
    {
      itemId: "item-2",
      title: "Robotics update",
      why: "Matches robotics interest",
      summary:
        "First sentence. Second sentence. Third sentence. Fourth sentence about the result.",
      uncertainty: [],
      references: [
        {
          source: "RSS",
          nativeId: "guid-123",
          url: "https://www.example.com/robotics/",
        },
        { source: "Newsletter", nativeId: "message-9", url: null },
      ],
    },
  ]);
  expect(output.html).toContain(
    '<h2><a href="https://www.example.com/robotics/">Robotics update</a></h2>',
  );
  expect(output.html).toContain(">example.com/robotics</a>");
  expect(output.html).not.toContain("guid-123)</a>");
  expect(output.html).toContain("<span>Newsletter (message-9)</span>");
  expect(output.html).toContain("Model summary (estimate)");
  expect(output.html.match(/<p>First sentence/g)).toHaveLength(1);
  // The email keeps the first three sentences; the rest stays in the stored analysis.
  expect(output.html).toContain(
    "First sentence. Second sentence. Third sentence.",
  );
  expect(output.html).not.toContain("Fourth sentence about the result.");
});

test("a longer digest is split into top stories and more coverage", () => {
  const item = (n: number) => ({
    itemId: `item-${n}`,
    title: `Story ${n}`,
    why: "interest:x@1: y",
    summary: "A summary.",
    uncertainty: [],
    references: [],
  });
  const output = renderDigest(
    "2026-11-19",
    Array.from({ length: 7 }, (_, i) => item(i + 1)),
  );
  expect(output.text).toContain("Top stories");
  expect(output.text).toContain("More coverage");
  expect(output.text.indexOf("Story 1")).toBeLessThan(
    output.text.indexOf("More coverage"),
  );
  expect(output.text.indexOf("Story 6")).toBeGreaterThan(
    output.text.indexOf("More coverage"),
  );
  expect(output.html).toContain("<h2>Top stories</h2>");
  expect(output.html).toContain("<h2>More coverage</h2>");
  // A short digest stays a single list without section headings.
  const short = renderDigest("2026-11-19", [item(1), item(2)]);
  expect(short.text).not.toContain("Top stories");
});

test("digest turns internal interest reasons into a match note and hides raw IDs beside public links", () => {
  const output = renderDigest("2026-11-17", [
    {
      itemId: "item-3",
      title: "Agent tooling",
      why: "interest:ai-coding-agents@1: Codex",
      summary: null,
      uncertainty: [],
      references: [
        {
          source: "9c64c499-d0bb-40af-baed-47243e4e0ba7",
          nativeId: "guid-9",
          url: "https://openai.com/index/agents/",
        },
      ],
    },
  ]);
  expect(output.html).toContain("Matched your interest: Codex");
  expect(output.html).not.toContain("interest:ai-coding-agents@1");
  expect(output.html).not.toContain("9c64c499-d0bb-40af-baed-47243e4e0ba7");
  expect(output.html).toContain(">openai.com/index/agents</a>");
  expect(output.text).toContain("Matched your interest: Codex");
  expect(output.text).toContain("Sources: https://openai.com/index/agents/");
});

test("digest shows at most three trimmed uncertainty notes", () => {
  const output = renderDigest("2026-11-17", [
    {
      itemId: "item-4",
      title: "Verbose caveats",
      why: "interest:x@1: y",
      summary: "A summary.",
      uncertainty: ["One", "  ", "Two", "Three", "Four", "Five"],
      references: [],
    },
  ]);
  expect(output.text).toContain("Model uncertainty:\n- One\n- Two\n- Three");
  expect(output.text).not.toContain("Four");
  expect(output.html).not.toContain("<li>Four</li>");
});

test("digest lists key points and hides interest IDs for multi-interest matches", () => {
  const output = renderDigest("2026-11-18", [
    {
      itemId: "item-5",
      title: "Multi match",
      why: "interest:developer-tooling@1: self-hosted; interest:llm-models-evaluation@1: model routing",
      summary: "A summary.",
      keyPoints: [
        "First claim",
        "  ",
        "Second claim",
        "Third claim",
        "Fourth claim",
      ],
      uncertainty: [],
      references: [],
    },
  ]);
  expect(output.text).toContain(
    "Matched your interest: self-hosted, model routing",
  );
  expect(output.text).not.toMatch(/interest:[a-z-]+@/);
  expect(output.text).toContain(
    "Key points:\n- First claim\n- Second claim\n- Third claim",
  );
  expect(output.text).not.toContain("Fourth claim");
  expect(output.html).toContain("<li>Third claim</li>");
  expect(output.html).not.toContain("Fourth claim");
});

test("digest labels a cited source with its own title", () => {
  const output = renderDigest("2026-11-19", [
    {
      itemId: "item-6",
      title: "Main story",
      why: "interest:x@1: y",
      summary: "A summary.",
      uncertainty: [],
      references: [
        {
          source: "s1",
          nativeId: "n1",
          url: "https://example.com/main",
          title: "Main story",
        },
        {
          source: "s2",
          nativeId: "n2",
          url: "https://other.com/coverage",
          title: "Other coverage of the story",
        },
      ],
    },
  ]);
  expect(output.html).toContain(">Other coverage of the story</a>");
  expect(output.text).toContain(
    "Other coverage of the story — https://other.com/coverage",
  );
  // The story's own citation keeps the readable link label.
  expect(output.text).toContain("Sources: https://example.com/main");
});
