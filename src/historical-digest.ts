import type { Store } from "./db/store";
import {
  curateDigest,
  type CurationCandidate,
  type PriorEdition,
} from "./curation";
import { renderDigest } from "./digest-render";
import type { DigestOptions } from "./digest-service";

const MAX_CANDIDATES = 500;
const MAX_SCORE_BYTES = 200_000;
export const DIGEST_ACTIVITY_RETENTION_MS = 366 * 86_400_000;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type HistoricalDraft =
  | {
      status: "unavailable";
      reason: string;
      candidateCount: number;
    }
  | {
      status: "blocked";
      reason: string;
      candidateCount: number;
    }
  | {
      status: "no_digest" | "ready";
      reason: null;
      candidateCount: number;
      selected: CurationCandidate[];
      decisions: unknown[];
      decisionEvidence: unknown[];
      rendered: ReturnType<typeof renderDigest> | null;
      intake: {
        windowHours: 24;
        limit: number;
        truncated: boolean;
        ordering: string;
      };
    };

/** Keep recoverable activity for at most 366 days and advance its truthful floor. */
export function pruneHistoricalDigestActivity(
  store: Store,
  now = Date.now(),
): number {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid digest history retention time");
  return store.sqlite
    .transaction(() => {
      const state = store.sqlite
        .query<{ evidence_from: number }, []>(
          "SELECT evidence_from FROM digest_history_state WHERE id=1",
        )
        .get();
      if (!state) return 0;
      const evidenceFrom = Math.max(
        state.evidence_from,
        now - DIGEST_ACTIVITY_RETENTION_MS,
      );
      const removed = store.sqlite
        .query("DELETE FROM digest_activity_events WHERE activity_at<?")
        .run(evidenceFrom).changes;
      store.sqlite
        .query("DELETE FROM score_validity_events WHERE event_at<?")
        .run(evidenceFrom);
      store.sqlite
        .query(
          `DELETE FROM story_grouping_events WHERE event_at<? AND id<>(
            SELECT id FROM story_grouping_events WHERE event_at<? ORDER BY event_at DESC,id DESC LIMIT 1
          )`,
        )
        .run(evidenceFrom, evidenceFrom);
      store.sqlite
        .query("UPDATE digest_history_state SET evidence_from=? WHERE id=1")
        .run(evidenceFrom);
      return removed;
    })
    .immediate();
}

/**
 * Rebuild an edition from append-only activity plus score, content and grouping
 * versions that were already present at the scheduled publication instant.
 * A migration boundary prevents old latest-only activity rows from being
 * presented as complete history.
 */
