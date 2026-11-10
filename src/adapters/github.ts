import { createHash } from "node:crypto";
import {
  canonicalUrl,
  parseGithubSource,
  type Candidate,
  type GithubSource,
  type GithubSourceStream,
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

export const apiRoot = "https://api.github.com";
const apiVersion = "2022-11-28";
const userAgent = "Newspulse/0.1 (+https://github.com/mhingston/newspulse)";
const maxReleasePages = 10;
const maxEventPages = 3;
const maxSeenEvents = 300;
const maxCursorBytes = 1_000_000;
/** GitHub search paginates at most the first 1000 results (10 pages of 100). */
const maxSearchPages = 10;
const maxSearchResponseBytes = 1_000_000;

interface PageState {
  ids: string[];
  etag?: string;
}
interface ReleaseSnapshot {
  fingerprint: string;
  title: string;
  url: string;
  tag: string;
  author: string;
  publishedAt?: number;
}
interface GitHubCursor {
  version: 1;
  stream: GithubSourceStream;
  repoFullName?: string;
  complete?: boolean;
  pages: PageState[];
  releases: Record<string, ReleaseSnapshot>;
  seenEvents: string[];
}

function emptyCursor(stream: GithubSourceStream): GitHubCursor {
  return { version: 1, stream, pages: [], releases: {}, seenEvents: [] };
}

function readCursor(raw: string | undefined, stream: GithubSourceStream) {
  if (!raw) return emptyCursor(stream);
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as { version?: unknown }).version !== 1 ||
      (value as { stream?: unknown }).stream !== stream ||
      !Array.isArray((value as { pages?: unknown }).pages) ||
      !Array.isArray((value as { seenEvents?: unknown }).seenEvents) ||
      !((value as { releases?: unknown }).releases instanceof Object)
    )
      throw new Error();
    const cursor = value as GitHubCursor;
    if (
      cursor.pages.length > maxReleasePages ||
      cursor.seenEvents.length > maxSeenEvents ||
      Object.keys(cursor.releases).length > 1000
    )
      throw new Error();
    return cursor;
  } catch {
    throw new Error("Invalid persisted GitHub cursor");
  }
}

function serializeCursor(cursor: GitHubCursor): string {
  const encoded = JSON.stringify(cursor);
  if (Buffer.byteLength(encoded) > maxCursorBytes)
    throw new Error("GitHub cursor exceeds its storage limit");
  return encoded;
}

function apiPath(cursor: GitHubCursor, source: GithubSource): string {
  const repo = cursor.repoFullName ?? `${source.owner}/${source.repo}`;
  return `/repos/${repo}/${source.stream}`;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Bound untrusted API text; repository and release text stays source data. */
function text(value: unknown, max = 10_000): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .slice(0, max)
    .trim();
}

function parseGithubUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    if (url.hostname.toLowerCase() !== "github.com") return;
    return url.href;
  } catch {
    return;
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (
    response.headers.get("x-ratelimit-remaining") === "0" &&
    Number.isFinite(reset)
  )
    return Math.max(1000, Math.min(reset * 1000 - Date.now(), 86_400_000));
  return 60_000;
}

interface JsonResponse {
  status: number;
  body?: unknown;
  etag?: string;
  apiPath: string;
  bytes: number;
}

export type GithubFetcher = (
  input: URL,
  init?: RequestInit,
) => Promise<Response>;

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

function githubRequestInit(headers: Record<string, string>): RequestInit {
  return {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  };
}

/**
 * Followed-repository adapter over the official REST API. Releases are tracked
 * with per-page validators and bounded snapshots so release edits, removals
 * and repository renames become content observations. Activity events are
 * deliberately scoped to finished milestones rather than unbounded commit
 * noise. No token is required for read-only polling of public repositories.
 */
export class GitHubSourceAdapter implements SourceAdapter {
  constructor(
    private readonly token?: string,
    private readonly fetcher: GithubFetcher = fetch,
  ) {}

  async poll(
    url: string,
    state: PollState,
    limits: { maxEntries: number; maxBytes: number } = {
      maxEntries: 1000,
      maxBytes: 5_000_000,
    },
  ): Promise<PollResult> {
    const source = parseGithubSource(url);
    if (!source) throw new Error("Invalid GitHub repository source URL");
    const cursor = readCursor(state.cursor, source.stream);
    if (source.stream === "releases")
      return this.pollReleases(source, cursor, state, limits);
    return this.pollEvents(source, cursor, state, limits);
  }

