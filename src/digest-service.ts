import { createHash } from "node:crypto";
import type { Store } from "./db/store";
import { DigestStore } from "./db/digest-store";
import { curateDigest, type CurationCandidate } from "./curation";
import { renderDigest } from "./digest-render";
import { SCORING_CRITERIA_VERSION } from "./scoring";

const MAX_CANDIDATES = 500;
export interface DigestOptions {
  date: string;
  timezone: string;
  now: number;
  minScore: number;
  maxItems: number;
  maxPerInterest: number;
}
export const digestDefaults = (
  date: string,
  now = Date.now(),
): DigestOptions => ({
  date,
  timezone: "Europe/London",
  now,
  minScore: 50,
  maxItems: 10,
  maxPerInterest: 4,
});
function validateDate(date: string, timezone: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(date + "T00:00:00Z")
    : new Date(NaN);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid edition date");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error("Invalid edition timezone");
  }
}
/** Draft is read-only. No delivery or user-feedback history exists yet. */
export function draftDigest(store: Store, options: DigestOptions) {
  return store.sqlite
    .transaction(() => draftDigestSnapshot(store, options))
    .deferred();
}
function draftDigestSnapshot(store: Store, options: DigestOptions) {
  validateDate(options.date, options.timezone);
  if (!Number.isSafeInteger(options.now) || options.now < 0)
    throw new Error("Invalid draft time");
  if (options.maxItems > 20 || options.maxPerInterest > 20)
    throw new Error("Digest limits exceed maximum of 20");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: options.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(options.now));
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  if (`${part("year")}-${part("month")}-${part("day")}` !== options.date)
    throw new Error("Draft date must match the local date at preview time");
  const since = Math.max(0, options.now - 86_400_000);
  // Activity reflects ingestion, a source correction, or the first completed score.
  const activity = store.sqlite
    .query<{ item_id: string }, [number, number, number]>(
      "SELECT item_id FROM digest_activity WHERE activity_at>? AND activity_at<=? ORDER BY activity_at DESC,item_id DESC LIMIT ?",
    )
    .all(since, options.now, MAX_CANDIDATES + 1);
  const intake = {
    windowHours: 24,
    limit: MAX_CANDIDATES,
    truncated: activity.length > MAX_CANDIDATES,
    ordering: "most_recent_activity_then_item_id" as const,
  };
  const ids = activity.slice(0, MAX_CANDIDATES).map((row) => row.item_id);
  const dirty = store.sqlite
    .query<{ fingerprint: string }, []>(
      "SELECT fingerprint FROM story_grouping_state WHERE id=1",
    )
    .get();
  const invalidation = store.sqlite
    .query<{ pending: number }, []>(
      "SELECT pending FROM score_invalidation WHERE id=1",
    )
    .get();
  if (
    (ids.length > 0 && (!dirty || dirty.fingerprint === "dirty")) ||
    invalidation?.pending
  )
    return {
      status: "processing" as const,
      reason: "grouping_or_scores_pending",
      selected: [],
      decisions: [],
      intake,
    };
  const terminal: { itemId: string; included: false; reasons: string[] }[] = [];
  const readyIds: string[] = [];
  for (const id of ids) {
    const state = store.sqlite
      .query<
        {
          extract_status: string | null;
          score_status: string | null;
          score_outcome: string | null;
          criteria_version: string | null;
          due_at: number | null;
          refresh_id: string | null;
        },
        [string]
      >(
        `SELECT e.status AS extract_status,j.status AS score_status,j.outcome AS score_outcome,
      s.criteria_version,r.due_at,r.job_id AS refresh_id FROM items i
      LEFT JOIN processing_jobs e ON e.id=(SELECT x.id FROM processing_jobs x WHERE x.item_id=i.id AND x.stage='extract' ORDER BY x.generation DESC LIMIT 1)
      LEFT JOIN processing_jobs j ON j.item_id=i.id AND j.stage='score' AND j.generation=e.generation
      LEFT JOIN score_refresh r ON r.job_id=j.id
      LEFT JOIN item_scores s ON s.id=(SELECT x.id FROM item_scores x WHERE x.item_id=i.id AND x.generation=e.generation ORDER BY x.created_at DESC,x.rowid DESC LIMIT 1)
      WHERE i.id=?`,
      )
      .get(id);
    if (
      state?.extract_status === "failed" ||
      state?.score_status === "failed" ||
      (state?.score_status === "done" && state.score_outcome === "unavailable")
    ) {
      terminal.push({
        itemId: id,
        included: false,
        reasons: ["processing_failed_or_unavailable"],
      });
      continue;
    }
    if (
      !state ||
      state.score_status !== "done" ||
      state.score_outcome !== "scored" ||
      !state.refresh_id ||
      state.criteria_version !== SCORING_CRITERIA_VERSION ||
      (state.due_at !== null && state.due_at <= options.now)
    )
      return {
        status: "processing" as const,
        reason: "scores_pending_or_unavailable",
        selected: [],
        decisions: terminal,
        intake,
      };
    readyIds.push(id);
  }
  const placeholders = readyIds.length
    ? readyIds.map(() => "?").join(",")
    : "NULL";
  const rows = store.sqlite
    .query<
      {
        item_id: string;
        title: string;
        group_id: string | null;
        score_id: string;
        result: string;
        summary: string | null;
      },
      string[]
    >(
      `SELECT i.id AS item_id,i.title,m.group_id,s.id AS score_id,s.result,
    (SELECT a.result FROM analyses a WHERE a.item_id=i.id AND a.generation=j.generation ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1) AS summary
    FROM items i JOIN processing_jobs j ON j.item_id=i.id AND j.stage='score'
    JOIN item_scores s ON s.id=(SELECT x.id FROM item_scores x WHERE x.item_id=i.id AND x.generation=j.generation ORDER BY x.created_at DESC,x.rowid DESC LIMIT 1)
    LEFT JOIN story_memberships m ON m.item_id=i.id AND m.ended_at IS NULL
    WHERE i.id IN (${placeholders}) AND j.generation=(SELECT max(e.generation) FROM processing_jobs e WHERE e.stage='extract' AND e.item_id=i.id)
    ORDER BY i.id`,
    )
    .all(...readyIds);
  // Bound per-item reads and the combined citations of each development.
  // Oversized candidates are explained individually instead of blocking the day.
  const groupReferences = new Map<
    string,
    { sourceId: string; nativeId: string; url: string | null }[]
  >();
  const oversizedGroups = new Map<string, string>();
  const groupKey = (row: (typeof rows)[number]) =>
    JSON.stringify(
      row.group_id === null ? ["item", row.item_id] : ["group", row.group_id],
    );
  for (const row of rows) {
    const key = groupKey(row);
    if (groupReferences.has(key) || oversizedGroups.has(key)) continue;
    const query =
      row.group_id === null
        ? "SELECT source_id,native_id,url FROM item_sources INDEXED BY item_sources_item WHERE item_id=? LIMIT 21"
        : "SELECT r.source_id,r.native_id,r.url FROM story_memberships m INDEXED BY story_members_group JOIN item_sources r INDEXED BY item_sources_item ON r.item_id=m.item_id WHERE m.group_id=? AND m.ended_at IS NULL LIMIT 21";
    const size = store.sqlite
      .query<{ n: number; bytes: number }, [string]>(
        `SELECT count(*) AS n,coalesce(sum(length(CAST(source_id AS BLOB))+length(CAST(native_id AS BLOB))+coalesce(length(CAST(url AS BLOB)),0)),0) AS bytes FROM (${query})`,
      )
      .get(row.group_id ?? row.item_id)!;
    if (size.n > 20 || size.bytes > 4096) {
      oversizedGroups.set(
        key,
        size.n > 20 ? "reference_limit_exceeded" : "reference_bytes_exceeded",
      );
      continue;
    }
    const refs = store.sqlite
      .query<
        { source_id: string; native_id: string; url: string | null },
        [string]
      >(query)
      .all(row.group_id ?? row.item_id)
      .map((ref) => ({
        sourceId: ref.source_id,
        nativeId: ref.native_id,
        url: ref.url,
      }));
    groupReferences.set(
      key,
      refs.sort((a, b) =>
        a.sourceId < b.sourceId
          ? -1
          : a.sourceId > b.sourceId
            ? 1
            : a.nativeId < b.nativeId
              ? -1
              : a.nativeId > b.nativeId
                ? 1
                : 0,
      ),
    );
  }
  const limited = rows.flatMap((row) => {
    const size = store.sqlite
      .query<{ size: number }, [string]>(
        "SELECT length(CAST(provenance AS BLOB)) AS size FROM item_scores WHERE id=?",
      )
      .get(row.score_id)?.size;
    const reason = oversizedGroups.has(groupKey(row))
      ? oversizedGroups.get(groupKey(row))!
      : size === undefined || size > 200_000
        ? "score_snapshot_limit_exceeded"
        : null;
    return reason
      ? [{ itemId: row.item_id, included: false, reasons: [reason] }]
      : [];
  });
  const limitedIds = new Set(limited.map((decision) => decision.itemId));
  const candidates: CurationCandidate[] = rows
    .filter((row) => !limitedIds.has(row.item_id))
    .map((row) => {
      const score = JSON.parse(row.result) as {
        total: number;
        eligible: boolean;
        reasons: string[];
      };
      const analysis = row.summary
        ? (JSON.parse(row.summary) as {
            summary?: string;
            uncertainty?: string[];
          })
        : null;
      const summary = analysis?.summary ?? null;
      return {
        itemId: row.item_id,
        groupId: row.group_id,
        scoreId: row.score_id,
        score: score.total,
        scoreSnapshot: { id: row.score_id, result: score },
        eligible: score.eligible,
        interestIds: score.reasons
          .filter((reason) => reason.startsWith("interest:"))
          .map((reason) => reason.slice(9).split("@")[0]!),
        title: row.title,
        summary,
        uncertainty: analysis?.uncertainty ?? [],
        explanation:
          score.reasons.join("; ") || "No score explanation available",
        citations: [...(groupReferences.get(groupKey(row)) ?? [])],
        discovery: false,
        update: null,
      };
    });
  const result = curateDigest({
    candidates,
    priorEditions: [],
    minScore: options.minScore,
    maxItems: options.maxItems,
    maxPerInterest: options.maxPerInterest,
  });
  const evidenceById = new Map(
    rows.map((row) => {
      const score = JSON.parse(row.result) as {
        total: number;
        eligible: boolean;
      };
      return [
        row.item_id,
        {
          scoreId: row.score_id,
          score: score.total,
          eligible: score.eligible,
          groupId: row.group_id,
          citations: groupReferences.get(groupKey(row)) ?? null,
        },
      ] as const;
    }),
  );
  const decisionEvidence = [...result.decisions, ...limited, ...terminal].map(
    (decision) => ({
      itemId: decision.itemId,
      evidence: evidenceById.get(decision.itemId) ?? null,
    }),
  );
  result.decisions.push(...limited, ...terminal);
  result.decisions.sort((a, b) =>
    a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
  );
  if (result.status === "no_digest" && (limited.length || terminal.length))
    return {
      status: "unavailable" as const,
      reason: limited.length
        ? "candidate_resource_limits"
        : "candidate_processing_failed",
      selected: result.selected,
      decisions: result.decisions,
      intake,
    };
  for (const item of result.selected) {
    const row = store.sqlite
      .query<{ provenance: string; size: number }, [string]>(
        "SELECT provenance,length(CAST(provenance AS BLOB)) AS size FROM item_scores WHERE id=?",
      )
      .get(item.scoreId);
    if (!row || row.size > 200_000)
      throw new Error("Score snapshot changed during draft");
    item.scoreSnapshot = {
      ...(item.scoreSnapshot as object),
      provenance: JSON.parse(row.provenance) as unknown,
    };
  }
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
    ...result,
    decisionEvidence,
    rendered,
    date: options.date,
    timezone: options.timezone,
    asOf: options.now,
    intake,
    history: "delivery_history_unavailable" as const,
  };
}
/** Confirmation binds the operator to an exact draft and expires after five minutes. */
export function previewDigest(store: Store, options: DigestOptions) {
  const draft = draftDigest(store, options);
  const hash = createHash("sha256")
    .update(JSON.stringify({ options, draft }))
    .digest("hex");
  return {
    draft,
    confirmation: { asOf: options.now, expiresAt: options.now + 300_000, hash },
  };
}
/** Recheck the confirmed payload and current inputs in one SQLite snapshot before freezing. */
export function freezeDigest(
  store: Store,
  options: DigestOptions,
  confirmation: string,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(now) ||
    now < options.now ||
    now - options.now > 300_000
  )
    throw new Error("Digest confirmation expired");
  return store.sqlite
    .transaction(() => {
      const preview = previewDigest(store, options);
      if (
        !/^[0-9a-f]{64}$/.test(confirmation) ||
        preview.confirmation.hash !== confirmation
      )
        throw new Error("Digest confirmation does not match current draft");
      const draft = preview.draft;
      if (draft.status !== "ready" || !draft.rendered)
        throw new Error(`Cannot freeze digest: ${draft.status}`);
      const fresh = draftDigest(store, { ...options, now });
      if (
        fresh.status !== "ready" ||
        JSON.stringify({ ...draft, asOf: 0 }) !==
          JSON.stringify({ ...fresh, asOf: 0 })
      )
        throw new Error("Digest changed since preview; review a new draft");
      return new DigestStore(store.sqlite).freeze(
        {
          date: options.date,
          timezone: options.timezone,
          subject: draft.rendered.subject,
          html: draft.rendered.html,
          text: draft.rendered.text,
          decisionSnapshot: {
            asOf: options.now,
            intake: draft.intake,
            limits: {
              minScore: options.minScore,
              maxItems: options.maxItems,
              maxPerInterest: options.maxPerInterest,
            },
            history: draft.history,
            decisions: draft.decisions,
            decisionEvidence: draft.decisionEvidence,
            feedbackTargets: draft.rendered.feedbackTargets,
          },
          items: draft.selected.map((item) => ({
            itemId: item.itemId,
            groupId: item.groupId,
            scoreId: item.scoreId,
            snapshot: item,
          })),
        },
        now,
      );
    })
    .deferred();
}
