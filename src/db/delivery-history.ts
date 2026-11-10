import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { observedUpdate, type ObservedUpdate } from "../observed-update";

/** Only confirmed provider acceptance is positive evidence. These are not read receipts. */
export function deliveryHistory(
  db: Database,
  itemId: string,
  groupId: string | null,
  title: string,
  text: string,
  update: ObservedUpdate | null,
  now = Date.now(),
  extractionGeneration?: number,
) {
  const rows = db
    .query<
      {
        delivery_id: string;
        status: string;
        provider_id: string | null;
        accepted_at: number;
        digest_id: string;
        edition_date: string;
        item_id: string;
        group_id: string | null;
        score_id: string | null;
        position: number;
      },
      [string, string | null, string | null]
    >(
      `
    WITH canonical_items(id) AS (
      SELECT ? UNION SELECT item_id FROM story_memberships
      WHERE ? IS NOT NULL AND group_id=? AND ended_at IS NULL
    ), matching_items(id) AS (
      SELECT id FROM canonical_items
      UNION SELECT r.old_id FROM canonical_items c CROSS JOIN item_redirects r INDEXED BY item_redirects_item WHERE r.item_id=c.id
    )
    SELECT d.id AS delivery_id,d.status,d.provider_id,d.updated_at AS accepted_at,
      g.id AS digest_id,g.edition_date,di.item_id,di.group_id,di.score_id,di.position
    FROM matching_items candidates
    CROSS JOIN digest_items di INDEXED BY digest_item_by_item
    CROSS JOIN digests g
    CROSS JOIN deliveries d INDEXED BY delivery_by_digest
    WHERE di.item_id=candidates.id AND g.id=di.digest_id AND g.sealed=1
      AND d.digest_id=g.id
      AND (d.status IN ('sent','ambiguous') OR (d.status='sending' AND d.first_attempt_at IS NOT NULL))
    ORDER BY g.frozen_at DESC,g.edition_date DESC,d.id DESC,di.position LIMIT 101
  `,
    )
    .all(itemId, groupId, groupId);
  // An unresolved attempt or truncated history cannot establish the latest presentation.
  if (rows.length > 100 || rows.some((row) => row.status !== "sent"))
    return {
      input: null,
      evidence: {
        state: "unknown",
        reason: rows.length > 100 ? "history_limit" : "ambiguous_delivery",
        editionId: rows.find((row) => row.status !== "sent")?.digest_id ?? null,
      },
    } as const;
  const row = rows[0];
  if (!row)
    return {
      input: null,
      evidence: { state: "unknown", reason: "no_confirmed_delivery" },
    } as const;
  // Inspect the length in SQLite before loading a single bounded frozen snapshot.
  const size = db
    .query<{ bytes: number }, [string, number]>(
      "SELECT length(CAST(snapshot AS BLOB)) AS bytes FROM digest_items WHERE digest_id=? AND position=?",
    )
    .get(row.digest_id, row.position)?.bytes;
  if (size === undefined || size > 250_000)
    return {
      input: null,
      evidence: {
        state: "unknown",
        reason: "historical_snapshot_limit",
        editionId: row.digest_id,
      },
    } as const;
  const raw = db
    .query<{ snapshot: string }, [string, number]>(
      "SELECT snapshot FROM digest_items WHERE digest_id=? AND position=?",
    )
    .get(row.digest_id, row.position)?.snapshot;
  let snapshot: unknown = null;
  let previous: { title?: unknown; text?: unknown } | null = null;
  try {
    snapshot = JSON.parse(raw ?? "null") as unknown;
    const frozen = snapshot as {
      scoreSnapshot?: {
        provenance?: { input?: { title?: unknown; text?: unknown } };
      };
    } | null;
    previous = frozen?.scoreSnapshot?.provenance?.input ?? null;
  } catch {
    /* Old or malformed snapshots are not historical evidence. */
  }
  const available =
    typeof previous?.title === "string" &&
    typeof previous.text === "string" &&
    previous.text.trim().length > 0;
  // Item IDs may have been merged after the edition was frozen.
  const canonical = db
    .query<{ id: string }, [string, string]>(
      "SELECT COALESCE((SELECT item_id FROM item_redirects WHERE old_id=?),?) AS id",
    )
    .get(row.item_id, row.item_id)?.id;
  // Distinct items need their first real observation after acceptance; otherwise
  // a later duplicate could be mistaken for a substantive follow-up.
  const firstObservation =
    canonical !== itemId
      ? db
          .query<
            {
              source_id: string;
              native_id: string;
              observed_at: number;
              backfilled: number;
            },
            [string]
          >(
            "SELECT source_id,native_id,observed_at,backfilled FROM content_versions WHERE item_id=? ORDER BY id LIMIT 1",
          )
          .get(itemId)
      : null;
  const latestObservation = firstObservation
    ? db
        .query<
          {
            title: string;
            text: string;
            source_id: string;
            observed_at: number;
            backfilled: number;
          },
          [string]
        >(
          "SELECT title,text,source_id,observed_at,backfilled FROM content_versions WHERE item_id=? ORDER BY id DESC LIMIT 1",
        )
        .get(itemId)
    : null;
  // A fetched article may be longer than its source snippet. Trust it only
  // when the completed generation is tied to the same source observation.
  const extractedFromObservation =
    latestObservation &&
    extractionGeneration !== undefined &&
    db
      .query<{ ok: number }, [string, number, string, number, string]>(
        `SELECT 1 AS ok FROM processing_jobs WHERE item_id=? AND stage='extract' AND generation=? AND status='done' AND outcome='extracted' AND origin_source_id=? AND created_at=? AND CASE WHEN json_valid(result) THEN json_extract(result,'$.text')=? ELSE 0 END`,
      )
      .get(
        itemId,
        extractionGeneration,
        latestObservation.source_id,
        latestObservation.observed_at,
        text,
      ) !== null;
  const publishedAt = firstObservation
    ? db
        .query<{ published_at: number | null }, [string]>(
          "SELECT published_at FROM items WHERE id=?",
        )
        .get(itemId)?.published_at
    : null;
  const comparison =
    canonical === itemId
      ? update &&
        update.observedAt > row.accepted_at &&
        update.observedAt <= now
        ? {
            sourceId: update.sourceId,
            nativeId: update.nativeId,
            observedAt: update.observedAt,
            observedUpdate: update,
          }
        : null
      : firstObservation &&
          !firstObservation.backfilled &&
          publishedAt != null &&
          publishedAt > row.accepted_at &&
          publishedAt <= now &&
          firstObservation.observed_at > row.accepted_at &&
          firstObservation.observed_at <= now &&
          latestObservation &&
          !latestObservation.backfilled &&
          latestObservation.observed_at <= now &&
          latestObservation.title === title &&
          (latestObservation.text === text || extractedFromObservation)
        ? {
            sourceId: firstObservation.source_id,
            nativeId: firstObservation.native_id,
            observedAt: firstObservation.observed_at,
            observedUpdate: null,
          }
        : null;
  let meaningfulUpdate = false;
  if (available && comparison) {
    meaningfulUpdate =
      observedUpdate(
        {
          id: 1,
          source_id: comparison.sourceId,
          native_id: comparison.nativeId,
          title: previous!.title as string,
          text: previous!.text as string,
          backfilled: 0,
        },
        {
          id: 2,
          source_id: comparison.sourceId,
          native_id: comparison.nativeId,
          title,
          text,
          backfilled: 0,
          observed_at: comparison.observedAt,
        },
      ) !== null;
  }
  return {
    input: {
      sameDevelopment: true,
      meaningfulUpdate,
      snapshotUnavailable: !available,
    },
    evidence: {
      state: "accepted",
      deliveryId: row.delivery_id,
      providerId: row.provider_id,
      acceptedAt: row.accepted_at,
      editionId: row.digest_id,
      editionDate: row.edition_date,
      itemId: row.item_id,
      groupId: row.group_id,
      scoreId: row.score_id,
      scoreSnapshot: (
        snapshot as {
          scoreSnapshot?: { id?: unknown; result?: unknown };
        } | null
      )?.scoreSnapshot
        ? {
            id: (snapshot as { scoreSnapshot: { id?: unknown } }).scoreSnapshot
              .id,
            result: (snapshot as { scoreSnapshot: { result?: unknown } })
              .scoreSnapshot.result,
          }
        : null,
      scoreProvenance: previous,
      update: meaningfulUpdate
        ? {
            observedAt: comparison!.observedAt,
            observedUpdate: comparison!.observedUpdate,
          }
        : null,
    },
  } as const;
}