  private headers(etag?: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": userAgent,
      "x-github-api-version": apiVersion,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (etag) headers["if-none-match"] = etag;
    return headers;
  }

  private async getJson(
    target: URL,
    etag: string | undefined,
    maxBytes: number,
  ): Promise<JsonResponse> {
    let requestUrl = target;
    let response: Response;
    try {
      response = await this.fetcher(
        requestUrl,
        githubRequestInit(this.headers(etag)),
      );
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          await response.body?.cancel();
          throw new HttpError("GitHub redirect has no location");
        }
        let next: URL;
        try {
          next = new URL(location);
        } catch {
          await response.body?.cancel();
          throw new HttpError("GitHub redirect location is invalid");
        }
        // Renamed repositories redirect within /repos/NAME to /repositories/ID
        // for the same stream; anything else is rejected.
        const allowed =
          next.origin === apiRoot &&
          next.pathname.split("/").at(-1) ===
            target.pathname.split("/").at(-1) &&
          /^\/(?:repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|repositories\/[1-9]\d*)\/(?:releases|events)$/.test(
            next.pathname,
          );
        if (!allowed) {
          await response.body?.cancel();
          throw new HttpError("GitHub redirect destination is not allowed");
        }
        await response.body?.cancel();
        // Rebuild our own bounded query parameters; a remote query is data.
        for (const [key, value] of target.searchParams)
          next.searchParams.set(key, value);
        requestUrl = next;
        response = await this.fetcher(
          requestUrl,
          githubRequestInit(this.headers(etag)),
        );
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError("GitHub API request failed or timed out");
    }
    if (response.status === 304)
      return {
        status: 304,
        etag: response.headers.get("etag") ?? etag,
        apiPath: requestUrl.pathname,
        bytes: 0,
      };
    if (!response.ok) {
      const status = response.status;
      const limited =
        status === 429 ||
        (status === 403 &&
          response.headers.get("x-ratelimit-remaining") === "0");
      await response.body?.cancel();
      if (limited)
        throw new HttpError(
          "GitHub API rate limit exhausted",
          retryDelay(response),
        );
      if (status === 401)
        throw new HttpError("GitHub authentication failed; check GITHUB_TOKEN");
      if (status === 403)
        throw new HttpError(
          "GitHub denied access to this repository or endpoint",
        );
      if (status === 404)
        throw new HttpError("GitHub repository or resource was not found");
      throw new HttpError(`GitHub API HTTP ${status}`);
    }
    const bytes = await readBoundedBody(response, maxBytes, "GitHub response");
    const body = parseBoundedJson(bytes, "GitHub");
    return {
      status: response.status,
      body,
      etag: response.headers.get("etag") ?? undefined,
      apiPath: requestUrl.pathname,
      bytes: bytes.byteLength,
    };
  }

  private async pollReleases(
    source: GithubSource,
    prior: GitHubCursor,
    state: PollState,
    limits: { maxEntries: number; maxBytes: number },
  ): Promise<PollResult> {
    const maxItems = Math.min(Math.max(1, limits.maxEntries), 1000);
    const perPage = Math.min(maxItems, 100);
    const pagesAllowed = Math.min(
      maxReleasePages,
      Math.ceil(maxItems / perPage),
    );
    const current: Record<string, ReleaseSnapshot> = {};
    const parsedById = new Map<string, Candidate>();
    const pageStates: PageState[] = [];
    const refreshedPages: boolean[] = [];
    let api = apiPath(prior, source);
    let bytesUsed = 0;
    let allNotModified = true;
    let shortPage = false;
    for (let page = 1; page <= pagesAllowed && !shortPage; page++) {
      const requestUrl = new URL(`${apiRoot}${api}`);
      requestUrl.searchParams.set("per_page", String(perPage));
      requestUrl.searchParams.set("page", String(page));
      const response = await this.getJson(
        requestUrl,
        page === 1 ? state.etag : prior.pages[page - 1]?.etag,
        Math.max(0, limits.maxBytes - bytesUsed),
      );
      api = response.apiPath;
      bytesUsed += response.bytes;
      const saved = prior.pages[page - 1];
      if (response.status === 304) {
        if (!saved)
          throw new HttpError("GitHub returned 304 without a saved page");
        pageStates.push(saved);
        refreshedPages.push(false);
        for (const id of saved.ids) {
          const snapshot = prior.releases[id];
          if (snapshot) current[id] = snapshot;
        }
        continue;
      }
      allNotModified = false;
      if (
        !Array.isArray(response.body) ||
        (response.body as unknown[]).length > perPage
      )
        throw new Error("Invalid GitHub releases response");
      const rows = response.body as unknown[];
      const parsed = rows.flatMap((row) => {
        const release = this.parseRelease(row, source, prior);
        return release ? [release] : [];
      });
      for (const release of parsed) {
        current[release.id] = release.snapshot;
        parsedById.set(release.id, release.candidate);
        // Repository renames are learned from the original release URLs.
        if (release.repoFullName) prior.repoFullName = release.repoFullName;
      }
      pageStates.push({
        ids: parsed.map((release) => release.id),
        etag: response.etag,
      });
      refreshedPages.push(true);
      if (rows.length < perPage) shortPage = true;
    }
    // A short page fully enumerates the list; without one the window may have
    // cut releases off. If every page was unchanged, completeness carries over.
    const complete =
      shortPage ||
      (allNotModified && pageStates.length > 0 && prior.complete === true);

    const items: Candidate[] = [];
    for (let i = 0; i < pageStates.length; i++) {
      if (!refreshedPages[i]) continue;
      for (const id of pageStates[i]!.ids) {
        const previous = prior.releases[id];
        const snapshot = current[id]!;
        if (previous && previous.fingerprint === snapshot.fingerprint) continue;
        const candidate = parsedById.get(id);
        if (candidate) items.push(candidate);
      }
    }
    // Only a fully enumerated snapshot on both sides can prove removal.
    if (prior.complete === true && shortPage) {
      const repository = prior.repoFullName ?? `${source.owner}/${source.repo}`;
      for (const [id, previous] of Object.entries(prior.releases))
        if (!current[id])
          items.push({
            nativeId: `github-release:${id}`,
            url: previous.url,
            sourceUrl: previous.url,
            title: `[Removed release] ${previous.title}`,
            text:
              `Repository: ${repository}\n` +
              `Release ${previous.tag} is no longer listed by the GitHub Releases API. Historical source and item references remain preserved.`,
            publishedAt: previous.publishedAt,
          });
    }
    const next = emptyCursor("releases");
    next.repoFullName = prior.repoFullName;
    next.complete = complete;
    next.pages = pageStates;
    next.releases = current;
    return {
      items,
      etag: pageStates[0]?.etag,
      cursor: serializeCursor(next),
      entryCount: Object.keys(current).length,
      truncated: !complete,
      notModified: allNotModified && items.length === 0,
    };
  }

  private parseRelease(
    value: unknown,
    source: GithubSource,
    cursor: GitHubCursor,
  ):
    | {
        id: string;
        repoFullName?: string;
        snapshot: ReleaseSnapshot;
        candidate: Candidate;
      }
    | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    if (!Number.isSafeInteger(row.id) || Number(row.id) < 1) return;
    if (row.draft === true) return;
    const id = String(row.id);
    const tag = text(row.tag_name, 200);
    if (!tag) return;
    const url = parseGithubUrl(row.html_url);
    if (!url) return;
    const title = text(row.name, 300) || tag || `Release ${id}`;
    const author =
      row.author && typeof row.author === "object"
        ? text((row.author as Record<string, unknown>).login, 100)
        : "";
    const body = text(row.body, 8000);
    const publishedAt = parseTimestamp(row.published_at);
    const repoFullName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
      .exec(
        url.slice("https://github.com/".length).replace(/\/releases\/.*$/, ""),
      )?.[0]
      ?.toLowerCase();
    const snapshot: ReleaseSnapshot = {
      fingerprint: fingerprint({
        tag,
        title,
        body,
        author,
        publishedAt,
        updatedAt: text(row.updated_at, 50),
        prerelease: row.prerelease === true,
      }),
      title,
      url,
      tag,
      author,
      publishedAt,
    };
    const repository =
      repoFullName ?? cursor.repoFullName ?? `${source.owner}/${source.repo}`;
    const candidate: Candidate = {
      nativeId: `github-release:${id}`,
      url,
      sourceUrl: url,
      title: `${repository} ${title}`.slice(0, 1000),
      text: [
        `Repository: ${repository}`,
        `Release: ${title}`,
        `Tag: ${tag}`,
        author ? `Author: ${author}` : "",
        publishedAt === undefined
          ? ""
          : `Published: ${new Date(publishedAt).toISOString()}`,
        row.prerelease === true ? "Prerelease: yes" : "",
        "Release notes (untrusted source text):",
        body,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 10_000),
      publishedAt,
    };
    return { id, repoFullName, snapshot, candidate };
  }

  private async pollEvents(
    source: GithubSource,
    prior: GitHubCursor,
    state: PollState,
    limits: { maxEntries: number; maxBytes: number },
  ): Promise<PollResult> {
    const perPage = Math.min(100, Math.max(1, limits.maxEntries));
    const pagesAllowed = Math.min(
      maxEventPages,
      Math.ceil(Math.min(limits.maxEntries, 300) / perPage),
    );
    const seen = new Set(prior.seenEvents);
    const nextSeen = new Set(prior.seenEvents);
    const pageStates: PageState[] = [];
    const items: Candidate[] = [];
    let api = apiPath(prior, source);
    let bytesUsed = 0;
    let entryCount = 0;
    let allNotModified = true;
    let shortPage = false;
    for (let page = 1; page <= pagesAllowed && !shortPage; page++) {
      const requestUrl = new URL(`${apiRoot}${api}`);
      requestUrl.searchParams.set("per_page", String(perPage));
      requestUrl.searchParams.set("page", String(page));
      const response = await this.getJson(
        requestUrl,
        page === 1 ? state.etag : prior.pages[page - 1]?.etag,
        Math.max(0, limits.maxBytes - bytesUsed),
      );
      api = response.apiPath;
      bytesUsed += response.bytes;
      if (response.status === 304) {
        const saved = prior.pages[page - 1];
        if (!saved)
          throw new HttpError("GitHub returned 304 without a saved event page");
        pageStates.push(saved);
        continue;
      }
      allNotModified = false;
      if (
        !Array.isArray(response.body) ||
        (response.body as unknown[]).length > perPage
      )
        throw new Error("Invalid GitHub events response");
      const rows = response.body as unknown[];
      const ids: string[] = [];
      for (const row of rows) {
        const parsed = this.parseEvent(row, source);
        if (!parsed) continue;
        ids.push(parsed.id);
        nextSeen.add(parsed.id);
        if (!seen.has(parsed.id)) items.push(parsed.candidate);
      }
      entryCount += ids.length;
      pageStates.push({ ids, etag: response.etag });
      if (rows.length < perPage) shortPage = true;
    }
    const next = emptyCursor("events");
    next.repoFullName = prior.repoFullName;
    next.pages = pageStates;
    next.seenEvents = [...nextSeen].slice(-maxSeenEvents);
    return {
      items,
      etag: pageStates[0]?.etag,
      cursor: serializeCursor(next),
      entryCount,
      truncated: !shortPage && pageStates.length === pagesAllowed,
      notModified: allNotModified && items.length === 0,
    };
  }

  private parseEvent(
    value: unknown,
    source: GithubSource,
  ): { id: string; candidate: Candidate } | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const event = value as Record<string, unknown>;
    if (typeof event.id !== "string" || !/^\d{1,30}$/.test(event.id)) return;
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    const repoObject =
      event.repo && typeof event.repo === "object"
        ? (event.repo as Record<string, unknown>)
        : {};
    const repo = text(repoObject.name, 250) || `${source.owner}/${source.repo}`;
    let target: Record<string, unknown> | undefined;
    let activity = "";
    let kind = "";
    // Documented scope: closed issues and merged pull requests. Publish-time
    // release announcements are owned by the releases stream.
    if (event.type === "IssuesEvent" && payload.action === "closed") {
      target = payload.issue as Record<string, unknown> | undefined;
      if (target?.pull_request) return;
      kind = "Issue";
      activity = "closed";
    } else if (
      event.type === "PullRequestEvent" &&
      payload.action === "closed" &&
      (payload.pull_request as Record<string, unknown> | undefined)
        ?.merged_at !== undefined
    ) {
      target = payload.pull_request as Record<string, unknown> | undefined;
      kind = "Pull request";
      activity = "merged";
    } else return;
    if (!target || typeof target !== "object") return;
    const url = parseGithubUrl(target.html_url);
    if (!url) return;
    const number = Number.isSafeInteger(target.number)
      ? Number(target.number)
      : undefined;
    const title = text(target.title, 500) || `${kind} ${number ?? ""}`.trim();
    const actor =
      event.actor && typeof event.actor === "object"
        ? text((event.actor as Record<string, unknown>).login, 100)
        : "";
    const createdAt = parseTimestamp(event.created_at);
    const candidate: Candidate = {
      // Event IDs are stable, provider-native identifiers for activity.
      nativeId: `github-event:${event.id}`,
      url,
      sourceUrl: url,
      title: `${repo} ${kind.toLowerCase()} ${activity}: ${title}`.slice(
        0,
        1000,
      ),
      text: [
        `Repository: ${repo}`,
        `Activity: ${kind} ${activity}`,
        number === undefined ? "" : `Number: ${number}`,
        actor ? `Author: ${actor}` : "",
        createdAt === undefined
          ? ""
          : `Activity time: ${new Date(createdAt).toISOString()}`,
        `Title: ${title}`,
        `Source URL: ${url}`,
        "Repository and issue text are untrusted source content.",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 5000),
      publishedAt: createdAt,
    };
    return { id: event.id, candidate };
  }
}

