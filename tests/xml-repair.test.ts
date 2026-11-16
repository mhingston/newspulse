import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { parseFeed, RssAdapter } from "../src/adapters/rss";
import { repairBareAmpersands, validateXml } from "../src/adapters/feed-xml";

const fixture = readFileSync(
  new URL("./fixtures/bare-ampersand-feed.xml", import.meta.url),
  "utf8",
);
const feed = (description: string) =>
  `<rss version="2.0"><channel><title>t</title><item><title>x</title><link>https://example.com/a</link><guid>g</guid><description>${description}</description></item></channel></rss>`;

test("bare ampersands are repaired and the feed keeps its entries", async () => {
  const items = parseFeed(fixture, "https://example.com/feed");
  expect(items).toHaveLength(2);
  expect(items[0]!.title).toBe("Strategy & delivery");
  expect(items[0]!.text).toContain(
    "set & execute your enterprise AI strategy & roadmap",
  );
  expect(items[1]!.text).toContain("Raw & kept inside CDATA");
  expect(parseFeed(fixture, "https://example.com/feed")[1]!.url).toBe(
    "https://example.com/numeric",
  );

  const adapter = new RssAdapter(async () => new Response(fixture));
  const result = await adapter.poll("https://example.com/feed", {});
  expect(result.items).toHaveLength(2);
  expect(result.xmlRepairs).toBe(2);
});

test("valid references, CDATA and comments are not double-escaped", () => {
  const valid = `<rss><channel><!-- A & B --><item><title>&amp;&lt;&#38;&#x26;</title><description><![CDATA[a & b]]></description></item></channel></rss>`;
  expect(validateXml(valid)).toEqual({ xml: valid, repairs: 0 });
  const bare = `<a>x & y &amp; <![CDATA[z & w]]> <!-- q & r --></a>`;
  expect(repairBareAmpersands(bare)).toEqual({
    xml: `<a>x &amp; y &amp; <![CDATA[z & w]]> <!-- q & r --></a>`,
    repairs: 1,
  });
  expect(repairBareAmpersands("&#0038; &#x26; &apos;")).toEqual({
    xml: "&#0038; &#x26; &apos;",
    repairs: 0,
  });
});

test("unknown named references are escaped rather than left undeclared", () => {
  expect(repairBareAmpersands("a &nbsp; b").xml).toBe("a &amp;nbsp; b");
});

test("bare ampersands inside attribute values are escaped consistently", () => {
  const xml = `<rss><channel><item><link href="https://example.com/?a=1&b=2">x</link><description>x & y</description></item></channel></rss>`;
  const repaired = validateXml(xml);
  expect(repaired.repairs).toBe(2);
  expect(repaired.xml).toContain("x &amp; y");
  expect(repaired.xml).toContain('href="https://example.com/?a=1&amp;b=2"');
});

test("other malformations still fail closed", () => {
  const unclosed = feed("bad & text").replace("</item>", "");
  expect(() => validateXml(unclosed)).toThrow("Invalid or unsafe feed XML");
  expect(() => parseFeed(unclosed, "https://example.com/feed")).toThrow(
    "Invalid or unsafe feed XML",
  );
  expect(() => validateXml("<rss><channel></rss>")).toThrow(
    "Invalid or unsafe feed XML",
  );
});

test("DOCTYPE and ENTITY feeds are rejected even when otherwise repairable", () => {
  const withDoctype = `<!DOCTYPE rss [<!ENTITY x "y">]>${feed("bare & here")}`;
  expect(() => validateXml(withDoctype)).toThrow("Invalid or unsafe feed XML");
  const withEntity = feed("a & b").replace("<rss", '<!ENTITY x "y"><rss');
  expect(() => validateXml(withEntity)).toThrow("Invalid or unsafe feed XML");
});

test("a well-formed feed reports zero repairs", async () => {
  const adapter = new RssAdapter(
    async () => new Response(feed("plain &amp; text")),
  );
  const result = await adapter.poll("https://example.com/feed", {});
  expect(result.xmlRepairs).toBe(0);
});

test("repair count is exposed in feed diagnostics and survives a 304", async () => {
  const { Store } = await import("../src/db/store");
  const store = new Store(":memory:");
  const source = store.addSource("https://example.test/feed");
  store.enqueueDue(1);
  const adapter = new RssAdapter(async () => new Response(fixture));
  store.complete(
    store.claim(1)!,
    await adapter.poll("https://example.test/feed", {}),
    2,
  );
  store.enqueueDue(3, true);
  store.complete(store.claim(3)!, { items: [], notModified: true }, 4);
  expect(
    store.status().sources.find((s) => s.id === source.id)?.feed_diagnostics,
  ).toMatchObject({ entry_count: 2, xml_repairs: 2 });
  store.close();
});
