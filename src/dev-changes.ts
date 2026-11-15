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

/** Per-list term cap so a large body change cannot grow a row. */
const DIFF_TERM_LIMIT = 20;
/** Hard envelope for the serialized term diff inside a stored evidence row. */
const DIFF_BYTES_LIMIT = 2048;
/** Individual tokens are bounded, so one long source token is never stored. */
const DIFF_TOKEN_MAX = 24;
/** Bound for membership-id scans backing one read. */
const MEMBER_QUERY_CAP = 2000;

const encoder = new TextEncoder();
export function tokenBytes(term: string): number {
  return encoder.encode(JSON.stringify(term)).length;
}

/** The row id of the content_versions insert that preceded the event record. */
export function recordedVersionId(db: Database): number {
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!
    .id;
}

export interface ChangeEvidence {
  reason?: string;
  version: string;
  titleChanged?: boolean;
  bodyChanged?: boolean;
  urlChanged?: boolean;
  addedTerms?: string[];
  removedTerms?: string[];
  /** Set when the term diff was truncated to fit the bounded evidence row. */
  diffTruncated?: boolean;
  /**
   * Set instead of a term diff when the previous body could not be compared:
   * its text was purged or the observation delivered no comparable body.
   */
  bodyComparison?: "unavailable_previous_body_not_retained";
  /** For grouping corrections; names the association change. */
  movedFromGroupId?: string;
  movedToGroupId?: string | null;
  ruleVersion?: string;
}

function terms(text: string): { terms: Set<string>; dropped: boolean } {
  const lowered = text.toLocaleLowerCase("en");
  // Whole-token match: lookarounds require the run of letters/digits to end
  // within the cap, so a one-megabyte token from a hostile feed is discarded
  // outright instead of being split into cap-sized chunks.
  const matched =
    lowered.match(
      new RegExp(
        `(?<![\\p{L}\\p{N}])[\\p{L}\\p{N}]{4,${DIFF_TOKEN_MAX}}(?![\\p{L}\\p{N}])`,
        "gu",
      ),
    ) ?? [];
  // Any over-long token (or short non-word fragment excluded by the floor)
  // still marks the diff truncated, so evidence consumers see that the
  // bounded diff is a partial view of the bodies.
  const dropped = new RegExp(`[\\p{L}\\p{N}]{${DIFF_TOKEN_MAX + 1},}`).test(
    lowered,
  );
  return { terms: new Set(matched), dropped };
}

/**
 * Deterministic, byte-bounded term diff between two retained bodies.
 * Individual tokens are length-capped — a one-megabyte token from a hostile
 * feed is discarded, never stored — each list is capped at DIFF_TERM_LIMIT,
 * and the combined diff is bounded at DIFF_BYTES_LIMIT with `truncated`
 * returned so truncation is always recorded in the evidence row.
 */
export function boundedTermDiff(
  previous: string,
  current: string,
): { addedTerms: string[]; removedTerms: string[]; truncated: boolean } {
  const before = terms(previous);
  const after = terms(current);
  const added = [...after.terms]
    .filter((term) => !before.terms.has(term))
    .sort();
  const removed = [...before.terms]
    .filter((term) => !after.terms.has(term))
    .sort();
  let bytes = 0;
  let truncated = before.dropped || after.dropped;
  const cappedAdded: string[] = [];
  const cappedRemoved: string[] = [];
  const overBudget = (term: string) =>
    bytes + tokenBytes(term) + 6 > DIFF_BYTES_LIMIT;
  for (const [list, capped] of [
    [added, cappedAdded],
    [removed, cappedRemoved],
  ] as const) {
    for (const term of list) {
      if (capped.length >= DIFF_TERM_LIMIT || overBudget(term)) {
        truncated = true;
        break;
      }
      capped.push(term);
      bytes += tokenBytes(term) + 6;
    }
  }
  return { addedTerms: cappedAdded, removedTerms: cappedRemoved, truncated };
}

/**
 * Records a change event inside the caller's transaction. Rows are
 * append-only: no code path ever updates or deletes them. A grouping-corrected
 * event stores the group whose association changed; other events keep their
 * group_id only when a live membership already exists at record time and are
 * otherwise resolved to the item's development at read time. `versionId` binds
 * content events to the exact recorded content version, so citations stay
 * immutable against later item edits.
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
    /** The content_versions row this event cites; null for grouping events. */
    versionId: number | null;
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
    "INSERT INTO story_change_events(item_id,group_id,kind,source_id,native_id,reported_at,event_at,observed_at,version_id,evidence) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    event.itemId,
    groupId,
    event.kind,
    event.sourceId,
    event.nativeId,
    event.reportedAt ?? null,
    event.eventAt ?? null,
    event.observedAt,
    event.versionId ?? null,
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
  version_id: number | null;
  evidence: string;
}

