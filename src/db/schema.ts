import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
export const sources = sqliteTable("sources", {
  id: text().primaryKey(),
  kind: text().notNull().default("rss"),
  url: text().notNull().unique(),
  title: text().notNull(),
  enabled: integer().notNull().default(1),
  pollSeconds: integer("poll_seconds").notNull().default(1800),
  nextPoll: integer("next_poll").notNull().default(0),
  failures: integer().notNull().default(0),
  lastError: text("last_error"),
  lastSuccess: integer("last_success"),
  removed: integer().notNull().default(0),
  maxEntries: integer("max_entries").notNull().default(1000),
  maxBytes: integer("max_bytes").notNull().default(5000000),
});
export const sourceState = sqliteTable("source_state", {
  sourceId: text("source_id")
    .primaryKey()
    .references(() => sources.id),
  etag: text(),
  lastModified: text("last_modified"),
  cursor: text(),
  lastChecked: integer("last_checked"),
  entryCount: integer("entry_count"),
  truncated: integer(),
});
export const contentVersions = sqliteTable(
  "content_versions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    nativeId: text("native_id").notNull(),
    url: text(),
    title: text().notNull(),
    text: text().notNull(),
    observedAt: integer("observed_at").notNull(),
    backfilled: integer().notNull().default(0),
  },
  (t) => [
    index("content_versions_source_native").on(t.sourceId, t.nativeId, t.id),
    index("content_versions_item").on(t.itemId, t.id),
  ],
);
export const itemUrlAliases = sqliteTable(
  "item_url_aliases",
  {
    canonicalUrl: text("canonical_url").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
  },
  (t) => [index("item_url_aliases_item").on(t.itemId)],
);
export const itemRedirects = sqliteTable(
  "item_redirects",
  {
    oldId: text("old_id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
  },
  (t) => [index("item_redirects_item").on(t.itemId)],
);
export const items = sqliteTable("items", {
  id: text().primaryKey(),
  identity: text().notNull().unique(),
  url: text(),
  title: text().notNull(),
  publishedAt: integer("published_at"),
  ingestedAt: integer("ingested_at").notNull(),
  status: text().notNull().default("ingested"),
});
/** Indexed activity cursor for bounded digest intake, independent of rescoring. */
export const digestActivity = sqliteTable(
  "digest_activity",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => items.id, { onDelete: "cascade" }),
    activityAt: integer("activity_at").notNull(),
  },
  (t) => [index("digest_activity_time").on(t.activityAt, t.itemId)],
);
/** Append-only activity facts used to reconstruct digest intake after downtime. */
export const digestActivityEvents = sqliteTable(
  "digest_activity_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    relatedItemId: text("related_item_id"),
    activityAt: integer("activity_at").notNull(),
    kind: text().notNull(),
  },
  (t) => [index("digest_activity_events_time").on(t.activityAt, t.itemId)],
);
/** Earliest point at which complete activity evidence is guaranteed. */
export const digestHistoryState = sqliteTable("digest_history_state", {
  id: integer().primaryKey(),
  evidenceFrom: integer("evidence_from").notNull(),
});
export const itemSources = sqliteTable(
  "item_sources",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    nativeId: text("native_id").notNull(),
    url: text(),
    parentItemId: text("parent_item_id").references(() => items.id),
  },
  (t) => [
    uniqueIndex("source_native_unique").on(t.sourceId, t.nativeId),
    index("item_sources_item").on(t.itemId, t.sourceId, t.nativeId),
  ],
);
export const content = sqliteTable("content", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => items.id),
  text: text().notNull(),
  format: text().notNull().default("feed-text"),
});
export const jobs = sqliteTable(
  "jobs",
  {
    id: text().primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    availableAt: integer("available_at").notNull(),
    leaseUntil: integer("lease_until"),
    leaseToken: text("lease_token"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    uniqueIndex("one_active_poll")
      .on(t.sourceId)
      .where(sql`status IN ('pending','running')`),
  ],
);

export const processingJobs = sqliteTable(
  "processing_jobs",
  {
    id: text().primaryKey(),
    stage: text().notNull(),
    generation: integer().notNull().default(1),
    originSourceId: text("origin_source_id").references(() => sources.id),
    originUrl: text("origin_url"),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    availableAt: integer("available_at").notNull(),
    leaseUntil: integer("lease_until"),
    leaseToken: text("lease_token"),
    lastError: text("last_error"),
    result: text(),
    outcome: text(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("processing_stage_item_unique").on(
      t.stage,
      t.itemId,
      t.generation,
    ),
    index("processing_lease_idx").on(t.status, t.leaseUntil),
    index("processing_due_idx").on(
      t.stage,
      t.status,
      t.availableAt,
      t.createdAt,
    ),
    index("processing_stage_cursor_idx").on(t.stage, t.id),
  ],
);

export const profiles = sqliteTable(
  "profiles",
  {
    kind: text().notNull(),
    id: text().notNull(),
    version: integer().notNull(),
    document: text().notNull(),
  },
  (t) => [uniqueIndex("profile_version_unique").on(t.kind, t.id, t.version)],
);

export const analyses = sqliteTable(
  "analyses",
  {
    id: text().primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    generation: integer().notNull(),
    inputHash: text("input_hash").notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    promptVersion: text("prompt_version").notNull(),
    profiles: text().notNull(),
    result: text().notNull(),
    usage: text(),
    cost: integer(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("analysis_identity").on(
      t.itemId,
      t.generation,
      t.inputHash,
      t.provider,
      t.model,
      t.promptVersion,
      t.profiles,
    ),
  ],
);

export const analysisReservations = sqliteTable("analysis_reservations", {
  key: text().primaryKey(),
  tokens: integer().notNull(),
  micros: integer().notNull(),
  status: text().notNull(),
  result: text(),
});
export const analysisControl = sqliteTable("analysis_control", {
  id: integer().primaryKey(),
  envelopeBreach: integer("envelope_breach").notNull().default(0),
});

/** Immutable, reproducible scoring runs; a new input creates a new row. */
export const itemScores = sqliteTable(
  "item_scores",
  {
    id: text().primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    generation: integer().notNull(),
    inputHash: text("input_hash").notNull(),
    criteriaVersion: text("criteria_version").notNull(),
    provenance: text().notNull(),
    result: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("item_score_identity").on(t.itemId, t.generation, t.inputHash),
    index("item_scores_item").on(t.itemId, t.createdAt),
  ],
);

export const scoreRefresh = sqliteTable(
  "score_refresh",
  {
    jobId: text("job_id")
      .primaryKey()
      .references(() => processingJobs.id),
    criteriaVersion: text("criteria_version").notNull(),
    dueAt: integer("due_at"),
  },
  (t) => [
    index("score_refresh_due").on(t.dueAt),
    index("score_refresh_criteria").on(t.criteriaVersion),
  ],
);

export const scoreInvalidation = sqliteTable("score_invalidation", {
  id: integer().primaryKey(),
  cursor: text(),
  pending: integer().notNull().default(0),
  generation: integer().notNull().default(0),
  passGeneration: integer("pass_generation").notNull().default(0),
});

/** Time-indexed proof of which score was valid and when it became stale. */
export const scoreValidityEvents = sqliteTable(
  "score_validity_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    itemId: text("item_id"),
    scoreId: text("score_id"),
    kind: text().notNull(),
    eventAt: integer("event_at").notNull(),
    validUntil: integer("valid_until"),
  },
  (t) => [
    index("score_validity_item_time").on(t.itemId, t.eventAt),
    index("score_validity_score").on(t.scoreId, t.eventAt),
    index("score_validity_global_time").on(t.kind, t.eventAt),
    index("score_validity_time").on(t.eventAt),
  ],
);

/** Development groups never replace items or original citations. */
export const storyGroups = sqliteTable("story_groups", {
  id: text().primaryKey(),
  firstSeen: integer("first_seen").notNull(),
  retiredAt: integer("retired_at"),
});
export const storyMemberships = sqliteTable(
  "story_memberships",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    groupId: text("group_id")
      .notNull()
      .references(() => storyGroups.id),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    originalItemId: text("original_item_id"),
    evidence: text().notNull(),
    ruleVersion: text("rule_version").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [
    uniqueIndex("story_current_member")
      .on(t.itemId)
      .where(sql`ended_at IS NULL`),
    index("story_members_by_item").on(t.itemId),
    index("story_members_group").on(t.groupId, t.endedAt),
  ],
);
export const storyRelations = sqliteTable(
  "story_relations",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    olderGroupId: text("older_group_id")
      .notNull()
      .references(() => storyGroups.id),
    newerGroupId: text("newer_group_id")
      .notNull()
      .references(() => storyGroups.id),
    reason: text().notNull(),
    evidence: text().notNull(),
    ruleVersion: text("rule_version").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [
    uniqueIndex("story_current_relation")
      .on(t.olderGroupId, t.newerGroupId)
      .where(sql`ended_at IS NULL`),
    index("story_relation_by_newer").on(t.newerGroupId, t.endedAt, t.id),
  ],
);
export const storyGroupingState = sqliteTable("story_grouping_state", {
  id: integer().primaryKey(),
  fingerprint: text().notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const storyGroupingEvents = sqliteTable(
  "story_grouping_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    state: text().notNull(),
    eventAt: integer("event_at").notNull(),
  },
  (t) => [index("story_grouping_events_time").on(t.eventAt, t.id)],
);

/** Frozen content is historical evidence, not proof of delivery. */
export const digests = sqliteTable("digests", {
  id: text().primaryKey(),
  editionDate: text("edition_date").notNull().unique(),
  timezone: text().notNull(),
  subject: text().notNull(),
  html: text().notNull(),
  plainText: text("plain_text").notNull(),
  decisions: text().notNull(),
  fingerprint: text().notNull(),
  frozenAt: integer("frozen_at").notNull(),
  sealed: integer().notNull().default(0),
});

/** IDs and evidence are snapshots, retained across canonical item merges. */
export const digestItems = sqliteTable(
  "digest_items",
  {
    digestId: text("digest_id")
      .notNull()
      .references(() => digests.id),
    position: integer().notNull(),
    itemId: text("item_id").notNull(),
    groupId: text("group_id"),
    scoreId: text("score_id"),
    snapshot: text().notNull(),
  },
  (t) => [
    uniqueIndex("digest_item_position").on(t.digestId, t.position),
    uniqueIndex("digest_item_identity").on(t.digestId, t.itemId),
    index("digest_item_by_item").on(t.itemId, t.digestId),
    index("digest_item_by_group").on(t.groupId, t.digestId, t.position),
  ],
);

/** An immutable outbound envelope and fenced provider acceptance state. */
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text().primaryKey(),
    digestId: text("digest_id")
      .notNull()
      .references(() => digests.id),
    editionDate: text("edition_date").notNull(),
    recipient: text().notNull(),
    sender: text().notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    availableAt: integer("available_at").notNull(),
    firstAttemptAt: integer("first_attempt_at"),
    leaseUntil: integer("lease_until"),
    leaseToken: text("lease_token"),
    providerId: text("provider_id"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("delivery_edition_recipient").on(t.editionDate, t.recipient),
    index("delivery_by_digest").on(t.digestId),
    index("delivery_due").on(t.status, t.availableAt, t.leaseUntil),
  ],
);

export const publicationScheduleState = sqliteTable(
  "publication_schedule_state",
  {
    id: integer().primaryKey(),
    nextDate: text("next_date").notNull(),
    timezone: text().notNull(),
    hour: integer().notNull(),
    minute: integer().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);
export const publicationScheduleHistory = sqliteTable(
  "publication_schedule_history",
  {
    date: text().primaryKey(),
    dueAt: integer("due_at"),
    status: text().notNull(),
    details: text(),
    recordedAt: integer("recorded_at").notNull(),
  },
);

/** Provider message identity and its independently leased body retrieval. */
export const inboundMessages = sqliteTable(
  "inbound_messages",
  {
    id: text().primaryKey(),
    provider: text().notNull(),
    providerId: text("provider_id").notNull(),
    receivedAt: integer("received_at").notNull(),
    metadata: text().notNull(),
    body: text(),
    itemId: text("item_id").references(() => items.id),
    indexDiagnostics: text("index_diagnostics"),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    availableAt: integer("available_at").notNull(),
    leaseUntil: integer("lease_until"),
    leaseToken: text("lease_token"),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("inbound_message_identity").on(t.provider, t.providerId),
    index("inbound_message_due").on(t.status, t.availableAt, t.id),
    index("inbound_message_lease").on(t.status, t.leaseUntil),
    index("inbound_message_index_due").on(t.status, t.itemId, t.id),
  ],
);

export const inboundEvents = sqliteTable(
  "inbound_events",
  {
    id: text().primaryKey(),
    provider: text().notNull(),
    eventId: text("event_id").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => inboundMessages.id),
    receivedAt: integer("received_at").notNull(),
    metadata: text().notNull(),
  },
  (t) => [uniqueIndex("inbound_event_identity").on(t.provider, t.eventId)],
);

/** One fenced reconciliation cursor per provider/inbox; state is opaque to persistence. */
export const inboundReconciliation = sqliteTable(
  "inbound_reconciliation",
  {
    key: text().primaryKey(),
    state: text().notNull(),
    availableAt: integer("available_at").notNull(),
    leaseUntil: integer("lease_until"),
    leaseToken: text("lease_token"),
    attempts: integer().notNull().default(0),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("inbound_reconciliation_due").on(t.availableAt, t.leaseUntil)],
);

/** Search observations and reservations survive restarts and uncertain provider outcomes. */
export const discoveryRuns = sqliteTable(
  "discovery_runs",
  {
    id: text().primaryKey(),
    query: text().notNull(),
    provider: text().notNull(),
    providerVersion: text("provider_version").notNull(),
    subscriptionSnapshot: text("subscription_snapshot").notNull(),
    status: text().notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    lastError: text("last_error"),
    queryKind: text("query_kind").notNull().default("manual"),
    scheduleKey: text("schedule_key"),
    interestLineage: text("interest_lineage").notNull().default("[]"),
  },
  (t) => [
    index("discovery_runs_schedule_started").on(t.scheduleKey, t.startedAt),
    index("discovery_runs_started").on(t.startedAt),
  ],
);

export const discoveryPages = sqliteTable(
  "discovery_pages",
  {
    id: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => discoveryRuns.id),
    cursor: text(),
    nextCursor: text("next_cursor"),
    budgetDay: integer("budget_day").notNull(),
    reservedResults: integer("reserved_results").notNull(),
    reservedCostMicros: integer("reserved_cost_micros").notNull(),
    actualCostMicros: integer("actual_cost_micros"),
    usage: text(),
    status: text().notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    latencyMs: integer("latency_ms"),
    lastError: text("last_error"),
  },
  (t) => [
    index("discovery_pages_day").on(t.budgetDay),
    index("discovery_pages_run").on(t.runId),
    index("discovery_pages_status_finished").on(t.status, t.finishedAt),
    index("discovery_pages_finished").on(t.finishedAt),
  ],
);

export const discoveryResults = sqliteTable(
  "discovery_results",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    pageId: text("page_id")
      .notNull()
      .references(() => discoveryPages.id),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    url: text().notNull(),
    title: text().notNull(),
    snippet: text().notNull(),
    publishedAt: integer("published_at"),
    observedAt: integer("observed_at"),
    origin: text().notNull(),
  },
  (t) => [
    index("discovery_results_item").on(t.itemId),
    index("discovery_results_page").on(t.pageId),
  ],
);

