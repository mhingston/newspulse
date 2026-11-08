import { createHash } from "node:crypto";
import { decodeHTML, decodeHTMLAttribute } from "entities";
import {
  parseXml,
  child,
  childElements,
  xmlText,
  xhtmlMarkup,
  type XmlElement,
} from "./feed-xml";
import { decodeFeed } from "./feed-encoding";
import {
  canonicalUrl,
  resolvedUrl,
  type Candidate,
  type PollState,
  type PollResult,
  type SourceAdapter,
} from "../domain";
export const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();
export function cleanText(html: string): string {
  return normalizeText(
    decodeHTML(
      html
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}
function urlOrUndefined(s: string, base: string): string | undefined {
  try {
    return s ? resolvedUrl(s, base) : undefined;
  } catch {
    return undefined;
  }
}
interface TextConstruct {
  html: string;
  text: string;
}
function atomText(node: XmlElement | undefined): TextConstruct {
  if (!node || node.attributes.src) return { html: "", text: "" };
  const type = node.attributes.type ?? "text";
  if (type === "xhtml" || type === "application/xhtml+xml") {
    const html = xhtmlMarkup(node);
    return { html, text: cleanText(html) };
  }
  if (type === "html" || type === "text/html") {
    const html = xmlText(node);
    return { html, text: cleanText(html) };
  }
  if (type === "text" || type === "text/plain")
    return { html: "", text: normalizeText(xmlText(node)) };
  return { html: "", text: "" };
}
export function parseFeed(xml: string, base: string): Candidate[] {
  const root = parseXml(xml, base);
  const atom =
    root.name === "feed" &&
    (root.namespace === "http://www.w3.org/2005/Atom" || root.namespace === "");
  const channel = root.name === "rss" ? child(root, "channel") : undefined;
  const rdf =
    root.name === "RDF" &&
    root.namespace === "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  if (!atom && !channel && !rdf) throw new Error("Expected RSS or Atom feed");
  const entries = atom
    ? childElements(root, "entry")
    : channel
      ? childElements(channel, "item")
      : childElements(root, "item", "http://purl.org/rss/1.0/");
  return entries.slice(0, 1000).map((e) => {
    const linkNode = atom
      ? childElements(e, "link").find(
          (l) => !l.attributes.rel || l.attributes.rel === "alternate",
        )
      : child(e, "link");
    const sourceUrl = urlOrUndefined(
      atom ? (linkNode?.attributes.href ?? "") : xmlText(linkNode),
      linkNode?.base ?? e.base,
    );
    const url = sourceUrl ? canonicalUrl(sourceUrl) : undefined;
    const contentNode = atom ? child(e, "content") : undefined;
    const inline = atom ? atomText(contentNode) : undefined;
    const summaryNode = atom ? child(e, "summary") : undefined;
    const body: TextConstruct = atom
      ? inline?.text
        ? inline
        : atomText(summaryNode)
      : (() => {
          const html = xmlText(
            child(e, "encoded", "http://purl.org/rss/1.0/modules/content/") ??
              child(e, "content") ??
              child(e, "description") ??
              child(e, "summary"),
          );
          return { html, text: cleanText(html) };
        })();
    const title =
      (atom
        ? atomText(child(e, "title")).text
        : cleanText(xmlText(child(e, "title")))) ||
      url ||
      "Untitled";
    const date = Date.parse(
      xmlText(
        child(e, atom ? "published" : "pubDate") ??
          child(e, "updated") ??
          child(e, "date", "http://purl.org/dc/elements/1.1/"),
      ),
    );
    const nativeId =
      xmlText(child(e, atom ? "id" : "guid")).trim() ||
      url ||
      `sha256:${createHash("sha256")
        .update(title + "\n" + (body.html || body.text))
        .digest("hex")}`;
    const links = new Map<
      string,
      { url: string; sourceUrl: string; title: string }
    >();
    const linkBase = atom
      ? ((inline?.text ? contentNode : summaryNode)?.base ?? e.base)
      : (sourceUrl ?? e.base);
    for (const m of body.html.matchAll(
      /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      const original = urlOrUndefined(decodeHTMLAttribute(m[1]!), linkBase);
      if (!original) continue;
      const canonical = canonicalUrl(original);
      if (canonical !== url && !links.has(canonical))
        links.set(canonical, {
          url: canonical,
          sourceUrl: original,
          title: cleanText(m[2]!) || original,
        });
    }
    const children =
      links.size >= 5 &&
      new Set([...links.keys()].map((x) => new URL(x).hostname)).size >= 3
        ? [...links.values()].slice(0, 50)
        : [];
    return {
      nativeId,
      url,
      sourceUrl,
      title,
      text: body.text,
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
      items: parseFeed(
        decodeFeed(bytes, response.headers.get("content-type")),
        response.url || url,
      ),
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
    };
  }
}
