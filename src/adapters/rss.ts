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
// RDF identifiers are URI references, not necessarily fetchable HTTP URLs.
function identifierOrUndefined(s: string, base: string): string | undefined {
  const value = s.trim();
  if (!value) return undefined;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
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
const MEDIA_NS = "http://search.yahoo.com/mrss/";
const CHILD_OPAQUE_OR_AD_HOSTS =
  /(?:^|\.)(?:list-manage\.com|mailchi\.mp|click\.redditmail\.com|email\.mg\.substack\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|adnxs\.com|taboola\.com|outbrain\.com|t\.co)$/i;
const CHILD_SOCIAL_HOSTS =
  /(?:^|\.)(?:linkedin\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|youtube\.com|threads\.net|bsky\.app)$/i;
const CHILD_CHROME_PATH =
  /(?:^|[\/_.-])(unsubscribe|optout|preferences|privacy|terms|login|signin|signup|account|pricing|careers|advertise|sponsor|tracking|track|pixel|beacon)(?:[\/_.?=&-]|$)/i;
const CHILD_BINARY_EXT =
  /\.(?:mp3|mp4|m4a|mov|avi|zip|png|jpg|jpeg|gif|webp|svg|ico)(?:$|\?)/i;
const CHILD_SPONSORED_OR_CTA =
  /(?:[\(\[]\s*sponsored\s*[\)\]]|\b(?:sponsored(?:\s+(?:post|content|by|article|listing))?|advertisement|advertorial|partner content|brought to you by)\b|^(?:here|click here|sign up(?: here)?|read more|read here|view(?: online| image)?|subscribe(?: now)?|unsubscribe|manage (?:your )?(?:preferences|subscription)|join the discussion|more on our site|comments?|reply|share|forward|learn more|get started|try it|book a demo|sponsored)$)/i;

export function isYouTubeShortUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return (
      (host === "youtube.com" ||
        host === "m.youtube.com" ||
        host === "youtube-nocookie.com") &&
      /^\/shorts(?:\/|$)/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function isCandidateChildLink(rawUrl: string, title: string): boolean {
  if (isYouTubeShortUrl(rawUrl)) return false;
  const trimmedTitle = title.trim();
  if (trimmedTitle && CHILD_SPONSORED_OR_CTA.test(trimmedTitle)) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (CHILD_OPAQUE_OR_AD_HOSTS.test(host)) return false;
  const decodedPath = (() => {
    try {
      return decodeURIComponent(parsed.pathname);
    } catch {
      return parsed.pathname;
    }
  })();
  // Bare root/product homepages (e.g. https://elevenlabs.io/) are not stories.
  if (
    (decodedPath === "" || decodedPath === "/") &&
    parsed.searchParams.size === 0
  )
    return false;
  if (
    CHILD_SOCIAL_HOSTS.test(host) &&
    decodedPath.split("/").filter(Boolean).length <= 1
  )
    return false;
  if (CHILD_CHROME_PATH.test(decodedPath) || CHILD_BINARY_EXT.test(decodedPath))
    return false;
  return true;
}

function mediaDescription(entry: XmlElement): TextConstruct {
  const group = child(entry, "group", MEDIA_NS);
  const desc =
    (group ? child(group, "description", MEDIA_NS) : undefined) ??
    child(entry, "description", MEDIA_NS);
  const text = normalizeText(xmlText(desc));
  return { html: "", text };
}

export function parseFeed(
  xml: string,
  base: string,
  maxEntries = 1000,
  diagnostics?: { entryCount: number; xmlRepairs?: number },
  options?: { fanout?: boolean },
): Candidate[] {
  const xmlDiagnostics = { repairs: 0 };
  const root = parseXml(xml, base, xmlDiagnostics);
  if (diagnostics) diagnostics.xmlRepairs = xmlDiagnostics.repairs;
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
  if (diagnostics) diagnostics.entryCount = entries.length;
  const fanoutEnabled = options?.fanout ?? true;
  return entries
    .slice(0, maxEntries)
    .map((e) => {
      const linkNode = atom
        ? childElements(e, "link").find(
            (l) => !l.attributes.rel || l.attributes.rel === "alternate",
          )
        : child(e, "link");
      const sourceUrl = urlOrUndefined(
        atom ? (linkNode?.attributes.href ?? "") : xmlText(linkNode),
        linkNode?.base ?? e.base,
      );
      if (isYouTubeShortUrl(sourceUrl)) return null;
      const url = sourceUrl ? canonicalUrl(sourceUrl) : undefined;
      const contentNode = atom ? child(e, "content") : undefined;
      const inline = atom ? atomText(contentNode) : undefined;
      const summaryNode = atom ? child(e, "summary") : undefined;
      const atomSummary = atom ? atomText(summaryNode) : undefined;
      const body: TextConstruct = atom
        ? inline?.text
          ? inline
          : atomSummary?.text
            ? atomSummary
            : mediaDescription(e)
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
        (rdf
          ? identifierOrUndefined(
              e.attributes[
                "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about"
              ] ?? "",
              e.base,
            )
          : undefined) ||
        url ||
        `sha256:${createHash("sha256")
          .update(title + "\n" + (body.html || body.text))
          .digest("hex")}`;
      const links = new Map<
        string,
        { url: string; sourceUrl: string; title: string }
      >();
      if (fanoutEnabled && body.html) {
        const linkBase = atom
          ? ((inline?.text ? contentNode : summaryNode)?.base ?? e.base)
          : (sourceUrl ?? e.base);
        for (const m of body.html.matchAll(
          /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        )) {
          const original = urlOrUndefined(decodeHTMLAttribute(m[1]!), linkBase);
          if (!original) continue;
          const anchorTitle = cleanText(m[2]!);
          if (!isCandidateChildLink(original, anchorTitle)) continue;
          const canonical = canonicalUrl(original);
          if (canonical !== url && !links.has(canonical))
            links.set(canonical, {
              url: canonical,
              sourceUrl: original,
              title: anchorTitle || original,
            });
        }
      }
      const children =
        fanoutEnabled &&
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
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
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
    private defaults: { maxEntries: number; maxBytes: number } = {
      maxEntries: 1000,
      maxBytes: 5000000,
    },
    private fanoutFeeds?: ReadonlySet<string>,
  ) {}
  async poll(
    url: string,
    state: PollState,
    limits = this.defaults,
  ): Promise<PollResult> {
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
        if (size > limits.maxBytes) throw new Error("Feed exceeds byte budget");
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
    const diagnostics = { entryCount: 0, xmlRepairs: 0 };
    const fanout =
      this.fanoutFeeds === undefined
        ? true
        : this.fanoutFeeds.has(url) ||
          (response.url ? this.fanoutFeeds.has(response.url) : false);
    const items = parseFeed(
      decodeFeed(bytes, response.headers.get("content-type")),
      response.url || url,
      limits.maxEntries,
      diagnostics,
      { fanout },
    );
    return {
      items,
      entryCount: diagnostics.entryCount,
      xmlRepairs: diagnostics.xmlRepairs,
      truncated: diagnostics.entryCount > limits.maxEntries,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
    };
  }
}
