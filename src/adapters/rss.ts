import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  canonicalUrl,
  type Candidate,
  type PollState,
  type PollResult,
  type SourceAdapter,
} from "../domain";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: true,
  parseTagValue: false,
});
export const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const value = (v: any): string =>
  typeof v === "string" ? v : (v?.["#text"] ?? "");
export function cleanText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
function urlOrUndefined(s: string, base: string): string | undefined {
  try {
    return s ? canonicalUrl(s, base) : undefined;
  } catch {
    return undefined;
  }
}
export function parseFeed(xml: string, base: string): Candidate[] {
  if (XMLValidator.validate(xml) !== true || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Invalid or unsafe feed XML");
  const doc = parser.parse(xml);
  const atom = !!doc.feed;
  if (!atom && !doc.rss?.channel && !doc["rdf:RDF"])
    throw new Error("Expected RSS or Atom feed");
  const entries = list<any>(
    atom ? doc.feed.entry : (doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item),
  );
  return entries.slice(0, 1000).map((e) => {
    const link = atom
      ? value(
          list<any>(e.link).find(
            (l) => !l["@_rel"] || l["@_rel"] === "alternate",
          )?.["@_href"],
        )
      : value(e.link);
    const url = urlOrUndefined(link, base);
    const html = value(
      e["content:encoded"] ?? e.content ?? e.description ?? e.summary,
    );
    const title = cleanText(value(e.title)) || url || "Untitled";
    const date = Date.parse(
      value(e.pubDate ?? e.published ?? e.updated ?? e["dc:date"]),
    );
    const nativeId =
      value(e.guid ?? e.id) ||
      url ||
      `sha256:${createHash("sha256")
        .update(title + "\n" + html)
        .digest("hex")}`;
    const links = new Map<string, string>();
    for (const m of html.matchAll(
      /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      const href = urlOrUndefined(m[1]!, url ?? base);
      if (href && href !== url) links.set(href, cleanText(m[2]!) || href);
    }
    // Conservative digest detection: several links across multiple publishers.
    const children =
      links.size >= 5 &&
      new Set([...links.keys()].map((x) => new URL(x).hostname)).size >= 3
        ? [...links].slice(0, 50).map(([url, title]) => ({ url, title }))
        : [];
    return {
      nativeId,
      url,
      title,
      text: cleanText(html),
      publishedAt: Number.isFinite(date) ? date : undefined,
      children,
    };
  });
}
export class HttpError extends Error {
  constructor(
    message: string,
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}
export class RssAdapter implements SourceAdapter {
  constructor(
    private fetcher: (
      input: string,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}
  async poll(url: string, state: PollState): Promise<PollResult> {
    const headers: Record<string, string> = {
      "user-agent": "Newspulse/0.1 (+https://github.com/mhingston/newspulse)",
      accept:
        "application/atom+xml, application/rss+xml, application/xml, text/xml",
    };
    if (state.etag) headers["if-none-match"] = state.etag;
    if (state.lastModified) headers["if-modified-since"] = state.lastModified;
    const response = await this.fetcher(url, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 304)
      return { items: [], notModified: true, ...state };
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      const delay = retry
        ? /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now()
        : 0;
      await response.body?.cancel();
      throw new HttpError(
        `Feed HTTP ${response.status}`,
        Math.max(0, Math.min(delay || 0, 86400_000)),
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty feed body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 5_000_000) throw new Error("Feed exceeds 5 MB budget");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    return {
      items: parseFeed(new TextDecoder().decode(bytes), response.url || url),
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
    };
  }
}
