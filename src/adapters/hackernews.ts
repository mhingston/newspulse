import { createHash } from "node:crypto";
import {
  parseHackerNewsSource,
  type Candidate,
  type HackerNewsList,
  type HackerNewsSource,
  type PollResult,
  type PollState,
  type SourceAdapter,
} from "../domain";
import type {
  SearchPage,
  SearchProvider,
  SearchResult,
} from "../search-provider";
import { HttpError } from "./rss";

export const hnApiRoot = "https://hacker-news.firebaseio.com/v0";
export const hnSearchRoot = "https://hn.algolia.com/api/v1/search";
const userAgent = "Newspulse/0.1 (+https://github.com/mhingston/newspulse)";
const maxCursorBytes = 1_000_000;
const maxSeenIds = 2000;
const maxCommentDepth = 4;
const maxComments = 100;
const maxRequestsPerPoll = 80;
const maxItemBytes = 200_000;
const maxTextChars = 20_000;
const maxSearchResponseBytes = 1_000_000;
/** Refresh an unchanged discussion's comments at least this often. */
const commentRefreshMs = 6 * 3_600_000;

const listPaths: Record<HackerNewsList, string> = {
  top: "topstories",
  new: "newstories",
  best: "beststories",
  ask: "askstories",
  show: "showstories",
  job: "jobstories",
};

interface HnItem {
  id: number;
  type?: string;
  by?: string;
  time?: number;
  text?: string;
  url?: string;
  title?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  deleted?: boolean;
  dead?: boolean;
  parent?: number;
}

interface HnCursor {
  version: 1;
  kind: "item" | "list";
  list?: HackerNewsList;
  /** Story IDs already observed for a list source. */
  seen: string[];
  /** Last structural fingerprint per item source. */
  fingerprints: Record<string, string>;
  /** Last time comments were fully refreshed for an item source. */
  refreshedAt?: number;
}

interface Budget {
  requests: number;
  bytes: number;
  maxBytes: number;
}

/** A local ingestion bound was hit; collected content is still usable. */
class BudgetExhausted extends Error {
  constructor(readonly kind: "request" | "time" | "byte") {
    super(`Hacker News ${kind} budget exhausted`);
  }
}

export type HackerNewsFetcher = (
  input: URL,
  init?: RequestInit,
) => Promise<Response>;

function emptyCursor(source: HackerNewsSource): HnCursor {
  return {
    version: 1,
    kind: source.kind,
    list: source.kind === "list" ? source.list : undefined,
    seen: [],
    fingerprints: {},
  };
}

function readCursor(
  raw: string | undefined,
  source: HackerNewsSource,
): HnCursor {
  if (!raw) return emptyCursor(source);
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as { version?: unknown }).version !== 1 ||
      (value as { kind?: unknown }).kind !== source.kind ||
      !Array.isArray((value as { seen?: unknown }).seen) ||
      (value as { seen: unknown[] }).seen.length > maxSeenIds ||
      !(value as { fingerprints?: unknown }).fingerprints ||
      typeof (value as { fingerprints: unknown }).fingerprints !== "object" ||
      Array.isArray((value as { fingerprints: unknown }).fingerprints)
    )
      throw new Error();
    const cursor = value as HnCursor;
    if (source.kind === "list" && (!cursor.list || !(cursor.list in listPaths)))
      throw new Error();
    if (
      cursor.seen.some(
        (id) => typeof id !== "string" || !/^[1-9]\d{0,9}$/.test(id),
      ) ||
      (cursor.refreshedAt !== undefined &&
        (!Number.isSafeInteger(cursor.refreshedAt) || cursor.refreshedAt < 0))
    )
      throw new Error();
    return cursor;
  } catch {
    throw new Error("Invalid persisted Hacker News cursor");
  }
}

function serializeCursor(cursor: HnCursor): string {
  const encoded = JSON.stringify(cursor);
  if (Buffer.byteLength(encoded) > maxCursorBytes)
    throw new Error("Hacker News cursor exceeds its storage limit");
  return encoded;
}

const maxCommentChars = 2000;

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
}

function text(value: unknown, max = 10_000): string {
  return normalizeText(value).slice(0, max).trim();
}

