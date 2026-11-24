import { createHash } from "node:crypto";
import type { Store } from "./db/store";
import { DigestStore } from "./db/digest-store";
import {
  curateDigest,
  type CurationCandidate,
  type PriorEdition,
} from "./curation";
import { renderDigest } from "./digest-render";
import { SCORING_CRITERIA_VERSION } from "./scoring";
import { isYouTubeShortUrl } from "./adapters/rss";

const MAX_CANDIDATES = 500;
/** Fanned-out links per roundup parent that may be shown in an edition. */
const MAX_ROUNDUP_CHILDREN = 12;
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
  maxItems: 20,
  maxPerInterest: 8,
});
/**
 * Feed titles are sometimes only a fragment ("Switzerland", "dozen software
 * vendors have now validated"). Prefer the fetched page's declared title when
 * the feed title looks incomplete and the page title says more.
 */
/**
 * Without a model summary, the feed's own description is the reader's
 * summary. It is truncated to a short lead rather than summarised.
 */
function isBoilerplateText(value: string): boolean {
  return /About\s*Press\s*Copyright\s*Contact us\s*Creator(?:s)?\s*Advertise/i.test(
    value,
  );
}
function feedSummary(text: string | null): string | null {
  const value = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!value || isBoilerplateText(value)) return null;
  if (value.length <= 280) return value;
  const cut = value.slice(0, 280);
  const end = cut.lastIndexOf(" ");
  return `${cut.slice(0, end > 200 ? end : 280).trimEnd()}…`;
}
/** A title that is only a URL is not a headline; it is a placeholder for one. */
function isUrlTitle(value: string): boolean {
  return /^(?:https?:\/\/|www\.)\S+$/i.test(value.trim());
}
function displayTitle(feedTitle: string, pageTitle: string | null): string {
  const feed = feedTitle.trim();
  const page = pageTitle?.replace(/\s+/g, " ").trim() ?? "";
  if (!page || page === feed) return feedTitle;
  const fragment =
    !feed ||
    isUrlTitle(feed) ||
    /^[a-z]/.test(feed) ||
    feed.split(/\s+/).length <= 2;
  if (!fragment) return feedTitle;
  return page.split(/\s+/).length >= 3 && page.length > feed.length
    ? page
    : feedTitle;
}
/**
 * Newsletter navigation lines sometimes became items before the adapter
 * filtered them. A title that is a markdown link run or a bare call to action
 * is not a story, so it is left out of the edition rather than shown as one.
 */
