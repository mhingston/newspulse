CREATE TABLE `delivery_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`edition_date` text NOT NULL,
	`recipient` text NOT NULL,
	`digest_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`prior_status` text,
	`outcome` text NOT NULL,
	`payload_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_suppression_identity` ON `delivery_suppressions` (`edition_date`,`recipient`);--> statement-breakpoint
CREATE INDEX `delivery_suppression_time` ON `delivery_suppressions` (`created_at`);