export interface ChangeCitation {
  itemId: string;
  title: string | null;
  url: string | null;
  sourceId: string | null;
  nativeId: string | null;
  sourceTitle: string | null;
  /** Set when the citation is bound to the recorded content version. */
  versionId: number | null;
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
  /** Set when the cited version expired and only the citation remains. */
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
 *
 * Attribution is resolved consistently through membership history: a recorded
 * group wins; otherwise the membership effective at the event's observation
 * time; otherwise the item's live membership. A regrouping never reattributes
 * earlier coverage, and the move records `grouping_corrected` evidence on both
 * sides of the correction, so the triggering update stays discoverable from
 * the new development.
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
  const scopedGroup = query.groupId;

  // Resolve the requested item through redirects and require existence, so an
  // unknown id returns null (the MCP surface reports "not found") instead of
  // a successful but empty envelope.
  const itemIds: string[] = [];
  if (scopedGroup !== undefined) {
    const members = sqlite
      .query<{ item_id: string }, [string, number]>(
        "SELECT DISTINCT item_id FROM story_memberships WHERE group_id=? ORDER BY item_id LIMIT ?",
      )
      .all(scopedGroup, MEMBER_QUERY_CAP);
    if (!members.length) return null;
    itemIds.push(...members.map((row) => row.item_id));
  } else {
    const resolved =
      sqlite
        .query<{ item_id: string }, [string]>(
          "SELECT item_id FROM item_redirects WHERE old_id=?",
        )
        .get(query.itemId!)?.item_id ?? query.itemId!;
    if (!sqlite.query("SELECT 1 FROM items WHERE id=?").get(resolved))
      return null;
    itemIds.push(resolved);
  }

  // Membership, citation and detail lookups are scoped to the resolved item
  // ids only; no read here scales with the full membership table.
  const liveMembership = new Map(
    sqlite
      .query<{ item_id: string; group_id: string }, (string | number)[]>(
        `SELECT item_id,group_id FROM story_memberships
         WHERE ended_at IS NULL AND item_id IN (${itemIds.map(() => "?").join(",")})
         LIMIT ?`,
      )
      .all(...itemIds, MEMBER_QUERY_CAP)
      .map((row) => [row.item_id, row.group_id] as const),
  );
  return developmentChangesRead(store, {
    ...query,
    limit,
    scopedGroup,
    itemIds,
    liveMembership,
  });
}

interface ReadContext {
  limit: number;
  scopedGroup?: string;
  itemIds: string[];
  liveMembership: Map<string, string>;
}

