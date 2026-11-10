CREATE TABLE `manual_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`url` text NOT NULL,
	`origin` text NOT NULL,
	`title` text NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`submitted_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `manual_submissions_item` ON `manual_submissions` (`item_id`);--> statement-breakpoint
CREATE INDEX `manual_submissions_url` ON `manual_submissions` (`url`);