/** Length of the text before clipping, used to detect lossy extraction. */
function trimmedLength(value: unknown): number {
  return normalizeText(value).trim().length;
}

function commentText(value: unknown): string {
  return text(value, maxCommentChars);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function discussionUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

function fingerprint(item: HnItem): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: item.title,
        text: item.text,
        url: item.url,
        score: item.score,
        descendants: item.descendants,
        kids: item.kids,
        deleted: item.deleted,
        dead: item.dead,
        time: item.time,
      }),
    )
    .digest("hex");
}

function retryDelay(response: Response): number {
  const retry = response.headers.get("retry-after");
  if (retry) {
    const parsed = /^\d+$/.test(retry)
      ? Number(retry) * 1000
      : Date.parse(retry) - Date.now();
    if (Number.isFinite(parsed) && parsed > 0)
      return Math.min(parsed, 86_400_000);
  }
  return 60_000;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} has no body`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`${label} exceeds byte budget`);
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
  return bytes;
}

function parseBoundedJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`Invalid ${label} JSON response`);
  }
}

function parseItem(value: unknown): HnItem | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Hacker News item response");
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.id) || Number(row.id) < 1)
    throw new Error("Invalid Hacker News item response");
  const kids = Array.isArray(row.kids)
    ? row.kids.filter(
        (id): id is number => Number.isSafeInteger(id) && Number(id) > 0,
      )
    : [];
  return {
    id: Number(row.id),
    type: typeof row.type === "string" ? row.type : undefined,
    by: typeof row.by === "string" ? row.by : undefined,
    time:
      Number.isSafeInteger(row.time) && Number(row.time) >= 0
        ? Number(row.time)
        : undefined,
    text: typeof row.text === "string" ? row.text : undefined,
    url: typeof row.url === "string" ? row.url : undefined,
    title: typeof row.title === "string" ? row.title : undefined,
    score:
      Number.isSafeInteger(row.score) && Number(row.score) >= 0
        ? Number(row.score)
        : undefined,
    descendants:
      Number.isSafeInteger(row.descendants) && Number(row.descendants) >= 0
        ? Number(row.descendants)
        : undefined,
    kids,
    deleted: row.deleted === true,
    dead: row.dead === true,
    parent:
      Number.isSafeInteger(row.parent) && Number(row.parent) > 0
        ? Number(row.parent)
        : undefined,
  };
}

/**
 * Followed Hacker News discussions and list feeds over the official Firebase
 * API. A discussion is its own item; a linked article becomes a child item so
 * an existing RSS article gains discussion provenance instead of a duplicate.
 * Comment trees, requests, bytes and time are bounded, and deleted/dead
 * content is recorded explicitly rather than silently dropped.
 */
export class HackerNewsAdapter implements SourceAdapter {
  constructor(private readonly fetcher: HackerNewsFetcher = fetch) {}

  async poll(
    url: string,
    state: PollState,
    limits: { maxEntries: number; maxBytes: number } = {
      maxEntries: 1000,
      maxBytes: 5_000_000,
    },
  ): Promise<PollResult> {
    const source = parseHackerNewsSource(url);
    if (!source) throw new Error("Invalid Hacker News source URL");
    const cursor = readCursor(state.cursor, source);
    // Keep the whole poll below the worker's 60s claim lease.
    const deadline = Date.now() + 45_000;
    const budget: Budget = {
      requests: 0,
      bytes: 0,
      maxBytes: Math.max(1, limits.maxBytes),
    };
    if (source.kind === "item")
      return this.pollItem(source, cursor, limits, budget, deadline);
    return this.pollList(source, cursor, limits, budget, deadline);
  }

  private async getJson(
    path: string,
    budget: Budget,
    deadline: number,
    required = false,
  ): Promise<unknown> {
    // Local budget exhaustion is a partial result, not a provider failure:
    // the caller keeps what it already collected and records `truncated`.
    if (budget.requests >= maxRequestsPerPoll)
      throw new BudgetExhausted("request");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BudgetExhausted("time");
    const remainingBytes = budget.maxBytes - budget.bytes;
    if (remainingBytes <= 0) throw new BudgetExhausted("byte");
    budget.requests++;
    const url = new URL(`${hnApiRoot}/${path}`);
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(Math.min(15_000, remaining));
    timeout.addEventListener("abort", () => controller.abort(timeout.reason));
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": userAgent },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      // Hitting the poll deadline is a local ingestion bound for any request;
      // a single slow request below the deadline is a retryable provider error.
      if (timeout.aborted) throw new BudgetExhausted("time");
      if (required) throw new HttpError("Hacker News API request timed out");
      throw new HttpError("Hacker News API request failed or timed out");
    }
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel();
      if (status === 429 || status >= 500)
        throw new HttpError(
          `Hacker News API HTTP ${status}`,
          retryDelay(response),
        );
      throw new HttpError(`Hacker News API HTTP ${status}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(
        response,
        Math.min(remainingBytes, maxItemBytes),
        "Hacker News response",
      );
    } catch (error) {
      // An oversized or slow body is a local bound, not a provider failure;
      // callers keep what they already collected.
      if (
        !(error instanceof Error) ||
        !/exceeds byte budget/.test(error.message)
      )
        throw error;
      throw new BudgetExhausted("byte");
    }
    budget.bytes += bytes.byteLength;
    return parseBoundedJson(bytes, "Hacker News");
  }
  private async fetchItem(
    id: number,
    budget: Budget,
    deadline: number,
    required = false,
  ): Promise<HnItem | null> {
    return parseItem(
      await this.getJson(`item/${id}.json`, budget, deadline, required),
    );
  }

  private async pollItem(
    source: Extract<HackerNewsSource, { kind: "item" }>,
    cursor: HnCursor,
    limits: { maxEntries: number; maxBytes: number },
    budget: Budget,
    deadline: number,
  ): Promise<PollResult> {
    const item = await this.fetchItem(source.id, budget, deadline, true);
    if (!item) throw new HttpError("Hacker News item was not found");
    const nextFingerprint = fingerprint(item);
    const previous = cursor.fingerprints[String(source.id)];
    const now = Date.now();
    const refreshDue =
      cursor.refreshedAt === undefined ||
      now - cursor.refreshedAt >= commentRefreshMs;
    const next: HnCursor = {
      version: 1,
      kind: "item",
      seen: [],
      fingerprints: { [String(source.id)]: nextFingerprint },
      refreshedAt: cursor.refreshedAt,
    };
    // A discussion with no structural change is not re-fetched comment by
    // comment; new comments change descendants/kids and therefore the hash.
    // A periodic refresh still catches edits that leave the structure intact.
    if (previous === nextFingerprint && !refreshDue)
      return {
        items: [],
        cursor: serializeCursor(next),
        entryCount: 0,
        notModified: true,
      };
    const comments = await this.fetchComments(
      item.kids ?? [],
      budget,
      deadline,
    );
    next.refreshedAt = now;
    const built = this.buildCandidate(item, comments.text, comments.truncated);
    return {
      items: [built.candidate],
      cursor: serializeCursor(next),
      entryCount: 1,
      truncated: built.truncated,
      notModified: false,
    };
  }

  private async pollList(
    source: Extract<HackerNewsSource, { kind: "list" }>,
    cursor: HnCursor,
    limits: { maxEntries: number; maxBytes: number },
    budget: Budget,
    deadline: number,
  ): Promise<PollResult> {
    const ids = await this.getJson(
      `${listPaths[source.list]}.json`,
      budget,
      deadline,
      true,
    );
    if (!Array.isArray(ids))
      throw new Error("Invalid Hacker News list response");
    const seen = new Set(cursor.seen);
    const maxItems = Math.min(Math.max(1, limits.maxEntries), 500);
    const fresh = ids
      .filter(
        (id): id is number =>
          Number.isSafeInteger(id) && Number(id) > 0 && !seen.has(String(id)),
      )
      .slice(0, maxItems);
    const items: Candidate[] = [];
    let truncated = fresh.length === maxItems && ids.length > maxItems;
    for (const id of fresh) {
      let item: HnItem | null;
      try {
        item = await this.fetchItem(id, budget, deadline);
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) throw error;
        truncated = true;
        break;
      }
      seen.add(String(id));
      // Job feeds contain `type: "job"` postings, not stories.
      if (!item || (item.type !== "story" && item.type !== "job")) continue;
      const comments = await this.fetchComments(
        item.kids ?? [],
        budget,
        deadline,
      );
      const built = this.buildCandidate(
        item,
        comments.text,
        comments.truncated,
      );
      if (built.truncated) truncated = true;
      items.push(built.candidate);
    }
    const next: HnCursor = {
      version: 1,
      kind: "list",
      list: source.list,
      seen: [...seen].slice(-maxSeenIds),
      fingerprints: {},
    };
    return {
      items,
      cursor: serializeCursor(next),
      entryCount: items.length,
      truncated,
      notModified: items.length === 0,
    };
  }

  private async fetchComments(
    kids: number[],
    budget: Budget,
    deadline: number,
  ): Promise<{ text: string; truncated: boolean }> {
    const lines: string[] = [];
    // Depth-first keeps each reply directly after its parent, so indentation
    // alone still communicates the tree structure.
    const stack: { id: number; depth: number }[] = [...kids]
      .reverse()
      .map((id) => ({ id, depth: 0 }));
    let rendered = 0;
    let truncated = false;
    while (stack.length) {
      if (rendered >= maxComments || budget.requests >= maxRequestsPerPoll) {
        truncated = true;
        break;
      }
      const { id, depth } = stack.pop()!;
      if (depth > maxCommentDepth) {
        truncated = true;
        continue;
      }
      let item: HnItem | null;
      try {
        item = await this.fetchItem(id, budget, deadline);
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) throw error;
        truncated = true;
        break;
      }
      if (!item) continue;
      rendered++;
      const indent = "  ".repeat(depth);
      const body = commentText(item.text);
      // Clipping an individual comment is lossy even when the whole
      // discussion still fits, so it must be reported as truncation.
      if (body.length < trimmedLength(item.text)) truncated = true;
      if (item.deleted) lines.push(`${indent}[deleted]`);
      else if (item.dead)
        lines.push(`${indent}[dead]${item.by ? ` ${item.by}` : ""}: ${body}`);
      else lines.push(`${indent}${item.by ?? "unknown"}: ${body}`);
      const childKids = item.kids ?? [];
      if (depth < maxCommentDepth)
        for (let index = childKids.length - 1; index >= 0; index--)
          stack.push({ id: childKids[index]!, depth: depth + 1 });
      else if (childKids.length) truncated = true;
    }
    if (stack.length) truncated = true;
    const joined = lines.join("\n");
    if (joined.length > maxTextChars) truncated = true;
    return { text: joined.slice(0, maxTextChars), truncated };
  }

  private buildCandidate(
    item: HnItem,
    comments: string,
    commentsTruncated: boolean,
  ): { candidate: Candidate; truncated: boolean } {
    const discussion = discussionUrl(item.id);
    const title = text(item.title, 500) || `Hacker News item ${item.id}`;
    const markers = [
      item.deleted ? "[deleted]" : "",
      item.dead ? "[dead]" : "",
    ].filter(Boolean);
    const header = [
      `Hacker News discussion: ${discussion}`,
      item.by ? `Submitter: ${item.by}` : "",
      item.time ? `Submitted: ${new Date(item.time * 1000).toISOString()}` : "",
      item.score !== undefined ? `Score: ${item.score}` : "",
      item.descendants !== undefined ? `Comments: ${item.descendants}` : "",
      markers.length ? `Status: ${markers.join(" ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const rawBody = typeof item.text === "string" ? item.text : "";
    let body = text(item.text, 8000);
    let truncated = commentsTruncated || body.length < rawBody.trim().length;
    const marker = "[discussion truncated by ingestion bounds]";
    let discussionText = [header, body, comments ? `---\n${comments}` : ""]
      .filter(Boolean)
      .join("\n\n");
    // Reserve room for the marker so clipping cannot hide the truncation.
    if (discussionText.length + marker.length + 2 > maxTextChars) {
      discussionText = discussionText.slice(
        0,
        maxTextChars - marker.length - 2,
      );
      truncated = true;
    }
    if (truncated) discussionText = `${discussionText}\n\n${marker}`;
    const children =
      isHttpUrl(item.url) && item.url !== discussion
        ? [{ url: item.url, title }]
        : undefined;
    return {
      candidate: {
        nativeId: `hn-item:${item.id}`,
        url: discussion,
        sourceUrl: discussion,
        title: markers.length ? `${markers.join(" ")} ${title}` : title,
        text: discussionText,
        publishedAt: item.time ? item.time * 1000 : undefined,
        children,
      },
      truncated,
    };
  }
}

/**
 * Algolia's documented HN search API. Results are untrusted discovery
 * metadata; the linked article is preferred for extraction, with the
 * discussion URL retained in the snippet for provenance.
 */
export class HackerNewsSearchProvider implements SearchProvider {
  readonly name = "hackernews";
  readonly version = "search-v1";
  constructor(private readonly fetcher: HackerNewsFetcher = fetch) {}

  async search(input: {
    query: string;
    limit: number;
    cursor?: string;
  }): Promise<SearchPage> {
    const query = input.query.trim();
    if (!query || query.length > 256 || /[\u0000-\u001f\u007f]/.test(query))
      throw new Error("Invalid Hacker News search query");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 250)
      throw new Error("Invalid Hacker News search result limit");
    const perPage = Math.min(input.limit, 100);
    let page = 0;
    if (input.cursor !== undefined) {
      if (!/^\d{1,3}$/.test(input.cursor))
        throw new Error("Invalid Hacker News search cursor");
      page = Number(input.cursor);
      if (page > 100) throw new Error("Invalid Hacker News search cursor");
    }
    const url = new URL(hnSearchRoot);
    url.searchParams.set("query", query);
    url.searchParams.set("tags", "story");
    url.searchParams.set("hitsPerPage", String(perPage));
    url.searchParams.set("page", String(page));
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": userAgent },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("Hacker News search request failed or timed out");
    }
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel();
      if (status === 429 || status >= 500)
        throw new Error(`Hacker News search HTTP ${status}`);
      throw new Error(`Hacker News search HTTP ${status}`);
    }
    const bytes = await readBoundedBody(
      response,
      maxSearchResponseBytes,
      "Hacker News search",
    );
    const parsed = parseBoundedJson(bytes, "Hacker News search");
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Array.isArray((parsed as { hits?: unknown }).hits)
    )
      throw new Error("Invalid Hacker News search response");
    const hits = (parsed as { hits: unknown[] }).hits;
    if (hits.length > perPage)
      throw new Error("Hacker News search response exceeds result limit");
    const results: SearchResult[] = [];
    for (const hit of hits) {
      if (!hit || typeof hit !== "object" || Array.isArray(hit)) continue;
      const row = hit as Record<string, unknown>;
      const objectID = String(row.objectID ?? "");
      if (!/^[1-9]\d{0,9}$/.test(objectID)) continue;
      const discussion = discussionUrl(Number(objectID));
      const title = text(row.title, 500) || `Hacker News item ${objectID}`;
      const article = isHttpUrl(row.url) ? row.url : undefined;
      const snippet = [
        Number.isSafeInteger(row.points) ? `Points: ${row.points}` : "",
        Number.isSafeInteger(row.num_comments)
          ? `Comments: ${row.num_comments}`
          : "",
        `Discussion: ${discussion}`,
        text(row.story_text, 500),
      ]
        .filter(Boolean)
        .join("; ")
        .slice(0, 2000);
      results.push({
        url: article ?? discussion,
        title,
        snippet,
        publishedAt:
          Number.isSafeInteger(row.created_at_i) && Number(row.created_at_i) > 0
            ? Number(row.created_at_i) * 1000
            : undefined,
      });
    }
    const nbPages = Number((parsed as { nbPages?: unknown }).nbPages);
    const hasMore =
      Number.isSafeInteger(nbPages) &&
      page + 1 < nbPages &&
      results.length === perPage;
    return {
      results,
      truncated: hasMore,
      nextCursor: hasMore ? String(page + 1) : undefined,
    };
  }
}
