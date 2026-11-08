import { test, expect } from "bun:test";
import { config } from "../src/config";
import { identity } from "../src/domain";
import { parseFeed, RssAdapter } from "../src/adapters/rss";
import { Store } from "../src/db/store";

const atomNs = "http://www.w3.org/2005/Atom";
const xhtmlNs = "http://www.w3.org/1999/xhtml";
const links = Array.from(
  { length: 6 },
  (_, i) =>
    `<a href="https://publisher${i % 3}.example/article?id=${i}&amp;page=2#results">Article ${i}</a>`,
).join("");

test("copied environment template fails startup validation until a token is supplied", async () => {
  const example = await Bun.file(
    new URL("../.env.example", import.meta.url),
  ).text();
  const token = example.match(/^MCP_TOKEN=(.*)$/m)![1]!;
  expect(token).toBe("");
  expect(() => config({ MCP_TOKEN: token })).toThrow();
  expect(() => config({})).toThrow();
  expect(() => config({ MCP_TOKEN: "short" })).toThrow();
  expect(() => config({ MCP_TOKEN: " ".repeat(32) })).toThrow();
  expect(config({ MCP_TOKEN: crypto.randomUUID() }).MCP_TOKEN).toHaveLength(36);
});

test("canonical identity retains distinct original resolved source citations", () => {
  const first = parseFeed(
    "<rss><channel><item><guid>a</guid><title>Paper</title><link>../paper?id=1&amp;utm_source=rss#results</link></item></channel></rss>",
    "https://example.com/feeds/rss",
  )[0]!;
  const second = parseFeed(
    `<feed xmlns="${atomNs}"><entry><id>b</id><title>Paper</title><link href="https://example.com/paper?id=1#methods"/></entry></feed>`,
    "https://other.example/atom",
  )[0]!;
  expect(first.url).toBe("https://example.com/paper?id=1");
  expect(first.sourceUrl).toBe(
    "https://example.com/paper?id=1&utm_source=rss#results",
  );
  expect(identity(first, "one")).toBe(identity(second, "two"));
  const store = new Store(":memory:");
  try {
    const a = store.addSource("https://example.com/feeds/rss");
    store.enqueueDue(100);
    store.complete(store.claim(100)!, { items: [first] }, 101);
    const b = store.addSource("https://other.example/atom");
    store.enqueueDue(102);
    store.complete(store.claim(102)!, { items: [second] }, 103);
    const item = store.getItem(store.search("Paper")[0]!.id)!;
    expect(store.search("Paper")).toHaveLength(1);
    expect(
      (item.references as { url: string }[]).map((r) => r.url).sort(),
    ).toEqual([first.sourceUrl, second.sourceUrl].sort() as string[]);
    expect(store.sources().map((s) => s.id)).toContain(a.id);
    expect(store.sources().map((s) => s.id)).toContain(b.id);
  } finally {
    store.close();
  }
});

test("prefixed Atom uses namespace identity while namespaced RSS extensions stay intact", () => {
  const xml = `<a:feed xmlns:a="${atomNs}" xmlns:foreign="urn:foreign"><a:entry><foreign:title>Wrong title</foreign:title><a:id>urn:paper:1</a:id><a:title>Prefixed paper</a:title><a:link href="https://example.com/paper"/><a:published>2026-11-08T09:00:00Z</a:published><a:content type="html">&lt;p&gt;Namespace-aware robotics text&lt;/p&gt;</a:content></a:entry></a:feed>`;
  const item = parseFeed(xml, "https://example.com/feed")[0]!;
  expect(item.title).toBe("Prefixed paper");
  expect(item.nativeId).toBe("urn:paper:1");
  expect(item.text).toContain("Namespace-aware robotics");
  expect(item.publishedAt).toBe(Date.parse("2026-11-08T09:00:00Z"));
  const rss = parseFeed(
    '<rss xmlns:c="http://purl.org/rss/1.0/modules/content/" xmlns:d="http://purl.org/dc/elements/1.1/"><channel><item><guid>rss-1</guid><title>RSS extension</title><description>Fallback</description><c:encoded><![CDATA[<p>Full encoded body</p>]]></c:encoded><d:date>2026-11-08T10:00:00Z</d:date></item></channel></rss>',
    "https://example.com/feed",
  )[0]!;
  expect(rss.text).toBe("Full encoded body");
  expect(rss.publishedAt).toBe(Date.parse("2026-11-08T10:00:00Z"));
});

