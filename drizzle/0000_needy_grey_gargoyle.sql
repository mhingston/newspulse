CREATE TABLE `content` (
	`item_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`format` text DEFAULT 'feed-text' NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `item_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`source_id` text NOT NULL,
	`native_id` text NOT NULL,
	`url` text,
	`parent_item_id` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_native_unique` ON `item_sources` (`source_id`,`native_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`identity` text NOT NULL,
	`url` text,
	`title` text NOT NULL,
	`published_at` integer,
	`ingested_at` integer NOT NULL,
	`status` text DEFAULT 'ingested' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_identity_unique` ON `items` (`identity`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`lease_until` integer,
	`lease_token` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_poll` ON `jobs` (`source_id`) WHERE status IN ('pending','running');--> statement-breakpoint
CREATE TABLE `source_state` (
	`source_id` text PRIMARY KEY NOT NULL,
	`etag` text,
	`last_modified` text,
	`last_checked` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'rss' NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`poll_seconds` integer DEFAULT 1800 NOT NULL,
	`next_poll` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_success` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_url_unique` ON `sources` (`url`);