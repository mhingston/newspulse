CREATE TABLE `score_invalidation` (
	`id` integer PRIMARY KEY NOT NULL,
	`cursor` text,
	`pending` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `processing_stage_cursor_idx` ON `processing_jobs` (`stage`,`id`);