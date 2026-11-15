CREATE TABLE `alert_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_event_id` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alert_suppressions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`change_event_id` integer NOT NULL,
	`reason` text NOT NULL,
	`local_date` text NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`change_event_id`) REFERENCES `story_change_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_suppression_identity` ON `alert_suppressions` (`change_event_id`,`reason`,`local_date`);--> statement-breakpoint
CREATE INDEX `alert_suppression_time` ON `alert_suppressions` (`created_at`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`change_event_id` integer NOT NULL,
	`kind` text NOT NULL,
	`item_id` text NOT NULL,
	`group_id` text,
	`local_date` text NOT NULL,
	`subject` text NOT NULL,
	`html` text NOT NULL,
	`plain_text` text NOT NULL,
	`decision` text NOT NULL,
	`fingerprint` text NOT NULL,
	`score_id` text,
	`frozen_at` integer NOT NULL,
	`sealed` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`change_event_id`) REFERENCES `story_change_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `story_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_change_event` ON `alerts` (`change_event_id`);--> statement-breakpoint
CREATE INDEX `alert_local_date` ON `alerts` (`local_date`,`frozen_at`);--> statement-breakpoint
CREATE INDEX `alert_group` ON `alerts` (`group_id`,`frozen_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`digest_id` text,
	`alert_id` text,
	`edition_date` text NOT NULL,
	`recipient` text NOT NULL,
	`sender` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`first_attempt_at` integer,
	`lease_until` integer,
	`lease_token` text,
	`provider_id` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
CHECK (((`digest_id` IS NULL) + (`alert_id` IS NULL)) = 1),
	FOREIGN KEY (`digest_id`) REFERENCES `digests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_deliveries`("id", "digest_id", "alert_id", "edition_date", "recipient", "sender", "idempotency_key", "status", "attempts", "available_at", "first_attempt_at", "lease_until", "lease_token", "provider_id", "last_error", "created_at", "updated_at") SELECT "id", "digest_id", NULL, "edition_date", "recipient", "sender", "idempotency_key", "status", "attempts", "available_at", "first_attempt_at", "lease_until", "lease_token", "provider_id", "last_error", "created_at", "updated_at" FROM `deliveries`;--> statement-breakpoint
DROP TABLE `deliveries`;--> statement-breakpoint
ALTER TABLE `__new_deliveries` RENAME TO `deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_idempotency_key_unique` ON `deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_edition_recipient` ON `deliveries` (`edition_date`,`recipient`) WHERE digest_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_alert_recipient` ON `deliveries` (`alert_id`,`recipient`) WHERE alert_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `delivery_by_digest` ON `deliveries` (`digest_id`);--> statement-breakpoint
CREATE INDEX `delivery_due` ON `deliveries` (`status`,`available_at`,`lease_until`);