test("Atom XHTML preserves mixed text and digest links and external content uses summary", () => {
  const xml = `<a:feed xmlns:a="${atomNs}" xmlns:x="${xhtmlNs}"><a:entry><a:id>xhtml</a:id><a:title type="xhtml"><x:div>A <x:b>rich</x:b> title</x:div></a:title><a:content type="xhtml"><x:div>Before <x:b>bold</x:b> after.${links.replaceAll("<a ", "<x:a ").replaceAll("</a>", "</x:a>")}</x:div></a:content></a:entry><a:entry><a:id>external</a:id><a:title>External content</a:title><a:content src="https://example.com/body"/><a:summary type="html">&lt;p&gt;Searchable summary fallback&lt;/p&gt;</a:summary></a:entry><a:entry><a:id>plain</a:id><a:title>Plain title</a:title><a:content type="text">Literal &lt;T&gt; &amp; text</a:content></a:entry></a:feed>`;
  const items = parseFeed(xml, "https://example.com/feed");
  expect(items[0]!.title).toBe("A rich title");
  expect(items[0]!.text).toStartWith("Before bold after.");
  expect(items[0]!.children).toHaveLength(6);
  expect(items[1]!.text).toBe("Searchable summary fallback");
  expect(items[2]!.text).toBe("Literal <T> & text");
  const store = new Store(":memory:");
  try {
    store.addSource("https://example.com/feed");
    store.enqueueDue(100);
    store.complete(store.claim(100)!, { items }, 101);
    expect(store.search("bold")).toHaveLength(1);
    expect(store.search("fallback")).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("RSS CDATA and Atom HTML digest attributes decode entities before URL resolution", () => {
  const bodies = [
    `<rss><channel><item><guid>digest</guid><title>Digest</title><description><![CDATA[${links}]]></description></item></channel></rss>`,
    `<feed xmlns="${atomNs}"><entry><id>digest</id><title>Digest</title><content type="html">${links.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</content></entry></feed>`,
  ];
  for (const xml of bodies) {
    const item = parseFeed(xml, "https://example.com/feed")[0]!;
    expect(item.children).toHaveLength(6);
    expect(item.children![0]!.url).toBe(
      "https://publisher0.example/article?id=0&page=2",
    );
    expect(item.children![0]!.sourceUrl).toBe(
      "https://publisher0.example/article?id=0&page=2#results",
    );
    const store = new Store(":memory:");
    try {
      store.addSource("https://example.com/feed");
      store.enqueueDue(100);
      store.complete(store.claim(100)!, { items: [item] }, 101);
      const article = store.search("Article 0")[0]!;
      const reference = store.getItem(article.id)!.references as {
        url: string;
        parent_item_id: string | null;
      }[];
      expect(
        reference.some(
          (r) =>
            r.url === item.children![0]!.sourceUrl && r.parent_item_id !== null,
        ),
      ).toBe(true);
    } finally {
      store.close();
    }
  }
  const numeric = links
    .replaceAll("&amp;", "&#38;")
    .replaceAll("page=2", "page=&#50;");
  expect(
    parseFeed(
      `<rss><channel><item><description><![CDATA[${numeric}]]></description></item></channel></rss>`,
      "https://example.com",
    )[0]!.children![0]!.url,
  ).toBe("https://publisher0.example/article?id=0&page=2");
});

function encodedFeed(encoding: string) {
  return `<?xml version="1.0" encoding="${encoding}"?><rss><channel><item><guid>encoded</guid><title>Café robotics</title><description>Résumé of the research</description></item></channel></rss>`;
}
function utf16be(xml: string) {
  const bytes = Buffer.from(xml, "utf16le");
  bytes.swap16();
  return bytes;
}
const encodingCases = [
  {
    name: "UTF-16LE BOM overrides conflicting HTTP/declaration",
    bytes: Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(encodedFeed("UTF-8"), "utf16le"),
    ]),
    contentType: "application/rss+xml; charset=iso-8859-1",
  },
  {
    name: "UTF-16BE BOM",
    bytes: Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      utf16be(encodedFeed("UTF-16")),
    ]),
    contentType: "application/atom+xml",
  },
  {
    name: "UTF-16BE autodetection",
    bytes: utf16be(encodedFeed("UTF-16BE")),
    contentType: "application/xml",
  },
  {
    name: "ISO-8859-1 XML declaration",
    bytes: Buffer.from(encodedFeed("ISO-8859-1"), "latin1"),
    contentType: "application/rss+xml",
  },
  {
    name: "HTTP charset overrides declaration without BOM",
    bytes: Buffer.from(encodedFeed("UTF-8"), "latin1"),
    contentType: 'text/xml; charset="ISO-8859-1"',
  },
  {
    name: "UTF-8 BOM overrides conflicting charset",
    bytes: Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(encodedFeed("UTF-8")),
    ]),
    contentType: "application/xml; charset=iso-8859-1",
  },
];
for (const c of encodingCases)
  test(`feed encoding: ${c.name}`, async () => {
    const adapter = new RssAdapter(
      async () =>
        new Response(c.bytes, { headers: { "content-type": c.contentType } }),
    );
    const result = await adapter.poll("https://example.com/feed", {});
    expect(result.items[0]!.title).toBe("Café robotics");
    expect(result.items[0]!.text).toBe("Résumé of the research");
  });
