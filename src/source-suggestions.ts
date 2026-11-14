import type { Store } from "./db/store";
import {
  SourceSuggestionStore,
  type SourceSuggestionState,
} from "./db/source-suggestion-store";
import { validateManualUrl } from "./manual";

/**
 * Opt-in source-suggestion identification (issue #33). Everything here is
 * deterministic read-only aggregation of already-recorded discovery
 * provenance, explicit item feedback, extraction outcomes and feed-link
 * metadata captured during existing extraction fetches. Nothing here
 * subscribes, fetches, crawls or spends: the only external-boundary action is
 * an explicit operator accept, which routes through the existing
 * source-management path (`Store.addSource`) in one atomic transaction.
 */
export const SOURCE_SUGGESTION_ALGORITHM_VERSION = "source-suggestions-v2";

const FEED_TYPES = /(?:rss|atom)\+xml/i;
const KNOWN_FEED_PATTERNS = [
  "/feed/",
  "/feed",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/feeds/posts/default",
];
const maxFeedLinksPerItem = 10;
const maxFeedLinkChars = 2048;
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
  /** Distinct mirrored items; used with unavailable to exclude from value. */
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
  /**
   * Actionable proposed suggestions: qualifying candidates minus operator-
   * suppressed records, after the refresh display limit. Every qualifying
   * candidate is persisted even beyond this slice (`pendingBeyondLimit`).
   */
  suggestions: SourceSuggestion[];
  /** Qualifying candidates carrying an existing dismissed/muted/accepted decision. */
  suppressed: { suggestion: SourceSuggestion; state: SourceSuggestionState }[];
  /** Previously proposed rows that no longer qualify; persist state is `expired`. */
  expired: string[];
  /** Qualifying candidates persisted beyond the refresh display limit. */
  pendingBeyondLimit: string[];
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
 * suggestions. Extraction captures the same shape while fetching pages, so
 * suggestion generation never needs additional requests.
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

