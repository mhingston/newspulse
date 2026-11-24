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
  expect(output.html).toContain('href="https://example.com/a?x=1&amp;y=2"');
  expect(output.html).not.toContain("Caveats");
  expect(output.html).not.toContain("Sources");
  expect(output.html).not.toContain("Evidence unavailable");
  expect(output.feedbackTargets).toEqual([
    { itemId: "item-1", actions: ["useful", "not_useful"] },
  ]);
  expect(output.text).not.toContain("Caveats");
  expect(output.text).not.toContain("Sources:");
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
    '<h3><a href="https://www.example.com/robotics/">Robotics update</a></h3>',
  );
  expect(output.html).not.toContain("example.com/robotics</a>");
  expect(output.html).not.toContain("Newsletter (message-9)");
  expect(output.html).not.toContain("Model summary");
  expect(output.html.match(/<p>First sentence/g)).toHaveLength(1);
  // A summary is shown whole, up to a bound, so the reader gets the full analysis.
  expect(output.html).toContain(
    "<p>First sentence. Second sentence. Third sentence.</p>",
  );
  expect(output.html).toContain("<p>Fourth sentence about the result.</p>");
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
  expect(output.text).toContain("Top Stories");
  expect(output.text).toContain("More Coverage");
  expect(output.text.indexOf("Story 1")).toBeLessThan(
    output.text.indexOf("More Coverage"),
  );
  expect(output.text.indexOf("Story 6")).toBeGreaterThan(
    output.text.indexOf("More Coverage"),
  );
  expect(output.html).toContain(">Top Stories</h2>");
  expect(output.html).toContain(">More Coverage</h2>");
  // A short digest stays a single list without section headings.
  const short = renderDigest("2026-11-19", [item(1), item(2)]);
  expect(short.text).not.toContain("Top Stories");
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
  expect(output.html).not.toContain("Matched your interest");
  expect(output.html).not.toContain("interest:ai-coding-agents@1");
  expect(output.html).not.toContain("9c64c499-d0bb-40af-baed-47243e4e0ba7");
  expect(output.html).toContain('href="https://openai.com/index/agents/"');
  expect(output.html).not.toContain("9c64c499-d0bb-40af-baed-47243e4e0ba7");
  expect(output.text).not.toContain("Matched your interest");
  expect(output.text).not.toContain("interest:ai-coding-agents@1");
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
        "Fifth claim",
        "Sixth claim",
      ],
      uncertainty: [],
      references: [],
    },
  ]);
  expect(output.text).not.toContain("Matched your interest");
  expect(output.text).not.toMatch(/interest:[a-z-]+@/);
  expect(output.text).toContain(
    "- First claim\n- Second claim\n- Third claim\n- Fourth claim\n- Fifth claim",
  );
  expect(output.text).not.toContain("Sixth claim");
  expect(output.html).toContain("<li>Fifth claim</li>");
  expect(output.html).not.toContain("Sixth claim");
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
  // The heading links to the first public citation; the other sources are not listed.
  expect(output.html).toContain(
    '<h3><a href="https://example.com/main">Main story</a></h3>',
  );
  expect(output.html).not.toContain("Other coverage of the story");
  expect(output.text).not.toContain("Sources:");
});

test("story headings sit under the section heading and the match note stays short", () => {
  const output = renderDigest("2026-11-19", [
    {
      itemId: "item-9",
      title: "Story",
      why: "interest:a@1: one; interest:b@1: two; interest:c@1: three; interest:d@1: four",
      summary: null,
      uncertainty: [],
      references: [],
    },
  ]);
  expect(output.html).toContain("<h3>Story</h3>");
  expect(output.html).not.toContain("Matched your interest");
  expect(output.text).not.toContain("Matched your interest");
  expect(output.text).not.toContain("four");
});

test("a citation without a public link keeps its source name and native id", () => {
  const output = renderDigest("2026-11-19", [
    {
      itemId: "item-10",
      title: "Email-only story",
      why: "interest:a@1: reading",
      summary: null,
      uncertainty: [],
      references: [
        {
          source: "d6c299e0-b722-459d-90b6-9c943142dc95",
          nativeId: "4c49e37a-8f3a-4b0f-b9fb-452e2124cca5",
          url: null,
        },
      ],
    },
  ]);
  expect(output.text).toBe("Newspulse — 2026-11-19\n\nEmail-only story");
  expect(output.html).not.toContain("d6c299e0-b722-459d-90b6-9c943142dc95");
});

test("a roundup parent lists its fanned-out public links without feedback targets for them", () => {
  const output = renderDigest("2026-11-23", [
    {
      itemId: "parent-1",
      title: "Weekly roundup",
      why: "Roundup of tools",
      summary: "Several tools this week.",
      uncertainty: [],
      references: [],
      roundup: [
        { url: "https://example.com/a", title: "Tool A" },
        { url: "javascript:alert(1)", title: "Unsafe" },
        { url: "https://example.com/a", title: "Tool A again" },
      ],
    },
  ]);
  expect(output.html).toContain("From this roundup");
  expect(output.html).toContain('href="https://example.com/a">Tool A</a>');
  expect(output.html).not.toContain("javascript:");
  expect(output.text).toContain("From this roundup:");
  expect(output.text).toContain("- Tool A — https://example.com/a");
  expect(output.feedbackTargets.map((target) => target.itemId)).toEqual([
    "parent-1",
  ]);
});

test("a URL-only title is shown as a readable source, never as a raw link", () => {
  const output = renderDigest("2026-11-24", [
    {
      itemId: "item-url",
      title: "https://martinfowler.com/bliki/ExtremeProgramming.html",
      why: "interest:x@1: y",
      summary: "A summary.",
      uncertainty: [],
      references: [
        {
          source: "s1",
          nativeId: "n1",
          url: "https://martinfowler.com/bliki/ExtremeProgramming.html",
        },
      ],
    },
  ]);
  expect(output.html).not.toContain(">https://");
  expect(output.html).toContain(
    '<h3><a href="https://martinfowler.com/bliki/ExtremeProgramming.html">ExtremeProgramming — martinfowler.com</a></h3>',
  );
  expect(output.text).toContain("ExtremeProgramming — martinfowler.com");
  expect(output.text).not.toMatch(/^https:\/\//m);
});

test("a two-paragraph summary is shown in full and an over-long one is bounded at a sentence", () => {
  const first = "The release adds a new evaluation harness for agents.";
  const second = "It reports pass rates by task family and flags grader bias.";
  const twoParagraphs = renderDigest("2026-11-24", [
    {
      itemId: "item-long",
      title: "Two paragraphs",
      why: "interest:x@1: y",
      summary: `${first} It matters for teams.\n\n${second}`,
      uncertainty: [],
      references: [],
    },
  ]);
  expect(twoParagraphs.html).toContain(`<p>${first} It matters for teams.</p>`);
  expect(twoParagraphs.html).toContain(`<p>${second}</p>`);

  const sentence =
    "This sentence adds a fixed amount of detail to the summary. ";
  const huge = renderDigest("2026-11-24", [
    {
      itemId: "item-huge",
      title: "Huge",
      why: "interest:x@1: y",
      summary: sentence.repeat(60),
      uncertainty: [],
      references: [],
    },
  ]);
  const paragraph = /<p>([\s\S]*?)<\/p>/.exec(huge.html)![1]!;
  expect(paragraph.length).toBeLessThanOrEqual(1200);
  expect(paragraph.endsWith(".")).toBe(true);
});
