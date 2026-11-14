import type { Store } from "./db/store";
import {
  SourceSuggestionStore,
  type SourceSuggestionState,
} from "./db/source-suggestion-store";
import { validateManualUrl } from "./manual";

/**
 * Opt-in source-suggestion identification (issue #33). Everything here is
 * deterministic, read-only aggregation of already-recorded discovery
 * provenance, explicit item feedback and extraction outcomes. Nothing here
 * subscribes, fetches, crawls or spends: the only external-boundary action is
 * an explicit operator accept, which routes through the existing
 * source-management path (`Store.addSource`).
 */
export const SOURCE_SUGGESTION_ALGORITHM_VERSION = "source-suggestions-v1";

const UNAVAILABLE_STAGES = "('extract','score')";
const FEED_TYPES = /rss\+xml|atom\+xml/i;
const KNOWN_FEED_PATTERNS = [
  "/feed/",
  "/feed",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/feeds/posts/default",
];
const maxFeedLinksPerItem = 20;
const maxContentScanChars = 512_000;
const maxTitleChars = 1000;

export type SuggestionState = SourceSuggestionState;

export interface SuggestionEvidence {
  itemId: string;
  title: string;
  url: string;
  feedback: "useful" | "not_useful" | null;
  publishedAt: number | null;
}

export interface FeedCandidate {
  url: string;
  provenance: "link-element" | "url-pattern";
}

export interface SourceSuggestionStats {
  distinctItems: number;
  results: number;
  usefulItems: number;
  notUsefulItems: number;
  usefulOutsideWindow: number;
  duplicateItems: number;
  unavailableItems: number;
  distinctPublishDays: number;
  repetitionRatio: number;
  duplicateRate: number;
  positiveShare: number | null;
  newestPublishedAt: number | null;
}

export interface SourceSuggestion {
  id: string;
  kind: "domain";
  domain: string;
  /** Best validated feed candidate when one exists, else the origin URL. */
  url: string;
  title: string;
  score: number;
  stats: SourceSuggestionStats;
  explanation: string;
  evidence: SuggestionEvidence[];
  feedCandidates: FeedCandidate[];
  limitations: string[];
  algorithmVersion: string;
}

export interface SkippedCandidate {
  domain: string;
  reason: string;
}

export interface SuggestionRun {
  algorithmVersion: string;
  generatedAt: number;
  scanned: {
    discoveryResults: number;
    domains: number;
    domainsWithFeedback: number;
    unavailableItems: number;
  };
  suggestions: SourceSuggestion[];
  skipped: SkippedCandidate[];
  limitations: string[];
}

