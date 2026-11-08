CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`generation` integer NOT NULL,
	`input_hash` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`profiles` text NOT NULL,
	`result` text NOT NULL,
	`usage` text,
	`cost` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_identity` ON `analyses` (`item_id`,`generation`,`input_hash`,`provider`,`model`,`prompt_version`,`profiles`);