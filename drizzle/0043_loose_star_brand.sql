PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_discovery_query_state` (
	`query_key` text PRIMARY KEY NOT NULL,
	`query` text NOT NULL,
	`kind` text NOT NULL,
	`interest_id` text,
	`interest_version` integer,
	`priority` integer NOT NULL,
	`negative_terms` text NOT NULL,
	`interest_lineage` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`next_due_at` integer NOT NULL,
	`last_run_at` integer,
	`last_run_id` text
);
--> statement-breakpoint
INSERT INTO `__new_discovery_query_state`("query_key", "query", "kind", "interest_id", "interest_version", "priority", "negative_terms", "interest_lineage", "enabled", "next_due_at", "last_run_at", "last_run_id") SELECT "query_key", "query", "kind", "interest_id", "interest_version", "priority", "negative_terms", "interest_lineage", "enabled", "next_due_at", "last_run_at", "last_run_id" FROM `discovery_query_state`;--> statement-breakpoint
DROP TABLE `discovery_query_state`;--> statement-breakpoint
ALTER TABLE `__new_discovery_query_state` RENAME TO `discovery_query_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;