export interface SuggestionOptions {
  now: number;
  /** Only recent explicit feedback and fresh publication count for value. */
  windowDays?: number;
  minItems?: number;
  minUseful?: number;
  proposeThreshold?: number;
  limit?: number;
  maxFeedCandidates?: number;
  maxEvidenceItems?: number;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function domainOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase();
    if (!host) return null;
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isRedditDomain(domain: string): boolean {
  return (
    domain === "redd.it" ||
    domain === "reddit.com" ||
    domain.endsWith(".reddit.com")
  );
}

function dayOf(timestamp: number | null): string | null {
  return timestamp === null
    ? null
    : new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Conservative feed auto-discovery from a bounded HTML string. Only RSS/Atom
 * `<link rel=alternate type=...>` declarations and anchors carrying an
 * explicit RSS/Atom type are recognized. URLs resolve against the recorded
 * page's own host, are validated without fetching, and only ever become
 * suggestions.
 */
export function extractFeedLinks(html: string, base: string): FeedCandidate[] {
  if (html.length > maxContentScanChars)
    html = html.slice(0, maxContentScanChars);
  const baseHost = new URL(validateManualUrl(base)).hostname.toLowerCase();
  const found: FeedCandidate[] = [];
  const seen = new Set<string>();
  const push = (href: string) => {
    if (found.length >= maxFeedLinksPerItem) return;
    try {
      const url = validateManualUrl(new URL(href, base).href);
      if (new URL(url).hostname.toLowerCase() !== baseHost) return;
      if (seen.has(url)) return;
      seen.add(url);
      found.push({ url, provenance: "link-element" });
    } catch {
      // Malformed, credential-bearing or private destinations are skipped.
    }
  };
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const tagText = tag[0]!;
    const type = /type\s*=\s*["']([^"']*)["']/i.exec(tagText)?.[1] ?? "";
    const rel = /rel\s*=\s*["']([^"']*)["']/i.exec(tagText)?.[1] ?? "";
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(tagText)?.[1];
    if (!href || !FEED_TYPES.test(type)) continue;
    if (rel && !/\balternate\b/i.test(rel)) continue;
    push(href);
  }
  for (const tag of html.matchAll(/<a\b[^>]*>/gi)) {
    const tagText = tag[0]!;
    const type = /type\s*=\s*["']([^"']*)["']/i.exec(tagText)?.[1] ?? "";
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(tagText)?.[1];
    if (!href || !FEED_TYPES.test(type)) continue;
    push(href);
  }
  return found;
}

function patternCandidates(
  domain: string,
  base: string,
  existing: ReadonlySet<string>,
): FeedCandidate[] {
  const candidates: FeedCandidate[] = [];
  for (const pattern of KNOWN_FEED_PATTERNS) {
    try {
      const url = validateManualUrl(new URL(pattern, base).href);
      if (domainOf(url) !== domain) continue;
      if (existing.has(url)) continue;
      candidates.push({ url, provenance: "url-pattern" });
    } catch {
      // Skip anything the shared public-host validation rejects.
    }
  }
  return candidates;
}

interface ProvenanceRow {
  itemId: string;
  title: string;
  url: string;
  publishedAt: number | null;
  ingestedAt: number;
}

/** Build suggestion candidates from recorded provenance. Read-only. */
export function generateSourceSuggestions(
  store: Store,
  options: SuggestionOptions,
): SuggestionRun {
  const {
    now,
    windowDays = 60,
    minItems = 3,
    minUseful = 1,
    proposeThreshold = 30,
    limit = 10,
    maxFeedCandidates = 3,
    maxEvidenceItems = 3,
  } = options;
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid suggestion generation time");

  const rows = store.sqlite
    .query<ProvenanceRow, []>(
      `SELECT it.id AS itemId, it.title AS title, it.url AS url,
              it.published_at AS publishedAt, it.ingested_at AS ingestedAt
      FROM discovery_results dr JOIN items it ON it.id=dr.item_id
      WHERE dr.origin='discovered' AND it.url IS NOT NULL AND it.url<>''`,
    )
    .all();

  // Latest explicit feedback per item; deterministic by timestamp then id.
  interface FeedbackRow {
    item_id: string;
    useful: number;
    created_at: number;
  }
  const latestFeedback = new Map<string, FeedbackRow>();
  for (const row of store.sqlite
    .query<FeedbackRow, []>(
      "SELECT item_id,useful,created_at FROM item_feedback ORDER BY created_at DESC, id DESC",
    )
    .all())
    if (!latestFeedback.has(row.item_id)) latestFeedback.set(row.item_id, row);

  const unavailableItems = new Set(
    store.sqlite
      .query<{ item_id: string }, []>(
        `SELECT DISTINCT item_id FROM processing_jobs
         WHERE status='done' AND outcome='unavailable' AND stage IN ${UNAVAILABLE_STAGES}`,
      )
      .all()
      .map((row) => row.item_id),
  );

  const subscribedDomains = new Set<string>();
  for (const source of store.sqlite
    .query<{ url: string }, []>("SELECT url FROM sources WHERE removed=0")
    .all()) {
    const domain = domainOf(source.url);
    if (domain) subscribedDomains.add(domain);
  }

  // Duplicate mirrors: an identical normalized title published at the same
  // time on a different domain is recorded duplicate coverage. The row
  // ingested first on the deterministic first domain counts as the original;
  // later copies are the duplicated rows.
  const duplicateKeys = new Map<
    string,
    { hosts: Set<string>; minIngest: number; minDomain: string }
  >();
  for (const row of rows) {
    const domain = domainOf(row.url);
    if (!domain || row.publishedAt === null) continue;
    const key = `${normalizeTitle(row.title)}\u0000${row.publishedAt}`;
    const group = duplicateKeys.get(key);
    if (!group)
      duplicateKeys.set(key, {
        hosts: new Set([domain]),
        minIngest: row.ingestedAt,
        minDomain: domain,
      });
    else group.hosts.add(domain);
  }
  for (const [key, group] of duplicateKeys) {
    if (group.hosts.size < 2) {
      duplicateKeys.delete(key);
      continue;
    }
    for (const row of rows) {
      const domain = domainOf(row.url);
      if (!domain || row.publishedAt === null) continue;
      const rowKey = `${normalizeTitle(row.title)}\u0000${row.publishedAt}`;
      if (rowKey !== key) continue;
      if (
        row.ingestedAt < group.minIngest ||
        (row.ingestedAt === group.minIngest && domain < group.minDomain)
      ) {
        group.minIngest = row.ingestedAt;
        group.minDomain = domain;
      }
    }
  }
  const isMirror = (row: ProvenanceRow, domain: string): boolean => {
    if (row.publishedAt === null) return false;
    const key = `${normalizeTitle(row.title)}\u0000${row.publishedAt}`;
    const group = duplicateKeys.get(key);
    if (!group) return false;
    return (
      row.ingestedAt > group.minIngest ||
      (row.ingestedAt === group.minIngest && domain !== group.minDomain)
    );
  };

  interface DomainState {
    rows: ProvenanceRow[];
    duplicateCount: number;
  }
  const domains = new Map<string, DomainState>();
  for (const row of rows) {
    const domain = domainOf(row.url);
    if (!domain) continue;
    const state = domains.get(domain) ?? { rows: [], duplicateCount: 0 };
    state.rows.push(row);
    if (isMirror(row, domain)) state.duplicateCount++;
    domains.set(domain, state);
  }

  const windowStart = now - windowDays * 86_400_000;
  const suggestions: SourceSuggestion[] = [];
  const skipped: SkippedCandidate[] = [];
  let domainsWithFeedback = 0;
  for (const domain of [...domains.keys()].sort()) {
    const state = domains.get(domain)!;
    const items = new Map<string, ProvenanceRow>();
    for (const row of state.rows) items.set(row.itemId, row);
    if (subscribedDomains.has(domain)) {
      skipped.push({ domain, reason: "already-subscribed" });
      continue;
    }
    if (isRedditDomain(domain)) {
      skipped.push({
        domain,
        reason:
          "reddit coverage from search snippets is not community coverage; permitted discovery or explicit submission required",
      });
      continue;
    }

    const distinctItems = items.size;
    const duplicateItems = state.duplicateCount;
    let unavailableCount = 0;
    for (const itemId of items.keys())
      if (unavailableItems.has(itemId)) unavailableCount++;
    const meaningful = Math.max(
      0,
      distinctItems - duplicateItems - unavailableCount,
    );

    // Explicit feedback drives value: useful must be recent, negative always
    // counts, and stale usefulness never substitutes for current quality.
    let usefulItems = 0;
    let notUsefulItems = 0;
    let usefulOutsideWindow = 0;
    for (const itemId of items.keys()) {
      const feedback = latestFeedback.get(itemId);
      if (!feedback) continue;
      if (feedback.useful === 1) {
        if (feedback.created_at >= windowStart) usefulItems++;
        else usefulOutsideWindow++;
      } else notUsefulItems++;
    }
    if (usefulItems + notUsefulItems > 0) domainsWithFeedback++;

    const publishDays = new Set(
      [...items.values()]
        .map((row) => dayOf(row.publishedAt))
        .filter((day): day is string => day !== null),
    );
    const newest = items
      .values()
      .reduce<number | null>(
        (acc, row) =>
          row.publishedAt === null
            ? acc
            : Math.max(acc ?? -Infinity, row.publishedAt),
        null,
      );
    const results = state.rows.length;
    const repetitionRatio = distinctItems ? results / distinctItems : results;
    const duplicateRate = distinctItems ? duplicateItems / distinctItems : 0;

    if (meaningful < minItems) {
      skipped.push({
        domain,
        reason: `only ${meaningful} meaningful distinct items (minimum ${minItems})`,
      });
      continue;
    }
    if (usefulOutsideWindow > 0 && usefulItems < minUseful) {
      skipped.push({
        domain,
        reason: `latest useful feedback is ${windowDays}+ days old while recent feedback is negative; recorded recent quality decline`,
      });
      continue;
    }
    if (usefulItems < minUseful) {
      skipped.push({
        domain,
        reason: `${usefulItems} useful items inside the ${windowDays}-day window (minimum ${minUseful})`,
      });
      continue;
    }
    if (newest !== null && newest < windowStart) {
      skipped.push({
        domain,
        reason: "no publication within the freshness window",
      });
      continue;
    }

    let score = Math.min(
      100,
      Math.round(
        (100 *
          (3 * usefulItems +
            Math.max(0, meaningful - usefulItems) -
            2 * notUsefulItems)) /
          Math.max(1, 3 * results + 2 * duplicateItems + 3 * unavailableCount),
      ),
    );
    const repetitive = repetitionRatio > 4;
    if (repetitive) score = Math.floor(score / 2);
    if (score < proposeThreshold) {
      skipped.push({
        domain,
        reason: `score ${score} below proposal threshold ${proposeThreshold}`,
      });
      continue;
    }

    // Feed candidates: recorded link elements first, then validated URL
    // patterns. Both are validated without fetching.
    const candidates: FeedCandidate[] = [];
    const seen = new Set<string>();
    for (const itemId of [...items.keys()].sort()) {
      const content = store.sqlite
        .query<{ text: string; url: string | null }, [string]>(
          "SELECT c.text AS text, it.url AS url FROM content c JOIN items it ON it.id=c.item_id WHERE c.item_id=? AND c.purged_at IS NULL AND length(c.text)>0",
        )
        .get(itemId);
      if (!content) continue;
      const html = content.text.slice(0, maxContentScanChars);
      if (!/<link\b|<a\b/i.test(html)) continue;
      for (const candidate of extractFeedLinks(
        html,
        content.url ?? `https://${domain}`,
      ))
        if (!seen.has(candidate.url)) {
          seen.add(candidate.url);
          candidates.push(candidate);
        }
    }
    // Known legitimate feed URL patterns, annotated as unverified guesses.
    const baseUrl = items.values().next().value?.url ?? `https://${domain}`;
    for (const candidate of patternCandidates(domain, baseUrl, seen))
      candidates.push(candidate);
    const bounded = candidates.slice(0, maxFeedCandidates);

    const explanation = [
      `${usefulItems} useful of ${meaningful} meaningful distinct items in the last ${windowDays} days`,
      `duplicate rate ${(duplicateRate * 100).toFixed(0)}%`,
      `repetition ${repetitionRatio.toFixed(1)}x results per distinct item`,
      newest !== null
        ? `newest publication ${Math.round((now - newest) / 86_400_000)} days ago`
        : "no recorded publication timestamps",
    ].join("; ");
    const evidence: SuggestionEvidence[] = [...items.values()]
      .sort((a, b) => a.itemId.localeCompare(b.itemId))
      .slice(0, maxEvidenceItems)
      .map((row) => ({
        itemId: row.itemId,
        title: row.title.slice(0, maxTitleChars),
        url: row.url.slice(0, 8192),
        feedback: null,
        publishedAt: row.publishedAt,
      }));
    for (const entry of evidence) {
      const feedback = latestFeedback.get(entry.itemId);
      if (feedback)
        entry.feedback = feedback.useful === 1 ? "useful" : "not_useful";
    }

    suggestions.push({
      id: `domain:${domain}`,
      kind: "domain",
      domain,
      url: bounded[0]?.url ?? `https://${domain}`,
      title: domain,
      score,
      stats: {
        distinctItems,
        results,
        usefulItems,
        notUsefulItems,
        usefulOutsideWindow,
        duplicateItems,
        unavailableItems: unavailableCount,
        distinctPublishDays: publishDays.size,
        repetitionRatio,
        duplicateRate,
        positiveShare:
          usefulItems + notUsefulItems > 0
            ? usefulItems / (usefulItems + notUsefulItems)
            : null,
        newestPublishedAt: newest,
      },
      explanation,
      evidence,
      feedCandidates: bounded,
      limitations: [
        "Coverage is limited to what recorded discovery runs already retrieved; no claim of full publisher coverage.",
        bounded.some((candidate) => candidate.provenance === "url-pattern")
          ? "Some feed URLs are conservative pattern guesses; they were never fetched and are re-validated at accept time."
          : "Feed URLs come from recorded link elements; they were not fetched and are re-validated at accept time.",
        "Suggestions never subscribe: accepting is an explicit operator action through existing source management.",
      ],
      algorithmVersion: SOURCE_SUGGESTION_ALGORITHM_VERSION,
    });
  }

  suggestions.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    algorithmVersion: SOURCE_SUGGESTION_ALGORITHM_VERSION,
    generatedAt: now,
    scanned: {
      discoveryResults: rows.length,
      domains: domains.size,
      domainsWithFeedback,
      unavailableItems: unavailableItems.size,
    },
    suggestions: suggestions.slice(0, limit),
    skipped: skipped.sort((a, b) => a.domain.localeCompare(b.domain)),
    limitations: [
      "Suggestions come only from recorded provenance; no external request, subscription or crawl happens during generation.",
      "High publication volume alone never produces a suggestion; recent explicit feedback is required.",
      "Value for sources without recorded feedback is unknown, not zero.",
    ],
  };
}

