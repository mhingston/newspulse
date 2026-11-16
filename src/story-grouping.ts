import { createHash } from "node:crypto";

/**
 * High-precision, source-preserving grouping. This module has no database,
 * network or model dependencies. It deliberately favours false negatives over
 * silently merging distinct developments.
 */
export const STORY_RULE_VERSION = "specific-development-v1";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const uninformative = new Set(
  "a an and are as at be by for from has have in into is it its of on or the their this to was were with without via after before amid amid new latest report reports says say according more first next now".split(
    " ",
  ),
);
const broadTopic = new Set(
  "ai artificial intelligence technology tech software hardware model models system systems company companies industry market update updates news research study studies announcement article details feature features tools tool platform platforms".split(
    " ",
  ),
);
const verbs: Record<string, string[]> = {
  release: [
    "release",
    "releases",
    "released",
    "launch",
    "launches",
    "launched",
    "unveil",
    "unveils",
    "unveiled",
    "debut",
    "debuts",
    "introduced",
    "introduces",
    "available",
    "ships",
    "shipped",
  ],
  recall: [
    "recall",
    "recalls",
    "recalled",
    "withdraw",
    "withdraws",
    "withdrawn",
  ],
  funding: ["funding", "funded", "raises", "raised", "investment", "invests"],
  acquisition: [
    "acquire",
    "acquires",
    "acquired",
    "buy",
    "buys",
    "bought",
    "merger",
  ],
  outage: ["outage", "offline", "down", "disruption", "disrupted", "restored"],
  lawsuit: ["lawsuit", "sues", "sued", "litigation", "court", "ruling"],
  approval: ["approved", "approval", "authorised", "authorized", "cleared"],
  security: [
    "breach",
    "breached",
    "hack",
    "hacked",
    "exploit",
    "vulnerability",
  ],
  retirement: ["retire", "retires", "retired", "shutdown", "discontinued"],
};
const actions = new Map(
  Object.entries(verbs).flatMap(([action, words]) =>
    words.map((word) => [word, action] as const),
  ),
);