export function historicalDigestDraft(
  store: Store,
  options: DigestOptions,
): HistoricalDraft {
  const cutoff = options.now;
  const since = Math.max(0, cutoff - 86_400_000);
  const coverage = store.sqlite
    .query<{ evidence_from: number }, []>(
      "SELECT evidence_from FROM digest_history_state WHERE id=1",
    )
    .get();
  if (!coverage || coverage.evidence_from > since)
    return {
      status: "unavailable",
      reason: "activity_history_not_complete_since_upgrade",
      candidateCount: 0,
    };

  const events = store.sqlite
    .query<{ item_id: string; activity_at: number }, [number, number, number]>(
      `SELECT item_id,max(activity_at) AS activity_at FROM digest_activity_events
       WHERE activity_at>? AND activity_at<=? GROUP BY item_id
       ORDER BY activity_at DESC,item_id DESC LIMIT ?`,
    )
    .all(since, cutoff, MAX_CANDIDATES + 1);
  const truncated = events.length > MAX_CANDIDATES;
  const ids = events.slice(0, MAX_CANDIDATES).map((row) => row.item_id);
  const intake = {
    windowHours: 24 as const,
    limit: MAX_CANDIDATES,
    truncated,
    ordering: "most_recent_activity_then_item_id",
  };
  if (!ids.length)
    return {
      status: "no_digest",
      reason: null,
      candidateCount: 0,
      selected: [],
      decisions: [],
      decisionEvidence: [],
      rendered: null,
      intake,
    };

  const groupingAtCutoff = store.sqlite
    .query<{ state: string }, [number]>(
      "SELECT state FROM story_grouping_events WHERE event_at<=? ORDER BY event_at DESC,id DESC LIMIT 1",
    )
    .get(cutoff)?.state;
  if (groupingAtCutoff !== "ready")
    return {
      status: "unavailable",
      reason: "story_grouping_incomplete_at_historical_cutoff",
      candidateCount: ids.length,
    };

  const globalPass = store.sqlite
    .query<{ kind: string }, [number]>(
      `SELECT kind FROM score_validity_events WHERE kind IN ('global_invalidation','global_pass_complete')
       AND event_at<=? ORDER BY event_at DESC,id DESC LIMIT 1`,
    )
    .get(cutoff);
  if (globalPass?.kind === "global_invalidation")
    return {
      status: "unavailable",
      reason: "global_score_invalidation_pending_at_historical_cutoff",
      candidateCount: ids.length,
    };

  const placeholders = ids.map(() => "?").join(",");
  // A later identity merge reparents historical rows. Its previous item identity
  // cannot be reconstructed from the current relational projection.
  const merged =
    store.sqlite
      .query<{ n: number }, [...string[], number]>(
        `SELECT count(*) AS n FROM digest_activity_events e WHERE e.kind='identity_merge' AND e.related_item_id IN (SELECT old_id FROM item_redirects WHERE item_id IN (${placeholders})) AND e.activity_at>?`,
      )
      .get(...ids, cutoff)?.n ?? 0;
  if (merged)
    return {
      status: "unavailable",
      reason: "identity_merged_after_historical_cutoff",
      candidateCount: ids.length,
    };

  const pending: string[] = [];
  const limited: string[] = [];
  const candidates: CurationCandidate[] = [];
  const priorEditions: PriorEdition[] = [];
  const blockedPrevious: string[] = [];
  for (const itemId of ids) {
    const extraction = store.sqlite
      .query<{ generation: number }, [string, number]>(
        "SELECT max(generation) AS generation FROM processing_jobs WHERE item_id=? AND stage='extract' AND created_at<=?",
      )
      .get(itemId, cutoff)?.generation;
    if (extraction === undefined || extraction === null) {
      pending.push(itemId);
      continue;
    }
    const scoreRow = store.sqlite
      .query<
        {
          id: string;
          result: string;
          provenance: string;
          bytes: number;
          event_at: number;
          valid_until: number | null;
          invalidated: number;
        },
        [number, string, number, number, number]
      >(
        `SELECT s.id,s.result,s.provenance,length(CAST(s.provenance AS BLOB)) AS bytes,
          v.event_at,v.valid_until,
          (SELECT count(*) FROM score_validity_events e WHERE e.event_at<=?
           AND (e.event_at>v.event_at OR (e.event_at=v.event_at AND e.id>v.id))
           AND ((e.kind='item_invalidation' AND e.item_id=v.item_id) OR e.kind='global_invalidation')) AS invalidated
         FROM score_validity_events v
         JOIN item_scores s ON s.id=v.score_id AND s.item_id=v.item_id
         WHERE v.item_id=? AND s.generation=? AND s.created_at<=? AND v.kind='score_valid' AND v.event_at<=?
         ORDER BY v.event_at DESC,v.id DESC LIMIT 1`,
      )
      .get(cutoff, itemId, extraction, cutoff, cutoff);
    if (!scoreRow) {
      pending.push(itemId);
      continue;
    }
    if (
      scoreRow.invalidated > 0 ||
      (scoreRow.valid_until !== null && scoreRow.valid_until <= cutoff)
    ) {
      pending.push(itemId);
      continue;
    }
    if (scoreRow.bytes > MAX_SCORE_BYTES) {
      limited.push(itemId);
      continue;
    }
    let result: { total?: unknown; eligible?: unknown; reasons?: unknown };
    let provenance: {
      input?: { title?: unknown; text?: unknown; interests?: unknown[] };
      analysis?: {
        result?: { summary?: unknown; uncertainty?: unknown };
      } | null;
      history?: {
        state?: string;
        reason?: string;
        editionId?: string;
        acceptedAt?: number;
        update?: { observedAt?: number } | null;
      };
    };
    try {
      result = JSON.parse(scoreRow.result) as typeof result;
      provenance = JSON.parse(scoreRow.provenance) as typeof provenance;
    } catch {
      limited.push(itemId);
      continue;
    }
    const input = provenance.input;
    if (
      typeof input?.title !== "string" ||
      typeof input.text !== "string" ||
      !Array.isArray(result.reasons) ||
      typeof result.total !== "number" ||
      typeof result.eligible !== "boolean"
    ) {
      limited.push(itemId);
      continue;
    }
    const expiredAtCutoff = (input.interests ?? []).some((interest) => {
      if (!interest || typeof interest !== "object") return false;
      const value = interest as { lifetime?: unknown; expiresAt?: unknown };
      return (
        value.lifetime === "temporary" &&
        typeof value.expiresAt === "number" &&
        value.expiresAt <= cutoff
      );
    });
    if (expiredAtCutoff) {
      pending.push(itemId);
      continue;
    }

    const membership = store.sqlite
      .query<{ group_id: string }, [string, number, number]>(
        "SELECT group_id FROM story_memberships WHERE item_id=? AND started_at<=? AND (ended_at IS NULL OR ended_at>?) ORDER BY started_at DESC,id DESC LIMIT 1",
      )
      .get(itemId, cutoff, cutoff);
    const groupId = membership?.group_id ?? null;
    const memberIds = groupId
      ? store.sqlite
          .query<{ item_id: string }, [string, number, number]>(
            "SELECT item_id FROM story_memberships WHERE group_id=? AND started_at<=? AND (ended_at IS NULL OR ended_at>?) ORDER BY item_id LIMIT 21",
          )
          .all(groupId, cutoff, cutoff)
          .map((row) => row.item_id)
      : [itemId];
    if (memberIds.length > 20) {
      limited.push(itemId);
      continue;
    }
    const mergedMember =
      store.sqlite
        .query<{ n: number }, [string, number]>(
          `WITH members(id) AS (SELECT value FROM json_each(?))
           SELECT count(*) AS n FROM digest_activity_events e WHERE e.kind='identity_merge' AND e.activity_at>?
           AND EXISTS (SELECT 1 FROM members WHERE members.id=e.item_id OR members.id=e.related_item_id)`,
        )
        .get(JSON.stringify(memberIds), cutoff)?.n ?? 0;
    if (mergedMember)
      return {
        status: "unavailable",
        reason: "identity_merged_after_historical_cutoff",
        candidateCount: ids.length,
      };
    const references: {
      sourceId: string;
      nativeId: string;
      url: string | null;
    }[] = [];
    let referenceBytes = 0;
    for (const memberId of memberIds) {
      const refs = store.sqlite
        .query<
          {
            source_id: string;
            native_id: string;
            url: string | null;
            bytes: number;
          },
          [string, number, number]
        >(
          `SELECT v.source_id,v.native_id,v.url,length(CAST(v.source_id AS BLOB))+length(CAST(v.native_id AS BLOB))+coalesce(length(CAST(v.url AS BLOB)),0) AS bytes
         FROM content_versions v WHERE v.item_id=? AND v.observed_at<=?
         AND v.id=(SELECT max(x.id) FROM content_versions x WHERE x.item_id=v.item_id AND x.source_id=v.source_id AND x.native_id=v.native_id AND x.observed_at<=?)
         ORDER BY v.source_id,v.native_id LIMIT 21`,
        )
        .all(memberId, cutoff, cutoff);
      if (refs.length > 20) {
        referenceBytes = 4097;
        break;
      }
      referenceBytes += refs.reduce((sum, ref) => sum + ref.bytes, 0);
      for (const ref of refs)
        references.push({
          sourceId: ref.source_id,
          nativeId: ref.native_id,
          url: ref.url,
        });
    }
    if (!references.length || referenceBytes > 4096) {
      limited.push(itemId);
      continue;
    }
    references.sort(
      (a, b) =>
        compare(a.sourceId, b.sourceId) || compare(a.nativeId, b.nativeId),
    );
    const history = provenance.history;
    if (
      history?.state === "accepted" &&
      history.editionId &&
      typeof history.acceptedAt === "number"
    ) {
      priorEditions.push({
        editionId: history.editionId,
        state: "sent",
        publishedAt: history.acceptedAt,
        items: [{ itemId, groupId: null }],
      });
    } else if (
      history?.state === "unknown" &&
      history.reason === "ambiguous_delivery" &&
      history.editionId
    ) {
      const resolved = store.sqlite
        .query<{ status: string; updated_at: number }, [string]>(
          "SELECT status,updated_at FROM deliveries WHERE digest_id=? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(history.editionId);
      if (resolved?.status !== "failed")
        priorEditions.push({
          editionId: history.editionId,
          state: resolved?.status === "sent" ? "sent" : "ambiguous",
          publishedAt: resolved?.status === "sent" ? resolved.updated_at : null,
          items: [{ itemId, groupId: null }],
        });
    } else if (
      history?.state === "unknown" &&
      ["history_limit", "historical_snapshot_limit"].includes(
        history.reason ?? "",
      )
    ) {
      priorEditions.push({
        editionId: history.editionId ?? `unknown:${itemId}`,
        state: "ambiguous",
        publishedAt: null,
        items: [{ itemId, groupId: null }],
      });
    }
    const analysis = provenance.analysis?.result;
    const previous = store.sqlite
      .query<
        {
          digest_id: string;
          status: string | null;
          updated_at: number | null;
          first_attempt_at: number | null;
        },
        [string, string, string, string, string, string | null, string | null]
      >(
        `SELECT d.id AS digest_id,x.status,x.updated_at,x.first_attempt_at FROM digest_items di
         JOIN digests d ON d.id=di.digest_id LEFT JOIN deliveries x ON x.digest_id=d.id
         WHERE d.edition_date<? AND (
           di.item_id=? OR di.item_id IN (
             SELECT old_id FROM item_redirects WHERE item_id=? OR item_id=(SELECT item_id FROM item_redirects WHERE old_id=?)
           ) OR di.item_id=(SELECT item_id FROM item_redirects WHERE old_id=?)
           OR (? IS NOT NULL AND di.group_id=?))
         ORDER BY d.edition_date,d.id`,
      )
      .all(options.date, itemId, itemId, itemId, itemId, groupId, groupId);
    for (const prior of previous) {
      const state: PriorEdition["state"] =
        prior.status === "sent"
          ? "sent"
          : prior.status === "failed"
            ? "failed"
            : prior.status === null
              ? "frozen"
              : "ambiguous";
      if (state === "ambiguous") blockedPrevious.push(itemId);
      priorEditions.push({
        editionId: prior.digest_id,
        state,
        publishedAt: state === "sent" ? prior.updated_at : null,
        items: [{ itemId, groupId }],
      });
    }
    candidates.push({
      itemId,
      groupId,
      scoreId: scoreRow.id,
      score: result.total,
      scoreSnapshot: { id: scoreRow.id, result, provenance },
      eligible: result.eligible,
      interestIds: result.reasons
        .filter(
          (reason): reason is string =>
            typeof reason === "string" && reason.startsWith("interest:"),
        )
        .map((reason) => reason.slice(9).split("@")[0]!),
      title: input.title,
      summary: typeof analysis?.summary === "string" ? analysis.summary : null,
      uncertainty: Array.isArray(analysis?.uncertainty)
        ? analysis.uncertainty.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      explanation:
        result.reasons
          .filter((reason): reason is string => typeof reason === "string")
          .join("; ") || "No score explanation available",
      citations: references,
      discovery: false,
      update:
        history?.state === "accepted" &&
        history.editionId &&
        typeof history.update?.observedAt === "number"
          ? {
              priorEditionId: history.editionId,
              observedAt: history.update.observedAt,
              evidence:
                "Conservative comparison with the accepted edition snapshot",
            }
          : null,
    });
  }
  // Never promote a stale score or present a partial historical edition when
  // work was unfinished at the original deadline.
  if (pending.length || limited.length)
    return {
      status: "unavailable",
      reason: pending.length
        ? "processing_incomplete_at_historical_cutoff"
        : "historical_evidence_resource_limit",
      candidateCount: ids.length,
    };

  if (blockedPrevious.length)
    return {
      status: "blocked",
      reason: `prior_delivery_requires_reconciliation:${[...new Set(blockedPrevious)].sort(compare).join(",")}`,
      candidateCount: ids.length,
    };

  const result = curateDigest({
    candidates,
    priorEditions,
    minScore: options.minScore,
    maxItems: options.maxItems,
    maxPerInterest: options.maxPerInterest,
  });
  const decisions = result.decisions;
  const decisionEvidence = decisions.map((decision) => {
    const candidate = candidates.find(
      (entry) => entry.itemId === decision.itemId,
    );
    return {
      itemId: decision.itemId,
      evidence: candidate
        ? {
            scoreId: candidate.scoreId,
            score: candidate.score,
            eligible: candidate.eligible,
            groupId: candidate.groupId,
            citations: candidate.citations,
          }
        : null,
    };
  });
  const rendered =
    result.status === "ready"
      ? renderDigest(
          options.date,
          result.selected.map((item) => ({
            itemId: item.itemId,
            title: item.title,
            summary: item.summary,
            uncertainty: item.uncertainty,
            why: item.explanation,
            references: item.citations.map((ref) => ({
              source: ref.sourceId,
              nativeId: ref.nativeId,
              url: ref.url,
            })),
          })),
        )
      : null;
  return {
    status: result.status,
    reason: null,
    candidateCount: ids.length,
    selected: result.selected,
    decisions,
    decisionEvidence,
    rendered,
    intake,
  };
}
