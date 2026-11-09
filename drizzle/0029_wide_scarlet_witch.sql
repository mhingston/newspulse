CREATE TABLE `digest_items` (
	`digest_id` text NOT NULL,
	`position` integer NOT NULL,
	`item_id` text NOT NULL,
	`group_id` text,
	`score_id` text,
	`snapshot` text NOT NULL,
	FOREIGN KEY (`digest_id`) REFERENCES `digests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_item_position` ON `digest_items` (`digest_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `digest_item_identity` ON `digest_items` (`digest_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `digests` (
	`id` text PRIMARY KEY NOT NULL,
	`edition_date` text NOT NULL,
	`timezone` text NOT NULL,
	`subject` text NOT NULL,
	`html` text NOT NULL,
	`plain_text` text NOT NULL,
	`decisions` text NOT NULL,
	`fingerprint` text NOT NULL,
	`frozen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digests_edition_date_unique` ON `digests` (`edition_date`);