CREATE TABLE `source_suggestion_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`suggestion_id` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`suggestion_id`) REFERENCES `source_suggestions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `source_suggestion_events_suggestion` ON `source_suggestion_events` (`suggestion_id`,`id`);--> statement-breakpoint
CREATE TABLE `source_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'domain' NOT NULL,
	`domain` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`score` integer NOT NULL,
	`state` text DEFAULT 'proposed' NOT NULL,
	`explanation` text NOT NULL,
	`accepted_source_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_suggestions_state` ON `source_suggestions` (`state`,`id`);