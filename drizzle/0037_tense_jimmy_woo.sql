CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`digest_id` text NOT NULL,
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
	FOREIGN KEY (`digest_id`) REFERENCES `digests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_idempotency_key_unique` ON `deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_edition_recipient` ON `deliveries` (`edition_date`,`recipient`);--> statement-breakpoint
CREATE INDEX `delivery_due` ON `deliveries` (`status`,`available_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `publication_schedule_history` (
	`date` text PRIMARY KEY NOT NULL,
	`due_at` integer,
	`status` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publication_schedule_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_date` text NOT NULL,
	`timezone` text NOT NULL,
	`hour` integer NOT NULL,
	`minute` integer NOT NULL,
	`updated_at` integer NOT NULL
);
