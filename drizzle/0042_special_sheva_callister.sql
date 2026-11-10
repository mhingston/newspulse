CREATE TABLE `discovery_result_feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`result_id` integer NOT NULL,
	`useful` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`result_id`) REFERENCES `discovery_results`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `discovery_result_feedback_result` ON `discovery_result_feedback` (`result_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `discovery_query_state` ADD `interest_lineage` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `discovery_runs` ADD `query_kind` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `discovery_runs` ADD `schedule_key` text;--> statement-breakpoint
ALTER TABLE `discovery_runs` ADD `interest_lineage` text DEFAULT '[]' NOT NULL;
