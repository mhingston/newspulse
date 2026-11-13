CREATE TABLE `retention_purges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`generation` integer NOT NULL,
	`class` text NOT NULL,
	`purged_at` integer NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retention_purge_identity` ON `retention_purges` (`item_id`,`generation`,`class`);--> statement-breakpoint
CREATE INDEX `retention_purge_time` ON `retention_purges` (`purged_at`);