/**
 * Build suggestion candidates from recorded provenance. Read-only: no
 * subscription, budget reservation, provider call or crawl happens here.
 * Qualifying candidates are returned complete (never limit-sliced); the
 * actionable display slice, operator-suppression and eligibility
 * reconciliation are applied by `refreshSourceSuggestions`.
 */
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

  // Latest explicit feedback per item, matching the shipped readers:
  // created_at descending with rowid breaking same-millisecond ties by
  // insertion order (item_feedback.id is a random UUID and must not be
  // mistaken for an ordering key).
  interface FeedbackRow {
    item_id: string;
    useful: number;
    created_at: number;
  }
  const latestFeedback = new Map<string, FeedbackRow>();
  for (const row of store.sqlite
    .query<FeedbackRow, []>(
      "SELECT item_id,useful,created_at FROM item_feedback ORDER BY created_at DESC, rowid DESC",
    )
    .all())
    if (!latestFeedback.has(row.item_id)) latestFeedback.set(row.item_id, row);

  // Unavailability is measured against the item's current extraction
  // generation: a later successful extraction or score proves recovery, so a
  // historical unavailable outcome never permanently suppresses a publisher.
  // This mirrors the shipped processing readers (Store.completeProcessing and
  // the digest readiness query).
  const unavailableItems = new Set(
    store.sqlite
      .query<{ item_id: string }, []>(
        `SELECT DISTINCT pj.item_id FROM processing_jobs pj
        WHERE pj.status='done' AND pj.outcome='unavailable'
          AND ( (pj.stage='extract' AND pj.generation=(SELECT max(generation) FROM processing_jobs x WHERE x.item_id=pj.item_id AND x.stage='extract'))
             OR (pj.stage='score' AND pj.generation=(SELECT max(generation) FROM processing_jobs x WHERE x.item_id=pj.item_id AND x.stage='extract')) )`,
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
  // time on a different domain is recorded duplicate coverage. Groups are
  // built in a single pass tracking the earliest ingestion time and domain,
  // so no per-group history rescan; the row ingested first on the
  // deterministic first domain is the original, later copies are mirrors.
  interface DuplicateGroup {
    hosts: Set<string>;
    minIngest: number;
    minDomain: string;
  }
  const duplicateGroups = new Map<string, DuplicateGroup>();
  for (const row of rows) {
    const domain = domainOf(row.url);
    if (!domain || row.publishedAt === null) continue;
    const key = `${normalizeTitle(row.title)}\u0000${row.publishedAt}`;
    const group = duplicateGroups.get(key);
    if (!group) {
      duplicateGroups.set(key, {
        hosts: new Set([domain]),
        minIngest: row.ingestedAt,
        minDomain: domain,
      });
      continue;
    }
    group.hosts.add(domain);
    if (
      row.ingestedAt < group.minIngest ||
      (row.ingestedAt === group.minIngest && domain < group.minDomain)
    ) {
      group.minIngest = row.ingestedAt;
      group.minDomain = domain;
    }
  }
  const isMirror = (row: ProvenanceRow, domain: string): boolean => {
    if (row.publishedAt === null) return false;
    const key = `${normalizeTitle(row.title)}\u0000${row.publishedAt}`;
    const group = duplicateGroups.get(key);
    if (!group || group.hosts.size < 2) return false;
    return (
      row.ingestedAt > group.minIngest ||
      (row.ingestedAt === group.minIngest && domain !== group.minDomain)
    );
  };
  // A mirrored item keeps counting as unavailable/unusable: both penalized
  // populations union so one item is never discounted twice.
  const isMirrorItem = (row: ProvenanceRow, domain: string): boolean =>
    isMirror(row, domain);

  interface DomainState {
    rows: ProvenanceRow[];
    mirrorItemIds: Set<string>;
  }
  const domains = new Map<string, DomainState>();
  for (const row of rows) {
    const domain = domainOf(row.url);
    if (!domain) continue;
    const state = domains.get(domain) ?? {
      rows: [],
      mirrorItemIds: new Set<string>(),
    };
    state.rows.push(row);
    if (isMirrorItem(row, domain)) state.mirrorItemIds.add(row.itemId);
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
    const duplicateItems = state.mirrorItemIds.size;
    const unavailableIds = new Set<string>();
    for (const itemId of items.keys())
      if (unavailableItems.has(itemId)) unavailableIds.add(itemId);
    const meaningful =
      distinctItems - new Set([...state.mirrorItemIds, ...unavailableIds]).size;

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
        reason: `only ${Math.max(0, meaningful)} meaningful distinct items (minimum ${minItems})`,
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
          Math.max(
            1,
            3 * results + 2 * duplicateItems + 3 * unavailableIds.size,
          ),
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

    // Feed candidates: RSS/Atom link elements captured during existing
    // extraction fetches first, then validated URL patterns only when no
    // recorded declaration exists. All candidates are validated without
    // fetching; accepted URLs are re-validated through source management.
    const candidates: FeedCandidate[] = [];
    const seen = new Set<string>();
    const pushCandidate = (candidate: FeedCandidate) => {
      if (candidates.length >= maxFeedCandidates) return;
      if (seen.has(candidate.url)) return;
      seen.add(candidate.url);
      candidates.push(candidate);
    };
    for (const itemId of [...items.keys()].sort()) {
      const job = store.sqlite
        .query<{ result: string | null }, [string]>(
          `SELECT pj.result AS result FROM processing_jobs pj
          WHERE pj.item_id=? AND pj.stage='extract' AND pj.status='done'
            AND pj.generation=(SELECT max(generation) FROM processing_jobs x WHERE x.item_id=pj.item_id AND x.stage='extract')`,
        )
        .get(itemId);
      const resultText = job?.result;
      if (!resultText) continue;
      let extractionResult: { feedLinks?: unknown } | null = null;
      try {
        extractionResult = JSON.parse(resultText) as {
          feedLinks?: unknown;
        } | null;
      } catch {
        continue;
      }
      const links = extractionResult?.feedLinks;
      if (!Array.isArray(links)) continue;
      const itemUrl = items.get(itemId)!.url;
      for (const raw of links) {
        if (typeof raw !== "string" || raw.length > maxFeedLinkChars) continue;
        try {
          const url = validateManualUrl(new URL(raw, itemUrl).href);
          if (domainOf(url) !== domain) continue;
          pushCandidate({ url, provenance: "link-element" });
        } catch {
          // Malformed, credential-bearing or private destinations are skipped.
        }
      }
    }
    if (candidates.length === 0) {
      // Known legitimate feed URL patterns, annotated as unverified guesses;
      // only used when extraction recorded no explicit feed declaration.
      const baseUrl = items.values().next().value?.url ?? `https://${domain}`;
      for (const candidate of patternCandidates(domain, baseUrl, seen))
        candidates.push(candidate);
    }
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
        unavailableItems: unavailableIds.size,
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
          : "Feed URLs come from link elements captured during recorded extraction; they were not fetched here and are re-validated at accept time.",
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
    suggestions,
    suppressed: [],
    expired: [],
    pendingBeyondLimit: [],
    skipped: skipped.sort((a, b) => a.domain.localeCompare(b.domain)),
    limitations: [
      "Suggestions come only from recorded provenance; no external request, subscription or crawl happens during generation.",
      "High publication volume alone never produces a suggestion; recent explicit feedback is required.",
      "Value for sources without recorded feedback is unknown, not zero.",
    ],
  };
}

export interface RefreshOptions extends SuggestionOptions {
  /**
   * Display limit for actionable proposals. Every qualifying candidate is
   * persisted regardless of this limit; operator-suppressed (dismissed,
   * muted, accepted) candidates never consume it.
   */
  limit?: number;
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
 * Regenerate and persist suggestions, then reconcile persisted state:
 * - operator-suppressed candidates (dismissed/muted/accepted) keep their
 *   decision and are excluded from the actionable slice and its limit;
 * - previously proposed candidates that no longer qualify are marked
 *   `expired` (audited, reversible) so acceptance cannot silently follow a
 *   suggestion that lost its evidence; renewal happens when it qualifies
 *   again;
 * - every qualifying candidate is persisted even beyond the display limit.
 * Deterministic and idempotent: an unchanged replay refreshes nothing.
 */
export function refreshSourceSuggestions(
  store: Store,
  options: RefreshOptions,
): SuggestionRun {
  const { limit = 10, ...generation } = options;
  const all = generateSourceSuggestions(store, generation);
  const suggestions = new SourceSuggestionStore(store.sqlite);
  const persisted = new Map(suggestions.list().map((row) => [row.id, row]));
  const qualifying = new Set(all.suggestions.map((s) => s.id));

  const suppressed: {
    suggestion: SourceSuggestion;
    state: SourceSuggestionState;
  }[] = [];
  const actionable: SourceSuggestion[] = [];
  for (const suggestion of all.suggestions) {
    const existing = persisted.get(suggestion.id);
    if (
      existing &&
      existing.state !== "proposed" &&
      existing.state !== "expired"
    ) {
      // Keep the operator decision and refresh the evidence in place.
      suggestions.upsert([suggestion], options.now);
      suppressed.push({ suggestion, state: existing.state });
      continue;
    }
    if (existing && existing.state === "expired")
      suggestions.reconcile(suggestion.id, "proposed", options.now);
    suggestions.upsert([suggestion], options.now);
    actionable.push(suggestion);
  }

  const expired: string[] = [];
  for (const row of persisted.values()) {
    if (row.state !== "proposed" || qualifying.has(row.id)) continue;
    suggestions.reconcile(row.id, "expired", options.now);
    expired.push(row.id);
  }

  expired.sort();
  const visible = actionable.slice(0, limit);
  const pendingBeyondLimit = actionable
    .slice(limit)
    .map((s) => s.id)
    .sort();
  return {
    ...all,
    suggestions: visible,
    suppressed: suppressed.sort((a, b) =>
      a.suggestion.id.localeCompare(b.suggestion.id),
    ),
    expired,
    pendingBeyondLimit,
  };
}

/**
 * Accept a suggestion by subscribing through the existing source-management
 * path. The state read, guard checks, source write and audit event run in
 * one immediate transaction on the same connection, so acceptance either
 * commits completely or changes nothing: a concurrent mute cannot leave an
 * accepted subscription behind, and a crash cannot leave a subscription
 * without its accepted-state record. This is the only function here that
 * changes subscriptions, and it must be invoked explicitly by an operator;
 * nothing in discovery calls it. The validation performed before or inside
 * the transaction is local only (URL/shape checks; never network I/O).
 */
export function acceptSourceSuggestion(
  store: Store,
  suggestionId: string,
  options: AcceptOptions,
): AcceptOutcome {
  const suggestions = new SourceSuggestionStore(store.sqlite);
  const outcome = store.sqlite
    .transaction((): AcceptOutcome => {
      const record = suggestions.get(suggestionId);
      if (!record) throw new Error("Unknown source suggestion");
      if (record.state === "muted")
        throw new Error("Muted suggestion cannot be accepted; unmute it first");
      if (record.state === "expired")
        throw new Error(
          "Expired suggestion cannot be accepted; regenerate suggestions first",
        );
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
    })
    .immediate();
  return outcome;
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

export {
  SourceSuggestionStore,
  type SourceSuggestionRecord,
  type SourceSuggestionState,
} from "./db/source-suggestion-store";