export const discoveryResultFeedback = sqliteTable(
  "discovery_result_feedback",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    resultId: integer("result_id")
      .notNull()
      .references(() => discoveryResults.id),
    useful: integer().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("discovery_result_feedback_result").on(t.resultId, t.createdAt),
  ],
);

/** Durable schedule and explicit utility signals for profile-driven discovery. */
export const discoveryQueryState = sqliteTable("discovery_query_state", {
  queryKey: text("query_key").primaryKey(),
  query: text().notNull(),
  kind: text().notNull(),
  interestId: text("interest_id"),
  interestVersion: integer("interest_version"),
  priority: integer().notNull(),
  negativeTerms: text("negative_terms").notNull(),
  interestLineage: text("interest_lineage").notNull().default("[]"),
  enabled: integer().notNull().default(1),
  nextDueAt: integer("next_due_at").notNull(),
  lastRunAt: integer("last_run_at"),
  lastRunId: text("last_run_id"),
});
export const discoveryQueryFeedback = sqliteTable(
  "discovery_query_feedback",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    queryKey: text("query_key").notNull(),
    useful: integer().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("discovery_query_feedback_key").on(t.queryKey, t.createdAt)],
);
/**
 * Idempotent manual/bookmark/email submissions. The submission ID is the
 * caller's idempotency key; the item ID is the canonical item it resolved to.
 * Metadata keeps Reddit provenance and retrieval limitations without
 * pretending unavailable content was fetched.
 */