/**
 * Official repository Search API (GET /search/repositories). GitHub has no
 * assumed official "trending" API; this provider exposes an explicitly
 * recorded query, most often interest terms plus stars and date-window
 * qualifiers, ranked deterministically by stars. That correlation is an
 * approximation of relevance, documented per run in the discovery ledger.
 */
export class GithubSearchProvider implements SearchProvider {
  readonly name = "github";
  readonly version = "search-repositories-v1";
  constructor(
    private readonly token?: string,
    private readonly fetcher: GithubFetcher = fetch,
  ) {}

  async search(input: {
    query: string;
    limit: number;
    cursor?: string;
  }): Promise<SearchPage> {
    const query = input.query.trim();
    if (!query || query.length > 256 || /[\u0000-\u001f\u007f]/.test(query))
      throw new Error("Invalid GitHub search query");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 250)
      throw new Error("Invalid GitHub search result limit");
    const perPage = Math.min(input.limit, 100);
    let page = 1;
    if (input.cursor !== undefined) {
      if (
        !/^[1-9]\d{0,2}$/.test(input.cursor) ||
        Number(input.cursor) > maxSearchPages
      )
        throw new Error("Invalid GitHub search cursor");
      page = Number(input.cursor);
    }
    const url = new URL(`${apiRoot}/search/repositories`);
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("GitHub search request failed or timed out");
    }
    if (!response.ok) {
      const status = response.status;
      const limited =
        status === 429 ||
        (status === 403 &&
          response.headers.get("x-ratelimit-remaining") === "0");
      await response.body?.cancel();
      if (limited) throw new Error("GitHub search rate limit exhausted");
      if (status === 422)
        throw new Error("GitHub search rejected the query as invalid");
      if (status === 401)
        throw new Error("GitHub search authentication failed");
      if (status === 403)
        throw new Error("GitHub search denied access to this endpoint");
      throw new Error(`GitHub search HTTP ${status}`);
    }
    const bytes = await readBoundedBody(
      response,
      maxSearchResponseBytes,
      "GitHub search",
    );
    const parsed = parseBoundedJson(bytes, "GitHub search");
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Array.isArray((parsed as { items?: unknown }).items)
    )
      throw new Error("Invalid GitHub search response");
    const rows = (parsed as { items: unknown[] }).items;
    if (rows.length > perPage)
      throw new Error("GitHub search response exceeds result limit");
    const results: SearchResult[] = [];
    for (const row of rows) {
      const result = this.parseRepository(row);
      if (result) results.push(result);
    }
    const exhausted = page >= maxSearchPages;
    return {
      results,
      truncated: rows.length === perPage,
      nextCursor:
        rows.length === perPage && !exhausted ? String(page + 1) : undefined,
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": userAgent,
      "x-github-api-version": apiVersion,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  private parseRepository(value: unknown): SearchResult | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    const fullName = text(row.full_name, 200);
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) ||
      fullName.startsWith(".") ||
      fullName.includes("/.")
    )
      return;
    const url = parseGithubUrl(row.html_url);
    if (!url) return;
    const canonical = canonicalUrl(url);
    const description = text(row.description, 1000);
    const stars = Number(row.stargazers_count);
    const pushed = parseTimestamp(row.pushed_at);
    const created = parseTimestamp(row.created_at);
    const signals = [
      Number.isSafeInteger(stars) && stars >= 0 ? `Stars: ${stars}` : undefined,
      text(row.language, 100) ? `Language: ${text(row.language, 100)}` : "",
      pushed ? `Pushed: ${new Date(pushed).toISOString().slice(0, 10)}` : "",
    ].filter(Boolean);
    const title = description
      ? `${fullName} — ${description}`.slice(0, 1000)
      : fullName;
    return {
      url: canonical,
      title,
      snippet: signals.length
        ? `${signals.join("; ")}. ${description}`.slice(0, 10_000)
        : description,
      publishedAt: created,
    };
  }
}