test("unsupported and invalid feed encodings fail with actionable diagnostics", async () => {
  const unsupported = new RssAdapter(
    async () => new Response(encodedFeed("not-an-encoding")),
  );
  await expect(
    unsupported.poll("https://example.com/feed", {}),
  ).rejects.toThrow("Unsupported feed encoding");
  const invalid = new RssAdapter(
    async () =>
      new Response(new Uint8Array([0x3c, 0xff, 0x3e]), {
        headers: { "content-type": "application/xml; charset=utf-8" },
      }),
  );
  await expect(invalid.poll("https://example.com/feed", {})).rejects.toThrow(
    "Invalid feed bytes",
  );
});

test("publisher feed fills a digest placeholder date without overwriting an existing date", () => {
  const store = new Store(":memory:");
  try {
    store.addSource("https://digest.example/feed");
    store.enqueueDue(100);
    store.complete(
      store.claim(100)!,
      {
        items: [
          {
            nativeId: "digest",
            title: "Digest",
            text: "Links",
            children: [{ url: "https://example.com/story", title: "Story" }],
          },
        ],
      },
      101,
    );
    store.addSource("https://publisher.example/feed");
    store.enqueueDue(102);
    store.complete(
      store.claim(102)!,
      {
        items: [
          {
            nativeId: "article",
            title: "Story",
            url: "https://example.com/story",
            text: "Robotics report",
            publishedAt: 12345,
          },
        ],
      },
      103,
    );
    const item = store.search("Robotics")[0]!;
    expect(store.getItem(item.id)!.published_at).toBe(12345);
    store.addSource("https://third.example/feed");
    store.enqueueDue(104);
    store.complete(
      store.claim(104)!,
      {
        items: [
          {
            nativeId: "copy",
            title: "Story",
            url: "https://example.com/story",
            text: "Robotics report",
            publishedAt: 99999,
          },
        ],
      },
      105,
    );
    expect(store.getItem(item.id)!.published_at).toBe(12345);
  } finally {
    store.close();
  }
});

test("HTTP draining cannot postpone scheduler cancellation or close SQLite early", async () => {
  const { schedule, Worker } = await import("../src/worker");
  const { stopServices } = await import("../src/lifecycle");
  const store = new Store(":memory:");
  let finishPoll!: () => void;
  let finishHttp!: () => void;
  const pollBlocked = new Promise<void>((r) => {
    finishPoll = r;
  });
  const httpBlocked = new Promise<void>((r) => {
    finishHttp = r;
  });
  let calls = 0;
  let closed = false;
  try {
    store.addSource("https://one.example/feed");
    store.addSource("https://two.example/feed");
    const active = schedule(
      store,
      new Worker(store, {
        async poll() {
          calls++;
          await pollBlocked;
          return { items: [] };
        },
      }),
    );
    expect(calls).toBe(1);
    const stopping = stopServices({ stop: () => httpBlocked }, active, {
      close() {
        closed = true;
      },
    });
    finishPoll();
    await active.stop();
    expect(calls).toBe(1);
    expect(closed).toBe(false);
    expect(
      store.sqlite
        .query("SELECT count(*) AS count FROM jobs WHERE status='pending'")
        .get(),
    ).toEqual({ count: 1 });
    finishHttp();
    await stopping;
    expect(closed).toBe(true);
  } finally {
    finishPoll();
    finishHttp();
    store.close();
  }
});