function isNavigationTitle(title: string): boolean {
  const value = title.trim();
  if (!value) return true;
  if (/\]\(/.test(value)) return true;
  return /^(?:join the discussion|more on our site|follow image link|read more|view online|share|reply|comments?)(?:\b|:)/i.test(
    value,
  );
}
/** Explicit sponsorship labels (e.g. "(Sponsored)", "Sponsored: ...") are excluded. */
function isSponsoredTitle(title: string): boolean {
  const value = title.trim();
  return (
    /[\(\[]\s*(?:sponsored|partner\s+content|advertisement|ad)\s*[\)\]]/i.test(
      value,
    ) ||
    /^(?:sponsored|advertisement|advertorial|partner\s+content)\s*[:\-–—]/i.test(
      value,
    ) ||
    /\bsponsored\s+(?:post|content|by|article|listing)\b/i.test(value)
  );
}
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
/** Draft is read-only; provider acceptance is not evidence of readership. */
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
        url: string | null;
        group_id: string | null;
        score_id: string;
        result: string;
        provenance: string | null;
        summary: string | null;
        page_title: string | null;
        extracted_text: string | null;
        feed_text: string | null;
      },
      string[]
    >(
      `SELECT i.id AS item_id,i.title,i.url,m.group_id,s.id AS score_id,s.result,CASE WHEN length(CAST(s.provenance AS BLOB))<=200000 THEN s.provenance ELSE NULL END AS provenance,
    (SELECT a.result FROM analyses a WHERE a.item_id=i.id AND a.generation=j.generation ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1) AS summary,
    (SELECT json_extract(e.result,'$.title') FROM processing_jobs e WHERE e.item_id=i.id AND e.stage='extract' AND e.status='done' AND e.outcome='extracted' AND e.generation=j.generation LIMIT 1) AS page_title,
    (SELECT substr(json_extract(e.result,'$.text'),1,1000) FROM processing_jobs e WHERE e.item_id=i.id AND e.stage='extract' AND e.status='done' AND e.outcome='extracted' AND e.generation=j.generation LIMIT 1) AS extracted_text,
    (SELECT c.text FROM content c WHERE c.item_id=i.id AND c.purged_at IS NULL AND length(CAST(c.text AS BLOB))<=20000) AS feed_text
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
    {
      sourceId: string;
      sourceName: string;
      nativeId: string;
      url: string | null;
      title: string;
    }[]
  >();
  const oversizedGroups = new Map<string, string>();
  const groupKey = (row: (typeof rows)[number]) =>
    JSON.stringify(
      row.group_id === null ? ["item", row.item_id] : ["group", row.group_id],
    );
  for (const row of rows) {
    const key = groupKey(row);
    if (groupReferences.has(key) || oversizedGroups.has(key)) continue;
    // The source name is reader-facing; the id only orders citations.
    const selection =
      "SELECT r.source_id,coalesce(nullif(trim(s.title),''),r.source_id) AS source_name,r.native_id,r.url,i.title";
    const query =
      row.group_id === null
        ? `${selection} FROM item_sources r INDEXED BY item_sources_item JOIN items i ON i.id=r.item_id LEFT JOIN sources s ON s.id=r.source_id WHERE r.item_id=? LIMIT 21`
        : `${selection} FROM story_memberships m INDEXED BY story_members_group JOIN item_sources r INDEXED BY item_sources_item ON r.item_id=m.item_id JOIN items i ON i.id=r.item_id LEFT JOIN sources s ON s.id=r.source_id WHERE m.group_id=? AND m.ended_at IS NULL LIMIT 21`;
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
        {
          source_id: string;
          source_name: string;
          native_id: string;
          url: string | null;
          title: string;
        },
        [string]
      >(query)
      .all(row.group_id ?? row.item_id)
      .map((ref) => ({
        sourceId: ref.source_id,
        sourceName: ref.source_name,
        nativeId: ref.native_id,
        url: ref.url,
        title: ref.title,
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
  const priorEditions: PriorEdition[] = [];
  const candidates: CurationCandidate[] = rows
    .filter((row) => !limitedIds.has(row.item_id))
    .filter((row) => !isNavigationTitle(row.title))
    .filter((row) => !isSponsoredTitle(row.title))
    .filter((row) => !isYouTubeShortUrl(row.url))
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
            claims?: { statement: string }[];
          })
        : null;
      const summary =
        analysis?.summary ??
        feedSummary(row.feed_text) ??
        feedSummary(row.extracted_text);
      const keyPoints = Array.isArray(analysis?.claims)
        ? analysis.claims.map((claim) => claim.statement)
        : [];
      const provenance = JSON.parse(row.provenance!) as {
        history?: {
          state?: string;
          reason?: string;
          editionId?: string;
          acceptedAt?: number;
          update?: { observedAt?: number } | null;
        };
      };
      const history = provenance.history;
      // The score captured the matching evidence under the same invalidation
      // fence. Use candidate identity here so regrouping cannot create a new
      // historical assertion within curation.
      if (
        history?.state === "accepted" &&
        history.editionId &&
        typeof history.acceptedAt === "number"
      ) {
        priorEditions.push({
          editionId: history.editionId,
          state: "sent",
          publishedAt: history.acceptedAt,
          items: [{ itemId: row.item_id, groupId: null }],
        });
      } else if (
        history?.state === "unknown" &&
        (history.reason === "ambiguous_delivery" ||
          history.reason === "history_limit" ||
          history.reason === "historical_snapshot_limit")
      ) {
        priorEditions.push({
          editionId: history.editionId ?? `unknown:${row.item_id}`,
          state: "ambiguous",
          publishedAt: null,
          items: [{ itemId: row.item_id, groupId: null }],
        });
      }
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
        title: displayTitle(row.title, row.page_title),
        summary,
        keyPoints,
        uncertainty: analysis?.uncertainty ?? [],
        explanation:
          score.reasons.join("; ") || "No score explanation available",
        citations: [...(groupReferences.get(groupKey(row)) ?? [])],
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
      };
    });
  const result = curateDigest({
    candidates,
    priorEditions,
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
  const selectedIds = new Set(result.selected.map((item) => item.itemId));
  const roundupChildIds = new Set(
    store.sqlite
      .query<{ child: string; parent: string }, [string]>(
        "SELECT r.item_id AS child,r.parent_item_id AS parent FROM item_sources r WHERE r.parent_item_id IS NOT NULL AND r.item_id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify([...selectedIds]))
      .filter((row) => selectedIds.has(row.parent))
      .map((row) => row.child),
  );
  result.selected = result.selected.filter(
    (item) => !roundupChildIds.has(item.itemId),
  );
  for (const item of result.selected) {
    const row = store.sqlite
      .query<{ provenance: string | null; size: number }, [string]>(
        "SELECT CASE WHEN length(CAST(provenance AS BLOB))<=200000 THEN provenance ELSE NULL END AS provenance,length(CAST(provenance AS BLOB)) AS size FROM item_scores WHERE id=?",
      )
      .get(item.scoreId);
    if (!row || row.size > 200_000 || row.provenance === null)
      throw new Error("Score snapshot changed during draft");
    item.scoreSnapshot = {
      ...(item.scoreSnapshot as object),
      provenance: JSON.parse(row.provenance) as unknown,
    };
  }
  const roundupFor = (itemId: string) =>
    store.sqlite
      .query<{ url: string | null; title: string }, [string, number]>(
        `SELECT DISTINCT c.url,c.title FROM item_sources r JOIN items c ON c.id=r.item_id WHERE r.parent_item_id=? AND c.url IS NOT NULL ORDER BY c.id LIMIT ?`,
      )
      .all(itemId, MAX_ROUNDUP_CHILDREN)
      .filter((child): child is { url: string; title: string } => !!child.url)
      .map((child) => ({ url: child.url, title: child.title }));
  const rendered =
    result.status === "ready"
      ? renderDigest(
          options.date,
          result.selected.map((item) => ({
            itemId: item.itemId,
            title: item.title,
            summary: item.summary,
            keyPoints: item.keyPoints,
            uncertainty: item.uncertainty,
            why: item.explanation,
            references: item.citations.map((ref) => ({
              source: ref.sourceName ?? ref.sourceId,
              nativeId: ref.nativeId,
              url: ref.url,
              title: ref.title,
            })),
            roundup: roundupFor(item.itemId),
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
    history: "provider_acceptance_and_unresolved_attempts" as const,
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
