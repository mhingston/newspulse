import type { Database } from "bun:sqlite";
import type { Store } from "./db/store";

/**
 * Development change evidence (issue #26). Recordings are deterministic,
 * append-only and derived only from retained source content or the grouping
 * audit trail — never from model comparisons, which cannot establish factual
 * certainty. Every event separates the source's declared report date, an
 * explicitly declared event time (when a source adapter provides one; no
 * shipped adapter does today) and the local observation time. Missing dates
 * stay null and are reported as unknown, never substituted, so chronology is
 * never invented from ingestion or publication timestamps.
 */

export const CHANGE_EVIDENCE_VERSION = "development-change-v1";

export const CHANGE_EVENT_KINDS = [
  "new_coverage",
  "content_change",
  "grouping_corrected",
] as const;
export type ChangeEventKind = (typeof CHANGE_EVENT_KINDS)[number];

/** Bounded lexical diff so a large body change cannot grow a row. */
const DIFF_TERM_LIMIT = 20;

export interface ChangeEvidence {
  reason?: string;
  version: string;
  titleChanged?: boolean;
  bodyChanged?: boolean;
  urlChanged?: boolean;
  addedTerms?: string[];
  removedTerms?: string[];
  /** For grouping corrections in the read-time dev story-group shape. */
  movedToGroupId?: string | null;
  ruleVersion?: string;
}

function terms(text: string): string[] {
  return [
    ...new Set(text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{4,}/gu) ?? []),
  ].sort();
}

/** Deterministic term diff between two retained bodies, add and remove capped. */
export function boundedTermDiff(
  previous: string,
  current: string,
): { addedTerms: string[]; removedTerms: string[] } {
  const before = new Set(terms(previous));
  const after = new Set(terms(current));
  return {
    addedTerms: [...after]
      .filter((term) => !before.has(term))
      .sort()
      .slice(0, DIFF_TERM_LIMIT),
    removedTerms: [...before]
      .filter((term) => !after.has(term))
      .sort()
      .slice(0, DIFF_TERM_LIMIT),
  };
}

/**
 * Records a change event inside the caller's transaction. Rows are
 * append-only: no code path ever updates or deletes them. A grouping-corrected
 * event stores the group whose membership ended; other events keep their
 * group_id only when a live membership already exists at record time and are
 * otherwise resolved to the item's development at read time.
 */
export function recordChangeEvent(
  db: Database,
  event: {
    itemId: string;
    kind: ChangeEventKind;
    /** Source-declared report date for this change; null when the source gave none. */
    reportedAt: number | null;
    /** Declared event time; null unless an adapter explicitly declares one. */
    eventAt: number | null;
    observedAt: number;
    sourceId: string | null;
    nativeId: string | null;
    evidence: Omit<ChangeEvidence, "version">;
  } & (
    | { kind: "grouping_corrected"; groupId: string }
    | { kind: "new_coverage" | "content_change" }
  ),
): void {
  if (!Number.isSafeInteger(event.observedAt))
    throw new Error("Change events require a recorded observation time");
  const groupId =
    event.kind === "grouping_corrected"
      ? event.groupId
      : (db
          .query<{ group_id: string }, [string]>(
            "SELECT group_id FROM story_memberships WHERE item_id=? AND ended_at IS NULL LIMIT 1",
          )
          .get(event.itemId)?.group_id ?? null);
  db.query(
    "INSERT INTO story_change_events(item_id,group_id,kind,source_id,native_id,reported_at,event_at,observed_at,evidence) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    event.itemId,
    groupId,
    event.kind,
    event.sourceId,
    event.nativeId,
    event.reportedAt ?? null,
    event.eventAt ?? null,
    event.observedAt,
    JSON.stringify({ version: CHANGE_EVIDENCE_VERSION, ...event.evidence }),
  );
}

interface EventRow {
  id: number;
  item_id: string;
  group_id: string | null;
  kind: string;
  source_id: string | null;
  native_id: string | null;
  reported_at: number | null;
  event_at: number | null;
  observed_at: number;
  evidence: string;
}

