CREATE TABLE `inbound_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`message_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`metadata` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `inbound_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_event_identity` ON `inbound_events` (`provider`,`event_id`);--> statement-breakpoint
CREATE TABLE `inbound_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`metadata` text NOT NULL,
	`body` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`lease_until` integer,
	`lease_token` text,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_message_identity` ON `inbound_messages` (`provider`,`provider_id`);--> statement-breakpoint
CREATE INDEX `inbound_message_due` ON `inbound_messages` (`status`,`available_at`,`id`);--> statement-breakpoint
CREATE INDEX `inbound_message_lease` ON `inbound_messages` (`status`,`lease_until`);--> statement-breakpoint
CREATE TABLE `inbound_reconciliation` (
	`key` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`available_at` integer NOT NULL,
	`lease_until` integer,
	`lease_token` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbound_reconciliation_due` ON `inbound_reconciliation` (`available_at`,`lease_until`);