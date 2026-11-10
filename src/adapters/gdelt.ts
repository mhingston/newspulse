import { resolvedUrl } from "../domain";
import type {
  SearchPage,
  SearchProvider,
  SearchResult,
} from "../search-provider";
import { cleanText } from "./rss";

const endpoint = "https://api.gdeltproject.org/api/v2/doc/doc";
const maxResponseBytes = 1_000_000;

/** GDELT's seen date is an observation, not an article publication date. */
function seenDate(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{8}T\d{6}Z$/.test(value)) return;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === iso.replace("Z", ".000Z")
    ? timestamp
    : undefined;
}

export class GdeltSearchProvider implements SearchProvider {
  readonly name = "gdelt";
  readonly version = "doc-2.0-artlist-v1";
  constructor(
    private readonly fetcher: (
      input: URL,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}

  async search(input: {
    query: string;
    limit: number;
    cursor?: string;
  }): Promise<SearchPage> {
    const query = input.query.trim();
    if (!query || query.length > 500 || /[\u0000-\u001f\u007f]/.test(query))
      throw new Error("Invalid GDELT query");
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 250 ||
      input.cursor !== undefined
    )
      throw new Error("Invalid GDELT result limit or cursor");
    const url = new URL(endpoint);
    url.searchParams.set("query", query);
    url.searchParams.set("mode", "artlist");
    url.searchParams.set("format", "json");
    url.searchParams.set("maxrecords", String(input.limit));
    const signal = AbortSignal.timeout(20_000);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        signal,
        redirect: "error",
        headers: { accept: "application/json" },
      });
    } catch {
      throw new Error("GDELT request failed or timed out");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GDELT HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("GDELT response has no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxResponseBytes)
          throw new Error("GDELT response exceeds byte limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Invalid GDELT JSON response");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid GDELT response");
    const object = parsed as Record<string, unknown>;
    // An empty object is ambiguous and cannot establish a successful empty search.
    if ("error" in object || "errors" in object || !("articles" in object))
      throw new Error("Invalid GDELT response");
    const articles = object.articles;
    if (articles !== undefined && !Array.isArray(articles))
      throw new Error("Invalid GDELT articles");
    const rows = articles ?? [];
    if (rows.length > input.limit)
      throw new Error("GDELT response exceeds result limit");
    const results: SearchResult[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const entry = row as Record<string, unknown>;
      if (
        typeof entry.url !== "string" ||
        entry.url.length > 8192 ||
        typeof entry.title !== "string"
      )
        continue;
      let url: string;
      try {
        url = resolvedUrl(entry.url);
      } catch {
        continue;
      }
      const title = cleanText(entry.title).slice(0, 1000);
      if (!title) continue;
      results.push({ url, title, observedAt: seenDate(entry.seendate) });
    }
    return { results, truncated: rows.length >= input.limit };
  }
}
