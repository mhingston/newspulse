CREATE TABLE `score_refresh` (
	`job_id` text PRIMARY KEY NOT NULL,
	`criteria_version` text NOT NULL,
	`due_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `processing_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `score_refresh_due` ON `score_refresh` (`due_at`);--> statement-breakpoint
CREATE INDEX `score_refresh_criteria` ON `score_refresh` (`criteria_version`);
--> statement-breakpoint
INSERT INTO score_refresh(job_id,criteria_version,due_at)
SELECT id,'',0 FROM processing_jobs WHERE stage='score' AND status='done';
