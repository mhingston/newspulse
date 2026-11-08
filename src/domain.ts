export interface Candidate {
  nativeId: string;
  url?: string;
  title: string;
  text: string;
  publishedAt?: number;
  children?: { url: string; title: string }[];
}
export interface PollState {
  etag?: string;
  lastModified?: string;
}
export interface PollResult extends PollState {
  items: Candidate[];
  notModified?: boolean;
}
export interface SourceAdapter {
  poll(url: string, state: PollState): Promise<PollResult>;
}
export function canonicalUrl(value: string, base?: string): string {
  const u = new URL(value, base);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error("Expected HTTP(S) URL without credentials");
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