export const manualSubmissions = sqliteTable(
  "manual_submissions",
  {
    id: text().primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    url: text().notNull(),
    origin: text().notNull(),
    title: text().notNull(),
    snippet: text().notNull().default(""),
    metadata: text().notNull().default("{}"),
    submittedAt: integer("submitted_at").notNull(),
  },
  (t) => [
    index("manual_submissions_item").on(t.itemId),
    index("manual_submissions_url").on(t.url),
  ],
);

/**
 * Payload-bound, expiring approvals for consequential MCP mutations. The
 * digest binds the exact normalized payload, so a token issued for one change
 * can never authorize a different one.
 */
export const mutationConfirmations = sqliteTable(
  "mutation_confirmations",
  {
    id: text().primaryKey(),
    action: text().notNull(),
    payloadHash: text("payload_hash").notNull(),
    preview: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("mutation_confirmations_expiry").on(t.expiresAt)],
);

/**
 * Narrowly scoped digest feedback tokens. A token authorizes one feedback
 * action on one dated edition; it is not an MCP credential and cannot mutate
 * sources or trigger spending. `nonce` satisfies the unique link constraint
 * that exempts link-prefetching scanners from one-click unsubscribe rules.
 */
export const digestFeedbackTokens = sqliteTable(
  "digest_feedback_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    digestId: text("digest_id").notNull(),
    editionDate: text("edition_date").notNull(),
    itemId: text("item_id").notNull(),
    action: text().notNull(),
    nonce: text().notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("digest_feedback_nonce").on(t.nonce),
    index("digest_feedback_item").on(t.editionDate, t.itemId),
  ],
);

/**
 * Explicit feedback events. Item feedback may later be attributed to the
 * edition that prompted it; `itemId` is a historical reference and survives
 * canonical item merges. Missing clicks and unread material are never events.
 */
export const itemFeedback = sqliteTable(
  "item_feedback",
  {
    id: text().primaryKey(),
    itemId: text("item_id").notNull(),
    useful: integer().notNull(),
    source: text().notNull(),
    editionDate: text("edition_date"),
    digestId: text("digest_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("item_feedback_item").on(t.itemId, t.createdAt)],
);
