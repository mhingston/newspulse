CREATE TABLE `discovery_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`cursor` text,
	`next_cursor` text,
	`budget_day` integer NOT NULL,
	`reserved_results` integer NOT NULL,
	`reserved_cost_micros` integer NOT NULL,
	`actual_cost_micros` integer,
	`usage` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`latency_ms` integer,
	`last_error` text,
	FOREIGN KEY (`run_id`) REFERENCES `discovery_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `discovery_pages_day` ON `discovery_pages` (`budget_day`);--> statement-breakpoint
CREATE INDEX `discovery_pages_run` ON `discovery_pages` (`run_id`);--> statement-breakpoint
CREATE INDEX `discovery_pages_status_finished` ON `discovery_pages` (`status`,`finished_at`);--> statement-breakpoint
CREATE INDEX `discovery_pages_finished` ON `discovery_pages` (`finished_at`);--> statement-breakpoint
CREATE TABLE `discovery_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`page_id` text NOT NULL,
	`item_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`snippet` text NOT NULL,
	`published_at` integer,
	`observed_at` integer,
	`origin` text NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `discovery_pages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `discovery_results_item` ON `discovery_results` (`item_id`);--> statement-breakpoint
CREATE INDEX `discovery_results_page` ON `discovery_results` (`page_id`);--> statement-breakpoint
CREATE TABLE `discovery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`query` text NOT NULL,
	`provider` text NOT NULL,
	`provider_version` text NOT NULL,
	`subscription_snapshot` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`last_error` text
);