export interface AcceptOptions {
  now: number;
  pollSeconds?: number;
}

export interface AcceptOutcome {
  suggestionId: string;
  sourceId: string;
  url: string;
  state: SourceSuggestionState;
  /** False when the suggestion was already accepted (idempotent replay). */
  changed: boolean;
}

/**
 * Accept a suggestion by subscribing through the existing source-management
 * path. This is the only function here that changes subscriptions, and it must
 * be invoked explicitly by an operator; nothing in discovery calls it.
 */
export function acceptSourceSuggestion(
  store: Store,
  suggestionId: string,
  options: AcceptOptions,
): AcceptOutcome {
  const suggestions = new SourceSuggestionStore(store.sqlite);
  const record = suggestions.get(suggestionId);
  if (!record) throw new Error("Unknown source suggestion");
  if (record.state === "muted")
    throw new Error("Muted suggestion cannot be accepted; unmute it first");
  if (record.state === "accepted" && record.acceptedSourceId) {
    // Idempotent replay: the source already exists; change nothing.
    return {
      suggestionId,
      sourceId: record.acceptedSourceId,
      url: record.url,
      state: record.state,
      changed: false,
    };
  }
  const url = validateManualUrl(record.url);
  const source = store.addSource(
    url,
    record.title || record.domain,
    options.pollSeconds ?? 1800,
  );
  suggestions.setState(suggestionId, "accepted", options.now, source.id);
  return {
    suggestionId,
    sourceId: source.id,
    url: source.url,
    state: "accepted",
    changed: true,
  };
}

