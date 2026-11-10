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
export function identity(candidate: Candidate, sourceId: string): string {
  return candidate.url
    ? `url:${canonicalUrl(candidate.url)}`
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