export interface ChangeCitation {
  itemId: string;
  title: string | null;
  url: string | null;
  sourceId: string | null;
  nativeId: string | null;
  sourceTitle: string | null;
}

export interface Uncertainty {
  recordedBy: string;
  /** Change evidence never establishes that any reported claim is true. */
  factualCertainty: null;
  modelCompared: false;
  note: string;
}

export interface GroupingContext {
  evidence: unknown;
  startedAt: number | null;
  endedAt: number | null;
}

export interface DevelopmentChange {
  id: number;
  kind: string;
  item: ChangeCitation;
  /** Source-declared report date; null means unknown, never a fallback. */
  reportedAt: number | null;
  /** Declared event time; null means unknown, never a fallback. */
  eventAt: number | null;
  /** Always-present local observation (ingestion) time. */
  observedAt: number;
  development: { groupId: string; current: boolean } | null;
  detailAvailable: boolean;
  /** Set when the referenced content expired and only citations remain. */
  detailUnavailableReason: string | null;
  evidence: unknown;
  groupingContext: GroupingContext | null;
}

export interface DevelopmentChanges {
  groupId: string | null;
  window: { since: number | null; until: number | null };
  events: DevelopmentChange[];
  coverage: {
    currentMembers: ChangeCitation[];
    /** Current members whose own content recorded no change in the window. */
    membersWithoutChangeEvidence: string[];
    truncated: boolean;
  };
  uncertainty: Uncertainty;
  contentKind: string;
}

/**
 * Read surface backing the MCP tool: returns the recorded change evidence for
 * a development (by group id) or an item, plus the live coverage picture, with
 * citations that survive content expiry. Timeline construction and retrieval
 * stay inside the monolith; a connecting MCP agent explains the change from
 * this evidence — the service never performs conversational reasoning itself.
 */
