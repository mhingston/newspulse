CREATE TABLE `story_change_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`group_id` text,
	`kind` text NOT NULL,
	`source_id` text,
	`native_id` text,
	`reported_at` integer,
	`event_at` integer,
	`observed_at` integer NOT NULL,
	`evidence` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `story_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `story_change_events_group` ON `story_change_events` (`group_id`,`observed_at`,`id`);--> statement-breakpoint
CREATE INDEX `story_change_events_item` ON `story_change_events` (`item_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `story_change_events_recent` ON `story_change_events` (`observed_at`,`id`);