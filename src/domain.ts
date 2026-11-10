export interface Candidate {
  nativeId: string;
  url?: string;
  /** Original resolved citation, including meaningful fragments/tracking context. */
  sourceUrl?: string;
  title: string;
  text: string;
  publishedAt?: number;
  children?: { url: string; sourceUrl?: string; title: string }[];
}
export interface PollState {
  cursor?: string;
  etag?: string;
  lastModified?: string;
}
export interface PollResult extends PollState {
  items: Candidate[];
  notModified?: boolean;
  entryCount?: number;
  truncated?: boolean;
}
export interface SourceAdapter {
  poll(
    url: string,
    state: PollState,
    limits?: { maxEntries: number; maxBytes: number },
  ): Promise<PollResult>;
}
export function resolvedUrl(value: string, base?: string): string {
  const u = new URL(value, base);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error("Expected HTTP(S) URL without credentials");
  return u.href;
}
export function canonicalUrl(value: string, base?: string): string {
  const u = new URL(resolvedUrl(value, base));
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (/^utm_|^(fbclid|gclid)$/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href;
}
export interface RedditDiscussion {
  postId: string;
  subreddit?: string;
  /** Host-independent discussion identity shared by redd.it and reddit.com. */
  canonicalUrl: string;
  originalUrl: string;
}

const redditHosts = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "m.reddit.com",
  "np.reddit.com",
  "redd.it",
]);

/**
 * Reddit exposes the same discussion through many hosts and short links.
 * Identity is the post ID, so a search result, a digest email and a manual
 * submission resolve to one item; the original URL is retained separately.
 */
export function parseRedditDiscussion(
  value: string,
  base?: string,
): RedditDiscussion | null {
  let url: URL;
  try {
    url = new URL(resolvedUrl(value, base));
  } catch {
    return null;
  }
  if (!redditHosts.has(url.hostname.toLowerCase())) return null;
  const postId =
    /^\/r\/[A-Za-z0-9_]{1,50}\/comments\/([A-Za-z0-9]{1,20})(?:\/|$)/.exec(
      url.pathname,
    )?.[1] ??
    /^\/comments\/([A-Za-z0-9]{1,20})(?:\/|$)/.exec(url.pathname)?.[1] ??
    (url.hostname.toLowerCase() === "redd.it"
      ? /^\/([A-Za-z0-9]{1,20})\/?$/.exec(url.pathname)?.[1]
      : undefined);
  if (!postId) return null;
  const id = postId.toLowerCase();
  return {
    postId: id,
    subreddit: /^\/r\/([A-Za-z0-9_]{1,50})\/comments\//
      .exec(url.pathname)?.[1]
      ?.toLowerCase(),
    canonicalUrl: `https://www.reddit.com/comments/${id}`,
    originalUrl: url.href,
  };
}

/**
 * Canonical identity for an item URL. Reddit discussions collapse to their
 * post ID; every other URL uses the ordinary canonical form. Source/feed URLs
 * keep using `canonicalUrl` so a Reddit feed is not rewritten.
 */
export function canonicalItemUrl(value: string, base?: string): string {
  return (
    parseRedditDiscussion(value, base)?.canonicalUrl ??
    canonicalUrl(value, base)
  );
}

export function identity(candidate: Candidate, sourceId: string): string {
  return candidate.url
    ? `url:${canonicalItemUrl(candidate.url)}`
    : `source:${sourceId}:${candidate.nativeId}`;
}

/** Followed GitHub repository streams; the URL is a stable source identifier. */
export type GithubSourceStream = "releases" | "events";
export interface GithubSource {
  owner: string;
  repo: string;
  stream: GithubSourceStream;
}
export function githubSourceUrl(
  repository: string,
  stream: GithubSourceStream,
): string {
  const match =
    /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(?:\.git)?$/.exec(
      repository.trim(),
    );
  if (
    !match ||
    match[1] === "." ||
    match[1] === ".." ||
    match[2] === "." ||
    match[2] === ".."
  )
    throw new Error("Expected a GitHub repository as OWNER/REPO");
  return `https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}/${stream}`;
}
export function parseGithubSource(value: string): GithubSource | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com")
    return null;
  const match =
    /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(releases|events)\/?$/.exec(
      url.pathname,
    );
  if (!match || url.search || url.hash || url.username || url.password)
    return null;
  return {
    owner: match[1]!.toLowerCase(),
    repo: match[2]!.replace(/\.git$/i, "").toLowerCase(),
    stream: match[3] as GithubSourceStream,
  };
}
export function isGithubSourceUrl(url: string): boolean {
  return parseGithubSource(url) !== null;
}

/** Hacker News list feeds exposed by the official Firebase API. */
export type HackerNewsList = "top" | "new" | "best" | "ask" | "show" | "job";
export type HackerNewsSource =
  { kind: "item"; id: number } | { kind: "list"; list: HackerNewsList };

const hackerNewsLists: Record<string, HackerNewsList> = {
  "/": "top",
  "/news": "top",
  "/top": "top",
  "/newest": "new",
  "/new": "new",
  "/best": "best",
  "/ask": "ask",
  "/show": "show",
  "/jobs": "job",
  "/job": "job",
};

/**
 * A followed HN source is either one discussion item or one of the public list
 * feeds. Item identity is the discussion URL; a linked article is a separate
 * child item so RSS coverage is not duplicated.
 */
export function parseHackerNewsSource(value: string): HackerNewsSource | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "news.ycombinator.com" ||
    url.username ||
    url.password ||
    url.hash
  )
    return null;
  if (url.pathname === "/item") {
    const id = url.searchParams.get("id");
    if (
      !id ||
      !/^[1-9]\d{0,9}$/.test(id) ||
      url.searchParams.size !== 1 ||
      Number(id) > 2_147_483_647
    )
      return null;
    return { kind: "item", id: Number(id) };
  }
  if (url.search) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const list = hackerNewsLists[path];
  return list ? { kind: "list", list } : null;
}
export function isHackerNewsSourceUrl(url: string): boolean {
  return parseHackerNewsSource(url) !== null;
}
