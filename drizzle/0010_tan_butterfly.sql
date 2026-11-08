CREATE TABLE `profiles` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`version` integer NOT NULL,
	`document` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_version_unique` ON `profiles` (`kind`,`id`,`version`);