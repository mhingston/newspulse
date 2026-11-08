CREATE TABLE `content_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`source_id` text NOT NULL,
	`native_id` text NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `source_state` ADD `entry_count` integer;--> statement-breakpoint
ALTER TABLE `source_state` ADD `truncated` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `removed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `max_entries` integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `max_bytes` integer DEFAULT 5000000 NOT NULL;--> statement-breakpoint
INSERT INTO content_versions(item_id,source_id,native_id,title,text,observed_at)
SELECT i.id,r.source_id,r.native_id,i.title,c.text,i.ingested_at FROM items i JOIN content c ON c.item_id=i.id JOIN item_sources r ON r.item_id=i.id;