export function dismissSourceSuggestion(
  store: Store,
  suggestionId: string,
  now: number,
) {
  return new SourceSuggestionStore(store.sqlite).setState(
    suggestionId,
    "dismissed",
    now,
  );
}

export function muteSourceSuggestion(
  store: Store,
  suggestionId: string,
  now: number,
) {
  return new SourceSuggestionStore(store.sqlite).setState(
    suggestionId,
    "muted",
    now,
  );
}

/** Re-propose a muted suggestion after explicit review. */
export function unmuteSourceSuggestion(
  store: Store,
  suggestionId: string,
  now: number,
) {
  return new SourceSuggestionStore(store.sqlite).setState(
    suggestionId,
    "proposed",
    now,
  );
}

/**
 * Regenerate and persist suggestions. Deterministic and idempotent: running
 * twice with unchanged data refreshes nothing and never resets operator
 * decisions on dismissed, muted or accepted rows.
 */
export function refreshSourceSuggestions(
  store: Store,
  options: SuggestionOptions,
): SuggestionRun {
  const run = generateSourceSuggestions(store, options);
  new SourceSuggestionStore(store.sqlite).upsert(run.suggestions, options.now);
  return run;
}

export {
  SourceSuggestionStore,
  type SourceSuggestionRecord,
  type SourceSuggestionState,
} from "./db/source-suggestion-store";