function developmentChangesRead(
  store: Store,
  query: ReadContext & {
    since?: number;
    until?: number;
  },
): DevelopmentChanges {
  const sqlite = store.sqlite;
  const limit = query.limit;
  const scopedGroup = query.scopedGroup;
  const itemIds = query.itemIds;
  const liveMembership = query.liveMembership;

  /**
   * Attribution through membership history: a recorded group wins; otherwise
   * the membership effective at the event's observation time resolves events
   * recorded before any membership existed (grouping runs after ingestion)
   * without reattributing them after a later correction moved the item.
   */
  const attribution = (row: EventRow): string | null => {
    if (row.group_id) return row.group_id;
    const effective = sqlite
      .query<{ group_id: string }, [string, number, number]>(
        `SELECT group_id FROM story_memberships WHERE item_id=? AND started_at<=?
         AND (ended_at IS NULL OR ended_at>?) ORDER BY started_at DESC LIMIT 1`,
      )
      .get(row.item_id, row.observed_at, row.observed_at)?.group_id;
    return effective ?? liveMembership.get(row.item_id) ?? null;
  };

  const conditions: string[] = [
    `item_id IN (${itemIds.map(() => "?").join(",")})`,
  ];
  const params: (string | number)[] = [...itemIds];
  if (scopedGroup !== undefined) {
    conditions.push("(group_id IS NULL OR group_id=?)");
    params.push(scopedGroup);
  }
  if (query.since !== undefined) {
    conditions.push("observed_at>=?");
    params.push(query.since);
  }
  if (query.until !== undefined) {
    conditions.push("observed_at<?");
    params.push(query.until);
  }
  const where = conditions.map((condition) => `(${condition})`).join(" AND ");

  const rows = sqlite
    .query<EventRow, (string | number)[]>(
      `SELECT * FROM story_change_events WHERE ${where}
       ORDER BY observed_at DESC,id DESC LIMIT ?`,
    )
    .all(...params, limit + 1);

  const itemCitation = (itemId: string): ChangeCitation | null => {
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
      versionId: null,
    };
  };

  /** Detail state of one exact recorded version, or of the item's content. */
  const detail = (itemId: string, versionId: number | null) => {
    if (versionId !== null) {
      const version = sqlite
        .query<{ purged_at: number | null; text: string }, [number]>(
          "SELECT purged_at,text FROM content_versions WHERE id=?",
        )
        .get(versionId);
      if (!version)
        return { detailAvailable: false, reason: "version_unavailable" };
      if (version.text !== "" && version.purged_at === null)
        return { detailAvailable: true, reason: null as string | null };
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
    }
    // Item-level fallback for grouping-only events (no recorded version).
    const retained =
      sqlite
        .query<{ n: number }, [string]>(
          "SELECT EXISTS(SELECT 1 FROM content_versions WHERE item_id=? AND purged_at IS NULL AND text<>'') AS n",
        )
        .get(itemId)!.n > 0;
    if (retained)
      return { detailAvailable: true, reason: null as string | null };
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
    // For development-scoped reads, an unattributed event only belongs to the
    // queried development when its resolved attribution is that group; this
    // keeps a regrouped item's earlier NULL-group events out of the new
    // development's answer.
    if (scopedGroup !== undefined && attribution(row) !== scopedGroup) continue;
    const versionState =
      row.version_id !== null
        ? (sqlite
            .query<
              { item_id: string; title: string; url: string | null },
              [number]
            >("SELECT item_id,title,url FROM content_versions WHERE id=?")
            .get(row.version_id) ?? null)
        : null;
    const item: ChangeCitation | null = versionState
      ? {
          // Version-bound citation: the title/URL exactly as observed, immune
          // to later edits of the mutable canonical item.
          itemId: versionState.item_id,
          title: versionState.title,
          url: versionState.url,
          sourceId: row.source_id,
          nativeId: row.native_id,
          sourceTitle: row.source_id
            ? (sqlite
                .query<{ title: string }, [string]>(
                  "SELECT title FROM sources WHERE id=?",
                )
                .get(row.source_id)?.title ?? null)
            : null,
          versionId: row.version_id,
        }
      : itemCitation(row.item_id);
    if (!item) continue;
    const state = detail(row.item_id, row.version_id);
    const membership = scopedGroup
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
          .get(row.item_id, scopedGroup) ?? null)
      : null;
    const resolvedGroupId = attribution(row);
    events.push({
      id: row.id,
      kind: row.kind,
      item,
      reportedAt: row.reported_at,
      eventAt: row.event_at,
      observedAt: row.observed_at,
      development: resolvedGroupId
        ? {
            groupId: resolvedGroupId,
            current: liveMembership.get(row.item_id) === resolvedGroupId,
          }
        : null,
      detailAvailable: state.detailAvailable,
      detailUnavailableReason: state.reason,
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

  const scoped = scopedGroup !== undefined;
  const currentMembers = (
    scoped
      ? itemIds.filter((id) => liveMembership.get(id) === scopedGroup)
      : itemIds
  )
    .map(itemCitation)
    .filter((entry): entry is ChangeCitation => entry !== null);
  // Changed-member classification is independent of the display limit: it
  // scans all matching content-change rows in the window (bounded), so a
  // truncated page can never move a genuinely changed member into the
  // unchanged list.
  const changedConditions: string[] = [
    `item_id IN (${itemIds.map(() => "?").join(",")})`,
    // Development-scoped reads also count grouping corrections as attributable
    // evidence: a member that moved into this development carries the
    // membership_assigned event, so it is not reported as an unchanged member
    // with no evidence (review finding 5). Item-scoped reads still count only
    // content changes.
    scoped
      ? "(kind='content_change' OR kind='grouping_corrected')"
      : "kind='content_change'",
  ];
  const changedParams: (string | number)[] = [...itemIds];
  if (scoped) {
    changedConditions.push("group_id=?");
    changedParams.push(scopedGroup!);
  }
  if (query.since !== undefined) {
    changedConditions.push("observed_at>=?");
    changedParams.push(query.since);
  }
  if (query.until !== undefined) {
    changedConditions.push("observed_at<?");
    changedParams.push(query.until);
  }
  const changedItems = new Set(
    sqlite
      .query<{ item_id: string }, (string | number)[]>(
        `SELECT DISTINCT item_id FROM story_change_events WHERE ${changedConditions.map((condition) => `(${condition})`).join(" AND ")} LIMIT ?`,
      )
      .all(...changedParams, MEMBER_QUERY_CAP)
      .map((row) => row.item_id),
  );
  return {
    groupId: scopedGroup ?? liveMembership.get(itemIds[0]!) ?? null,
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