export interface StoryInput {
  id: string;
  identity: string;
  url: string | null;
  title: string;
  text: string;
  publishedAt: number | null;
  ingestedAt: number;
}
export interface StoryEvidence {
  reason: "anchor" | "syndicated_content" | "specific_event";
  matchedAgainst?: string;
  sharedTerms?: string[];
  action?: string;
  temporalGapHours?: number;
  contentHash?: string;
  canonicalUrl?: string | null;
}
export interface StoryMember {
  itemId: string;
  identity: string;
  evidence: StoryEvidence;
}
export interface StoryGroup {
  id: string;
  members: StoryMember[];
  firstAt: number;
  lastAt: number;
}
export interface StoryRelation {
  olderGroupId: string;
  newerGroupId: string;
  reason: "later_related_development";
  sharedTerms: string[];
}
export interface StoryPlan {
  version: typeof STORY_RULE_VERSION;
  groups: StoryGroup[];
  relations: StoryRelation[];
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function words(value: string): string[] {
  return value.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? [];
}
function terms(value: string): string[] {
  return [
    ...new Set(
      words(value).filter(
        (word) =>
          (word.length >= 3 || /\d/.test(word)) &&
          !uninformative.has(word) &&
          !broadTopic.has(word) &&
          !actions.has(word),
      ),
    ),
  ].sort();
}
/**
 * Keep dotted release versions intact; a shared calendar year is not evidence
 * that two product versions agree.
 */
function versions(title: string): string[] {
  const matches = title
    .toLocaleLowerCase("en")
    .matchAll(/(?<![\p{L}\p{N}])v?\d+(?:\.\d+)*(?![\p{L}\p{N}])/gu);
  return [
    ...new Set(
      [...matches]
        .map((match) => match[0]!.replace(/^v(?=\d)/, ""))
        .filter((token) => !/^(?:19|20)\d{2}$/.test(token)),
    ),
  ].sort();
}

/**
 * Shared vendor, number and topic terms alone cannot identify a product.
 * Require at least two agreeing explicit named identifiers, with no conflicts.
 * This deliberately favours splitting ambiguous coverage over false merges.
 */
function namedSubjects(title: string): string[] {
  return [
    ...new Set(
      (title.match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter(
          (word) => /^\p{Lu}/u.test(word) || /[\p{Ll}][\p{Lu}]/u.test(word),
        )
        .map((word) => word.toLocaleLowerCase("en"))
        .filter(
          (word) =>
            !uninformative.has(word) &&
            !broadTopic.has(word) &&
            !actions.has(word),
        ),
    ),
  ].sort();
}

function actionOf(title: string): string | null {
  const found = new Set(words(title).map((word) => actions.get(word)));
  found.delete(undefined);
  return found.size === 1 ? [...found][0]! : null;
}
function at(item: StoryInput): number {
  return item.publishedAt ?? item.ingestedAt;
}
function common(a: string[], b: string[]): string[] {
  const right = new Set(b);
  return a.filter((term) => right.has(term));
}
function contentHash(item: StoryInput): string | null {
  const normalized = item.text.replace(/\s+/g, " ").trim().toLowerCase();
  // Very short or boilerplate-only feed descriptions are not evidence of syndication.
  const vocabulary = new Set(words(normalized));
  return normalized.length >= 160 && vocabulary.size >= 12
    ? sha(normalized)
    : null;
}
/**
 * Per-item features are pure functions of one item, but pair comparison asks
 * for them O(n·k) times. Memoising them per input object keeps planning linear
 * in the feature work while leaving every comparison result unchanged.
 */
const features = new WeakMap<
  StoryInput,
  {
    hash: string | null;
    action: string | null;
    terms: string[];
    versions: string[];
    subjects: string[];
  }
>();
function featuresOf(item: StoryInput) {
  let cached = features.get(item);
  if (!cached) {
    cached = {
      hash: contentHash(item),
      action: actionOf(item.title),
      terms: terms(item.title),
      versions: versions(item.title),
      subjects: namedSubjects(item.title),
    };
    features.set(item, cached);
  }
  return cached;
}
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
function sameVersions(left: StoryInput, right: StoryInput): boolean {
  return sameList(featuresOf(left).versions, featuresOf(right).versions);
}
function sameSubjects(left: StoryInput, right: StoryInput): boolean {
  const subjects = featuresOf(left).subjects;
  return subjects.length >= 2 && sameList(subjects, featuresOf(right).subjects);
}
function sameDevelopment(
  left: StoryInput,
  right: StoryInput,
): StoryEvidence | null {
  const leftFeatures = featuresOf(left);
  const rightFeatures = featuresOf(right);
  const leftHash = leftFeatures.hash;
  const rightHash = rightFeatures.hash;
  if (leftHash && leftHash === rightHash) {
    return {
      reason: "syndicated_content",
      matchedAgainst: left.id,
      contentHash: leftHash,
      canonicalUrl: right.url,
    };
  }
  const gap = Math.abs(at(left) - at(right));
  if (gap > 72 * HOUR) return null;
  const action = leftFeatures.action;
  if (!action || action !== rightFeatures.action) return null;
  const leftTerms = leftFeatures.terms;
  const rightTerms = rightFeatures.terms;
  const shared = common(leftTerms, rightTerms);
  if (!sameVersions(left, right)) return null;
  if (!sameSubjects(left, right)) return null;
  if (
    shared.length < 2 ||
    shared.length / Math.max(leftTerms.length, rightTerms.length) < 0.7
  )
    return null;
  return {
    reason: "specific_event",
    matchedAgainst: left.id,
    action,
    sharedTerms: shared,
    temporalGapHours: gap / HOUR,
    canonicalUrl: right.url,
  };
}
function followUp(
  earlier: StoryInput,
  later: StoryInput,
  precomputed?: { older: string[]; newer: string[] },
): string[] | null {
  const gap = at(later) - at(earlier);
  if (gap < 4 * DAY || gap > 90 * DAY) return null;
  const olderTerms = precomputed?.older ?? terms(earlier.title);
  const newerTerms = precomputed?.newer ?? terms(later.title);
  if (!sameVersions(earlier, later)) return null;
  if (!sameSubjects(earlier, later)) return null;
  const overlap = common(olderTerms, newerTerms);
  return overlap.length >= 2 &&
    overlap.length / Math.max(olderTerms.length, newerTerms.length) >= 0.7
    ? overlap
    : null;
}
/**
 * Complete-link clustering prevents an ambiguous intermediary from connecting
 * two unrelated events. Sorting by canonical identity makes final partitions
 * and group IDs independent of ingestion order for the same input snapshot.
 * A group ID can change when the canonical leading member changes; persistence
 * retains superseded groups and memberships rather than deleting provenance.
 */
export function planStories(items: readonly StoryInput[]): StoryPlan {
  const ordered = [...items].sort(
    (a, b) => a.identity.localeCompare(b.identity) || a.id.localeCompare(b.id),
  );
  const clusters: StoryInput[][] = [];
  // A comparison succeeds only through an equal content hash or an equal action,
  // so a cluster can accept an item only if one of its members shares one of
  // those keys. Index clusters by key and test just those, in creation order.
  const clustersByKey = new Map<string, Set<number>>();
  const keysOf = (item: StoryInput) => {
    const { hash, action } = featuresOf(item);
    return [
      ...(hash ? ["hash:" + hash] : []),
      ...(action ? ["action:" + action] : []),
    ];
  };
  const indexMember = (item: StoryInput, cluster: number) => {
    for (const key of keysOf(item)) {
      const bucket = clustersByKey.get(key);
      if (bucket) bucket.add(cluster);
      else clustersByKey.set(key, new Set([cluster]));
    }
  };
  for (const item of ordered) {
    const candidates = [
      ...new Set(
        keysOf(item).flatMap((key) => [...(clustersByKey.get(key) ?? [])]),
      ),
    ].sort((a, b) => a - b);
    const index = candidates.find((candidate) =>
      clusters[candidate]!.every(
        (member) => sameDevelopment(member, item) !== null,
      ),
    );
    if (index === undefined) {
      clusters.push([item]);
      indexMember(item, clusters.length - 1);
    } else {
      clusters[index]!.push(item);
      indexMember(item, index);
    }
  }
  const groups = clusters.map((members) => {
    const anchor = members[0]!;
    return {
      id: "story:" + sha(anchor.identity).slice(0, 24),
      members: members.map((item, index) => ({
        itemId: item.id,
        identity: item.identity,
        evidence:
          index === 0
            ? ({ reason: "anchor", canonicalUrl: item.url } as const)
            : sameDevelopment(anchor, item)!,
      })),
      firstAt: Math.min(...members.map(at)),
      lastAt: Math.max(...members.map(at)),
    };
  });
  // A canonical-identity anchor can be a later syndicated copy, so use each
  // group's chronological first member when evaluating directional links.
  // Precompute these lookups to keep pair planning quadratic in group count.
  const byId = new Map(ordered.map((article) => [article.id, article]));
  const earliestByGroup = new Map(
    groups.map(
      (group) =>
        [
          group.id,
          group.members
            .map((member) => byId.get(member.itemId)!)
            .reduce((earliest, candidate) =>
              at(candidate) < at(earliest) ? candidate : earliest,
            ),
        ] as const,
    ),
  );
  const relations: StoryRelation[] = [];
  const earliestTerms = groups.map((group) =>
    terms(earliestByGroup.get(group.id)!.title),
  );
  // A follow-up requires identical versions and identical named subjects
  // across its two titles. Bucket groups on those exact keys so only groups
  // that could relate are compared.
  const buckets = new Map<string, number[]>();
  groups.forEach((group, index) => {
    const earliest = featuresOf(earliestByGroup.get(group.id)!);
    const key =
      earliest.versions.join(",") + "\n" + earliest.subjects.join(",");
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  });
  const candidates = new Map<number, number[]>();
  for (const bucket of buckets.values())
    for (const i of bucket)
      for (const j of bucket) {
        if (j <= i) continue;
        const pairs = candidates.get(i);
        if (pairs) pairs.push(j);
        else candidates.set(i, [j]);
      }
  for (const i of [...candidates.keys()].sort((a, b) => a - b))
    for (const j of candidates.get(i)!.sort((a, b) => a - b)) {
      const left = groups[i]!;
      const right = groups[j]!;
      const older = left.firstAt <= right.firstAt ? left : right;
      const newer = older === left ? right : left;
      const first = earliestByGroup.get(older.id)!;
      const next = earliestByGroup.get(newer.id)!;
      const shared = followUp(first, next, {
        older: older === left ? earliestTerms[i]! : earliestTerms[j]!,
        newer: newer === left ? earliestTerms[i]! : earliestTerms[j]!,
      });
      if (shared)
        relations.push({
          olderGroupId: older.id,
          newerGroupId: newer.id,
          reason: "later_related_development",
          sharedTerms: shared,
        });
    }
  return { version: STORY_RULE_VERSION, groups, relations };
}
