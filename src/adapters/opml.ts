import { XMLParser, XMLValidator } from "fast-xml-parser";
import { canonicalUrl } from "../domain";
import { list } from "./rss";
export function parseOpml(xml: string): { url: string; title: string }[] {
  if (XMLValidator.validate(xml) !== true || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Invalid or unsafe OPML");
  const doc = new XMLParser({ ignoreAttributes: false }).parse(xml);
  if (!doc.opml?.body) throw new Error("Expected OPML body");
  const feeds = new Map<string, { url: string; title: string }>();
  function walk(nodes: any): void {
    for (const n of list<any>(nodes)) {
      if (n["@_xmlUrl"]) {
        const url = canonicalUrl(n["@_xmlUrl"]);
        feeds.set(url, {
          url,
          title: String(n["@_title"] ?? n["@_text"] ?? url),
        });
      }
      if (n.outline) walk(n.outline);
    }
  }
  walk(doc.opml.body.outline);
  return [...feeds.values()];
}
const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
export function exportOpml(sources: { url: string; title: string }[]): string {
  return `<?xml version="1.0"?><opml version="2.0"><head><title>Newspulse</title></head><body>${sources.map((s) => `<outline type="rss" text="${escape(s.title)}" xmlUrl="${escape(s.url)}"/>`).join("")}</body></opml>`;
}
