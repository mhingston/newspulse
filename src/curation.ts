/** Pure curation over already processed, source-linked candidates. */
export interface CurationCitation {
  sourceId: string;
  nativeId: string;
  url: string | null;
}
export interface CurationCandidate {
  itemId: string;
  groupId: string | null;
  scoreId: string;
  score: number;
  scoreSnapshot: unknown;
  eligible: boolean;
  interestIds: string[];
  title: string;
  summary: string | null;
  explanation: string;
  citations: CurationCitation[];
  discovery: boolean;
  update: {
    priorEditionId: string;
    observedAt: number;
    evidence: string;
  } | null;
}
export interface PriorEdition {
  editionId: string;
  state: "draft" | "frozen" | "sent" | "failed" | "ambiguous";
  publishedAt: number | null;
  items: { itemId: string; groupId: string | null }[];
}
export interface CurationInput {
  candidates: CurationCandidate[];
  priorEditions: PriorEdition[];
  minScore: number;
  maxItems: number;
  maxPerInterest: number;
}
export interface CurationDecision {
  itemId: string;
  included: boolean;
  reasons: string[];
  priorEditionId?: string;
}
export interface CurationResult {
  status: "ready" | "no_digest";
  selected: CurationCandidate[];
  decisions: CurationDecision[];
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const group = (candidate: { itemId: string; groupId: string | null }) =>
  candidate.groupId ? `group:${candidate.groupId}` : `item:${candidate.itemId}`;

/**
 * Favour high-scoring items, interleave interests, and keep a single candidate
 * per development. A frozen edition is not proof of delivery. Ambiguous
 * delivery blocks a repeat until reconciled; it is not counted as sent.
 */
export function curateDigest(input: CurationInput): CurationResult {
  if (
    !Number.isFinite(input.minScore) ||
    input.minScore < 0 ||
    input.minScore > 100 ||
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1 ||
    !Number.isSafeInteger(input.maxPerInterest) ||
    input.maxPerInterest < 1
  )
    throw new Error("Invalid curation limits");
  if (
    new Set(input.candidates.map((item) => item.itemId)).size !==
    input.candidates.length
  )
    throw new Error("Duplicate curation item ID");
  if (
    input.candidates.some(
      (item) =>
        !item.itemId ||
        !item.scoreId ||
        !Number.isFinite(item.score) ||
        item.score < 0 ||
        item.score > 100,
    )
  )
    throw new Error("Invalid candidate");
  const decisions = new Map<string, CurationDecision>();
  const candidates = [...input.candidates].sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.discovery) - Number(a.discovery) ||
      cmp(a.itemId, b.itemId),
  );
  const pool: CurationCandidate[] = [];
  for (const candidate of candidates) {
    const reject = (reason: string, priorEditionId?: string) =>
      decisions.set(candidate.itemId, {
        itemId: candidate.itemId,
        included: false,
        reasons: [reason],
        ...(priorEditionId ? { priorEditionId } : {}),
      });
    if (!candidate.eligible) {
      reject("score_ineligible");
      continue;
    }
    if (candidate.score < input.minScore) {
      reject("below_quality_threshold");
      continue;
    }
    if (
      !candidate.citations.length ||
      candidate.citations.some((ref) => !ref.sourceId || !ref.nativeId)
    ) {
      reject("missing_source_reference");
      continue;
    }
    const relevant = input.priorEditions.filter((edition) =>
      edition.items.some(
        (item) =>
          item.itemId === candidate.itemId ||
          (item.groupId !== null && item.groupId === candidate.groupId),
      ),
    );
    const ambiguous = relevant
      .filter((edition) => edition.state === "ambiguous")
      .sort((a, b) => cmp(a.editionId, b.editionId))[0];
    if (ambiguous) {
      reject("prior_delivery_ambiguous", ambiguous.editionId);
      continue;
    }
    const sent = relevant
      .filter((edition) => edition.state === "sent")
      .sort(
        (a, b) =>
          (b.publishedAt ?? -1) - (a.publishedAt ?? -1) ||
          cmp(a.editionId, b.editionId),
      )[0];
    if (sent) {
      const update = candidate.update;
      if (
        !update ||
        update.priorEditionId !== sent.editionId ||
        !update.evidence.trim() ||
        sent.publishedAt === null ||
        !Number.isSafeInteger(update.observedAt) ||
        update.observedAt <= sent.publishedAt
      ) {
        reject(
          "previously_published_without_documented_update",
          sent.editionId,
        );
        continue;
      }
    }
    pool.push(candidate);
  }
  const selected: CurationCandidate[] = [];
  const groupIds = new Set<string>();
  const counts = new Map<string, number>();
  const category = (item: CurationCandidate) =>
    [...new Set(item.interestIds)].sort(cmp)[0] ?? "";
  while (pool.length && selected.length < input.maxItems) {
    pool.sort(
      (a, b) =>
        (counts.get(category(a)) ?? 0) - (counts.get(category(b)) ?? 0) ||
        b.score - a.score ||
        Number(b.discovery) - Number(a.discovery) ||
        cmp(a.itemId, b.itemId),
    );
    const item = pool.shift()!;
    if (groupIds.has(group(item))) {
      decisions.set(item.itemId, {
        itemId: item.itemId,
        included: false,
        reasons: ["duplicate_development"],
      });
      continue;
    }
    const key = category(item);
    if ((counts.get(key) ?? 0) >= input.maxPerInterest) {
      decisions.set(item.itemId, {
        itemId: item.itemId,
        included: false,
        reasons: ["interest_limit"],
      });
      continue;
    }
    selected.push(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    groupIds.add(group(item));
    const prior = input.priorEditions.find(
      (edition) =>
        edition.editionId === item.update?.priorEditionId &&
        edition.state === "sent" &&
        edition.items.some(
          (previous) =>
            previous.itemId === item.itemId ||
            (previous.groupId !== null && previous.groupId === item.groupId),
        ),
    );
    decisions.set(item.itemId, {
      itemId: item.itemId,
      included: true,
      reasons: [
        "meets_quality_threshold",
        ...(item.discovery ? ["outside_subscriptions"] : []),
        ...(prior ? ["documented_update"] : []),
      ],
      ...(prior ? { priorEditionId: prior.editionId } : {}),
    });
  }
  for (const item of pool)
    decisions.set(item.itemId, {
      itemId: item.itemId,
      included: false,
      reasons: [
        groupIds.has(group(item)) ? "duplicate_development" : "edition_limit",
      ],
    });
  return {
    status: selected.length ? "ready" : "no_digest",
    selected,
    decisions: [...decisions.values()].sort((a, b) => cmp(a.itemId, b.itemId)),
  };
}
