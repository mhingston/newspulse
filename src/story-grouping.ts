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
  recall: ["recall", "recalls", "recalled", "withdraw", "withdraws", "withdrawn"],
  funding: ["funding", "funded", "raises", "raised", "investment", "invests"],
  acquisition: ["acquire", "acquires", "acquired", "buy", "buys", "bought", "merger"],
  outage: ["outage", "offline", "down", "disruption", "disrupted", "restored"],
  lawsuit: ["lawsuit", "sues", "sued", "litigation", "court", "ruling"],
  approval: ["approved", "approval", "authorised", "authorized", "cleared"],
  security: ["breach", "breached", "hack", "hacked", "exploit", "vulnerability"],
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
  return normalized.length >= 160 ? sha(normalized) : null;
}
function sameDevelopment(
  left: StoryInput,
  right: StoryInput,
): StoryEvidence | null {
  const leftHash = contentHash(left);
  const rightHash = contentHash(right);
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
  const action = actionOf(left.title);
  if (!action || action !== actionOf(right.title)) return null;
  const leftTerms = terms(left.title);
  const rightTerms = terms(right.title);
  const shared = common(leftTerms, rightTerms);
  // Product/version identifiers must agree; two releases from the same vendor
  // are not the same event merely because their titles mention the vendor.
  const leftVersions = leftTerms.filter((word) => /\d/.test(word));
  const rightVersions = rightTerms.filter((word) => /\d/.test(word));
  if (
    leftVersions.length &&
    rightVersions.length &&
    !common(leftVersions, rightVersions).length
  )
    return null;
  if (
    shared.length < 2 ||
    shared.length / Math.max(leftTerms.length, rightTerms.length) < 0.6
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
): string[] | null {
  const gap = at(later) - at(earlier);
  if (gap < 4 * DAY || gap > 90 * DAY) return null;
  const overlap = common(terms(earlier.title), terms(later.title));
  return overlap.length >= 2 ? overlap : null;
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
  for (const item of ordered) {
    const cluster = clusters.find((members) =>
      members.every((member) => sameDevelopment(member, item) !== null),
    );
    if (cluster) cluster.push(item);
    else clusters.push([item]);
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
  const relations: StoryRelation[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const left = groups[i]!;
      const right = groups[j]!;
      const older = left.firstAt <= right.firstAt ? left : right;
      const newer = older === left ? right : left;
      const first = ordered.find((item) => item.id === older.members[0]!.itemId)!;
      const next = ordered.find((item) => item.id === newer.members[0]!.itemId)!;
      const shared = followUp(first, next);
      if (shared)
        relations.push({
          olderGroupId: older.id,
          newerGroupId: newer.id,
          reason: "later_related_development",
          sharedTerms: shared,
        });
    }
  }
  return { version: STORY_RULE_VERSION, groups, relations };
}
