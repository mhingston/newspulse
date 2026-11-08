CREATE TABLE `processing_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`stage` text NOT NULL,
	`item_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`lease_until` integer,
	`lease_token` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processing_stage_item_unique` ON `processing_jobs` (`stage`,`item_id`);