export function developmentChanges(
  store: Store,
  query: {
    groupId?: string;
    itemId?: string;
    limit?: number;
    since?: number;
    until?: number;
  } = {},
): DevelopmentChanges | null {
  if (query.groupId === undefined && query.itemId === undefined)
    throw new Error("A group or item id is required");
  const sqlite = store.sqlite;
  const limit = Math.max(1, Math.min(100, query.limit ?? 50));

  const itemIds: string[] = [];
  if (query.groupId !== undefined) {
    const members = sqlite
      .query<{ item_id: string }, [string]>(
        "SELECT DISTINCT item_id FROM story_memberships WHERE group_id=? ORDER BY item_id",
      )
      .all(query.groupId);
    if (!members.length) return null;
    itemIds.push(...members.map((row) => row.item_id));
  } else {
    const resolved =
      sqlite
        .query<{ item_id: string }, [string]>(
          "SELECT item_id FROM item_redirects WHERE old_id=?",
        )
        .get(query.itemId!)?.item_id ?? query.itemId!;
    itemIds.push(resolved);
  }

  const currentMembership = new Map(
    sqlite
      .query<{ item_id: string; group_id: string }, []>(
        "SELECT item_id,group_id FROM story_memberships WHERE ended_at IS NULL",
      )
      .all()
      .map((row) => [row.item_id, row.group_id] as const),
  );

  const clauses: string[] = [
    `item_id IN (${itemIds.map(() => "?").join(",")})`,
  ];
  const params: (string | number)[] = [...itemIds];
  if (query.groupId !== undefined) {
    clauses.push("(group_id=? OR group_id IS NULL)");
    params.push(query.groupId);
  }
  if (query.since !== undefined) {
    clauses.push("observed_at>=?");
    params.push(query.since);
  }
  if (query.until !== undefined) {
    clauses.push("observed_at<?");
    params.push(query.until);
  }

  const rows = sqlite
    .query<EventRow, (string | number)[]>(
      `SELECT * FROM story_change_events WHERE ${clauses.join(" AND ")}
       ORDER BY observed_at DESC,id DESC LIMIT ?`,
    )
    .all(...params, limit + 1);

  const citation = (itemId: string): ChangeCitation | null => {
    const row = sqlite
      .query<{ id: string; title: string; url: string | null }, [string]>(
        "SELECT id,title,url FROM items WHERE id=?",
      )
      .get(itemId);
    if (!row) return null;
    return {
      itemId: row.id,
      title: row.title,
      url: row.url,
      sourceId: null,
      nativeId: null,
      sourceTitle: null,
    };
  };

  const detailState = (
    itemId: string,
  ): {
    detailAvailable: boolean;
    reason: string | null;
  } => {
    const retained =
      sqlite
        .query<{ n: number }, [string]>(
          "SELECT EXISTS(SELECT 1 FROM content_versions WHERE item_id=? AND purged_at IS NULL AND text<>'') AS n",
        )
        .get(itemId)!.n > 0;
    if (retained) return { detailAvailable: true, reason: null };
    const purged =
      sqlite
        .query<{ n: number }, [string]>(
          "SELECT EXISTS(SELECT 1 FROM retention_purges WHERE item_id=? AND class='feed_text') AS n",
        )
        .get(itemId)!.n > 0;
    return {
      detailAvailable: false,
      reason: purged
        ? "content_expired_retention_citation_retained"
        : "content_not_extracted",
    };
  };

  const events: DevelopmentChange[] = [];
  for (const row of rows.slice(0, limit)) {
    const item = citation(row.item_id);
    if (!item) continue;
    const { detailAvailable, reason } = detailState(row.item_id);
    const membership = query.groupId
      ? (sqlite
          .query<
            {
              evidence: string;
              started_at: number;
              ended_at: number | null;
            },
            [string, string]
          >(
            "SELECT evidence,started_at,ended_at FROM story_memberships WHERE item_id=? AND group_id=? ORDER BY id DESC LIMIT 1",
          )
          .get(row.item_id, query.groupId) ?? null)
      : null;
    const resolvedGroupId =
      row.group_id ?? currentMembership.get(row.item_id) ?? null;
    const source = row.source_id
      ? (sqlite
          .query<{ title: string }, [string]>(
            "SELECT title FROM sources WHERE id=?",
          )
          .get(row.source_id)?.title ?? null)
      : null;
    events.push({
      id: row.id,
      kind: row.kind,
      item: {
        ...item,
        sourceId: row.source_id,
        nativeId: row.native_id,
        sourceTitle: source,
      },
      reportedAt: row.reported_at,
      eventAt: row.event_at,
      observedAt: row.observed_at,
      development: resolvedGroupId
        ? {
            groupId: resolvedGroupId,
            current: currentMembership.get(row.item_id) === resolvedGroupId,
          }
        : null,
      detailAvailable,
      detailUnavailableReason: reason,
      evidence: JSON.parse(row.evidence) as unknown,
      groupingContext: membership
        ? {
            evidence: JSON.parse(membership.evidence) as unknown,
            startedAt: membership.started_at,
            endedAt: membership.ended_at,
          }
        : null,
    });
  }

  const scoped = query.groupId !== undefined;
  const currentMembers = (
    scoped
      ? itemIds.filter((id) => currentMembership.get(id) === query.groupId)
      : itemIds
  )
    .map(citation)
    .filter((entry): entry is ChangeCitation => entry !== null);
  const changedItems = new Set(
    events
      .filter((event) => event.kind === "content_change")
      .map((event) => event.item.itemId),
  );
  return {
    groupId: query.groupId ?? currentMembership.get(itemIds[0]!) ?? null,
    window: { since: query.since ?? null, until: query.until ?? null },
    events,
    coverage: {
      currentMembers,
      membersWithoutChangeEvidence: currentMembers
        .filter((member) => !changedItems.has(member.itemId))
        .map((member) => member.itemId),
      truncated: rows.length > limit,
    },
    uncertainty: {
      recordedBy: CHANGE_EVIDENCE_VERSION,
      factualCertainty: null,
      modelCompared: false,
      note: "Recorded change evidence is a deterministic observation of retained source content and grouping corrections; it does not establish that any claim is true, that a correction is valid, or that a change list is complete. Items without a source report date or declared event time are reported as unknown and are never re-dated from ingestion or observation. Expired content is cited with its detail marked unavailable.",
    },
    contentKind:
      "deterministic_change_evidence_with_untrusted_source_citations",
  };
}
