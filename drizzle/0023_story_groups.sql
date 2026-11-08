CREATE TABLE story_groups (
  id text PRIMARY KEY NOT NULL,
  first_seen integer NOT NULL,
  retired_at integer
);
--> statement-breakpoint
CREATE TABLE story_memberships (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  group_id text NOT NULL REFERENCES story_groups(id),
  item_id text NOT NULL REFERENCES items(id),
  original_item_id text,
  evidence text NOT NULL,
  rule_version text NOT NULL,
  started_at integer NOT NULL,
  ended_at integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX story_current_member ON story_memberships (item_id) WHERE ended_at IS NULL;
--> statement-breakpoint
CREATE INDEX story_members_group ON story_memberships (group_id,ended_at);
--> statement-breakpoint
CREATE TABLE story_relations (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  older_group_id text NOT NULL REFERENCES story_groups(id),
  newer_group_id text NOT NULL REFERENCES story_groups(id),
  reason text NOT NULL,
  evidence text NOT NULL,
  rule_version text NOT NULL,
  started_at integer NOT NULL,
  ended_at integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX story_current_relation ON story_relations (older_group_id,newer_group_id) WHERE ended_at IS NULL;
--> statement-breakpoint
CREATE TABLE story_grouping_state (
  id integer PRIMARY KEY NOT NULL,
  fingerprint text NOT NULL,
  updated_at integer NOT NULL
);
