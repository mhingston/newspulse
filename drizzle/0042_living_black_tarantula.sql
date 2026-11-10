CREATE TABLE `discovery_query_feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query_key` text NOT NULL,
	`useful` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `discovery_query_feedback_key` ON `discovery_query_feedback` (`query_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `discovery_query_state` (
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
CREATE TABLE `discovery_result_feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`result_id` integer NOT NULL,
	`useful` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`result_id`) REFERENCES `discovery_results`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `discovery_result_feedback_result` ON `discovery_result_feedback` (`result_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `discovery_runs` ADD `query_kind` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `discovery_runs` ADD `schedule_key` text;--> statement-breakpoint
ALTER TABLE `discovery_runs` ADD `interest_lineage` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `discovery_runs_schedule_started` ON `discovery_runs` (`schedule_key`,`started_at`);--> statement-breakpoint
CREATE INDEX `discovery_runs_started` ON `discovery_runs` (`started_at`);