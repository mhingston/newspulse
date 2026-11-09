CREATE TABLE `item_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`generation` integer NOT NULL,
	`input_hash` text NOT NULL,
	`criteria_version` text NOT NULL,
	`provenance` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_score_identity` ON `item_scores` (`item_id`,`generation`,`input_hash`);--> statement-breakpoint
CREATE INDEX `item_scores_item` ON `item_scores` (`item_id`,`created_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO processing_jobs(id,stage,item_id,generation,available_at,created_at)
SELECT lower(hex(randomblob(16))), 'score', e.item_id, e.generation, 0, 0
FROM processing_jobs e WHERE e.stage='extract' AND e.status='done'
AND e.generation=(SELECT max(x.generation) FROM processing_jobs x WHERE x.item_id=e.item_id AND x.stage='extract');
--> statement-breakpoint
UPDATE processing_jobs SET status='pending',attempts=0,available_at=0,lease_token=NULL,lease_until=NULL
WHERE stage='score' AND generation=(SELECT max(e.generation) FROM processing_jobs e WHERE e.item_id=processing_jobs.item_id AND e.stage='extract');
