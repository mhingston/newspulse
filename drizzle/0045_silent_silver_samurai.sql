CREATE TABLE `digest_feedback_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`digest_id` text NOT NULL,
	`edition_date` text NOT NULL,
	`item_id` text NOT NULL,
	`action` text NOT NULL,
	`nonce` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_feedback_nonce` ON `digest_feedback_tokens` (`nonce`);--> statement-breakpoint
CREATE INDEX `digest_feedback_item` ON `digest_feedback_tokens` (`edition_date`,`item_id`);--> statement-breakpoint
CREATE TABLE `item_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`useful` integer NOT NULL,
	`source` text NOT NULL,
	`edition_date` text,
	`digest_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `item_feedback_item` ON `item_feedback` (`item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mutation_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`payload_hash` text NOT NULL,
	`preview` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mutation_confirmations_expiry` ON `mutation_confirmations` (`expires_at`);