/**
 * Cross-group comparison deliberately records a possible follow-up without
 * treating a lexical story relation as duplicate coverage. Only accepted,
 * bounded edition snapshots are considered; uncertainty is preserved.
 */
export function relatedDeliveryHistory(
  db: Database,
  candidateItemId: string,
  newerGroupId: string | null,
  title: string,
  text: string,
  publishedAt: number | null,
  now = Date.now(),
  extractionGeneration?: number,
) {
  const membershipCount =
    db
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM story_memberships WHERE item_id=?",
      )
      .get(candidateItemId)?.count ?? 0;
  if (!membershipCount) return null;
  if (membershipCount > 100)
    return {
      input: null,
      evidence: {
        comparisonVersion: "related-delivery-v1",
        state: "unknown" as const,
        reason: "membership_history_limit",
        candidateItemId,
      },
    };
  const rows = db
    .query<
      {
        delivery_id: string;
        status: string;
        provider_id: string | null;
        accepted_at: number;
        edition_id: string;
        edition_date: string;
        older_group_id: string;
        newer_group_id: string;
        relation_id: number;
        relation_evidence: string;
        relation_version: string;
        relation_reason: string;
        relation_ended_at: number | null;
        item_id: string;
        score_id: string | null;
        position: number;
        candidate_group_ended_at: number | null;
      },
      [string]
    >(
      `
    SELECT d.id AS delivery_id,d.status,d.provider_id,d.updated_at AS accepted_at,
      g.id AS edition_id,g.edition_date,r.older_group_id,r.newer_group_id,
      r.id AS relation_id,r.evidence AS relation_evidence,r.rule_version AS relation_version,
      r.reason AS relation_reason,r.ended_at AS relation_ended_at,
      di.item_id,di.score_id,di.position,candidate_membership.ended_at AS candidate_group_ended_at
    FROM story_relations r
    JOIN story_memberships candidate_membership
      ON candidate_membership.group_id=r.newer_group_id AND candidate_membership.item_id=?
    JOIN digest_items di ON di.group_id=r.older_group_id
    JOIN digests g ON g.id=di.digest_id AND g.sealed=1
    JOIN deliveries d ON d.digest_id=g.id
    WHERE r.reason='later_related_development'
      AND (d.status IN ('sent','ambiguous') OR (d.status='sending' AND d.first_attempt_at IS NOT NULL))
    ORDER BY CASE WHEN r.ended_at IS NULL AND candidate_membership.ended_at IS NULL THEN 0 ELSE 1 END,
      g.frozen_at DESC,g.edition_date DESC,d.id DESC,di.position LIMIT 101
  `,
    )
    .all(candidateItemId);
  if (!rows.length) return null;
  const unknown = (reason: string, row = rows[0]!) => ({
    input: null,
    evidence: {
      comparisonVersion: "related-delivery-v1",
      state: "unknown" as const,
      reason,
      editionId: row.edition_id,
      relationId: row.relation_id,
      relationVersion: row.relation_version,
      relationEndedAt: row.relation_ended_at,
      candidateMembershipEndedAt: row.candidate_group_ended_at,
      olderGroupId: row.older_group_id,
      newerGroupId: row.newer_group_id,
      itemId: row.item_id,
      scoreId: row.score_id,
    },
  });
  if (rows.length > 100) return unknown("history_limit");
  if (rows.some((row) => row.status !== "sent"))
    return unknown(
      "ambiguous_delivery",
      rows.find((row) => row.status !== "sent")!,
    );
  const row = rows[0]!;
  const bytes = db
    .query<{ bytes: number }, [string, number]>(
      "SELECT length(CAST(snapshot AS BLOB)) AS bytes FROM digest_items WHERE digest_id=? AND position=?",
    )
    .get(row.edition_id, row.position)?.bytes;
  if (bytes === undefined || bytes > 250_000)
    return unknown("historical_snapshot_limit", row);
  const raw = db
    .query<{ snapshot: string }, [string, number]>(
      "SELECT snapshot FROM digest_items WHERE digest_id=? AND position=?",
    )
    .get(row.edition_id, row.position)?.snapshot;
  let snapshot: {
    scoreSnapshot?: {
      provenance?: { input?: { title?: unknown; text?: unknown } };
      [key: string]: unknown;
    };
    citations?: unknown;
  } | null;
  try {
    snapshot = JSON.parse(raw ?? "null");
  } catch {
    return unknown("invalid_historical_snapshot", row);
  }
  if (!snapshot || typeof snapshot !== "object")
    return unknown("invalid_historical_snapshot", row);
  const old = snapshot?.scoreSnapshot?.provenance?.input;
  const priorTitle = typeof old?.title === "string" ? old.title : null;
  const priorText = typeof old?.text === "string" ? old.text : null;
  if (!priorTitle || !priorText?.trim())
    return unknown("historical_content_unavailable", row);
  const firstObservation = db
    .query<
      {
        source_id: string;
        native_id: string;
        observed_at: number;
        backfilled: number;
        title: string;
      },
      [string]
    >(
      "SELECT source_id,native_id,observed_at,backfilled,title FROM content_versions WHERE item_id=? AND backfilled=0 ORDER BY id LIMIT 1",
    )
    .get(candidateItemId);
  const latestObservation = db
    .query<
      {
        source_id: string;
        native_id: string;
        observed_at: number;
        backfilled: number;
        title: string;
        text: string;
      },
      [string]
    >(
      "SELECT source_id,native_id,observed_at,backfilled,title,text FROM content_versions WHERE item_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(candidateItemId);
  const extractionMatchesObservation =
    latestObservation !== null &&
    extractionGeneration !== undefined &&
    db
      .query<{ ok: number }, [string, number, string, number, string]>(
        `SELECT 1 AS ok FROM processing_jobs WHERE item_id=? AND stage='extract' AND generation=? AND status='done' AND outcome='extracted' AND origin_source_id=? AND created_at=? AND CASE WHEN json_valid(result) THEN json_extract(result,'$.text')=? ELSE 0 END`,
      )
      .get(
        candidateItemId,
        extractionGeneration,
        latestObservation.source_id,
        latestObservation.observed_at,
        text,
      ) !== null;
  const currentContentMatchesObservation =
    latestObservation !== null &&
    latestObservation.backfilled === 0 &&
    latestObservation.observed_at <= now &&
    latestObservation.title === title &&
    (latestObservation.text === text || extractionMatchesObservation);
  const timely =
    publishedAt !== null &&
    publishedAt > row.accepted_at &&
    publishedAt <= now &&
    firstObservation !== null &&
    latestObservation !== null &&
    firstObservation.observed_at > row.accepted_at &&
    publishedAt <= firstObservation.observed_at &&
    latestObservation.observed_at >= firstObservation.observed_at &&
    currentContentMatchesObservation;
  let relation: unknown = null;
  try {
    relation = JSON.parse(row.relation_evidence);
  } catch {
    return unknown("invalid_relationship_evidence", row);
  }
  const sharedTerms = (relation as { sharedTerms?: unknown })?.sharedTerms;
  const supported =
    row.relation_version === "specific-development-v1" &&
    Array.isArray(sharedTerms) &&
    sharedTerms.length >= 2 &&
    sharedTerms.every((term) => typeof term === "string" && term.length >= 3);
  const regrouped =
    newerGroupId === null ||
    row.newer_group_id !== newerGroupId ||
    row.relation_ended_at !== null ||
    row.candidate_group_ended_at !== null;
  const tokens = (value: string) =>
    new Set(value.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const priorTerms = tokens(`${priorTitle}\n${priorText}`);
  const candidateTerms = tokens(`${title}\n${text}`);
  const newTerms = [...candidateTerms]
    .filter((term) => !priorTerms.has(term))
    .sort();
  const contentComparison = {
    sameContent:
      createHash("sha256").update(text).digest("hex") ===
      createHash("sha256").update(priorText).digest("hex"),
    candidateTermCount: candidateTerms.size,
    priorTermCount: priorTerms.size,
    newTermCount: newTerms.length,
    newTerms: newTerms.slice(0, 40),
    overlapRatio: candidateTerms.size
      ? (candidateTerms.size - newTerms.length) / candidateTerms.size
      : 0,
  };
  return {
    input: null,
    evidence: {
      comparisonVersion: "related-delivery-v1",
      state:
        timely && supported && !regrouped
          ? ("possible_follow_up" as const)
          : ("unknown" as const),
      reason:
        timely && supported && !regrouped
          ? "directional_relation_and_post_acceptance_observation"
          : regrouped
            ? "relationship_or_membership_ended_after_regrouping"
            : supported
              ? "stale_or_uncertain_observation"
              : "weak_relationship_evidence",
      editionId: row.edition_id,
      editionDate: row.edition_date,
      deliveryId: row.delivery_id,
      providerId: row.provider_id,
      acceptedAt: row.accepted_at,
      itemId: row.item_id,
      groupId: row.older_group_id,
      scoreId: row.score_id,
      scoreSnapshot: snapshot.scoreSnapshot ?? null,
      frozenSourceReferences: Array.isArray(snapshot.citations)
        ? snapshot.citations
        : null,
      relationship: {
        id: row.relation_id,
        version: row.relation_version,
        olderGroupId: row.older_group_id,
        newerGroupId: row.newer_group_id,
        evidence: relation,
      },
      candidate: {
        title,
        contentHash: createHash("sha256").update(text).digest("hex"),
        publishedAt,
        firstPostAcceptanceObservation: firstObservation,
        currentContentObservation: latestObservation
          ? {
              sourceId: latestObservation.source_id,
              nativeId: latestObservation.native_id,
              observedAt: latestObservation.observed_at,
              backfilled: latestObservation.backfilled,
              contentMatchesObservation: currentContentMatchesObservation,
            }
          : null,
      },
      priorContent: {
        title: priorTitle,
        contentHash: createHash("sha256").update(priorText).digest("hex"),
      },
      contentComparison,
      suppress: false,
    },
  };
}
