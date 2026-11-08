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
});
export const sourceState = sqliteTable("source_state", {
  sourceId: text("source_id")
    .primaryKey()
    .references(() => sources.id),
  etag: text(),
  lastModified: text("last_modified"),
  cursor: text(),
  lastChecked: integer("last_checked"),
});
export const items = sqliteTable("items", {
  id: text().primaryKey(),
  identity: text().notNull().unique(),
  url: text(),
  title: text().notNull(),
  publishedAt: integer("published_at"),
  ingestedAt: integer("ingested_at").notNull(),
  status: text().notNull().default("ingested"),
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
  (t) => [uniqueIndex("source_native_unique").on(t.sourceId, t.nativeId)],
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
