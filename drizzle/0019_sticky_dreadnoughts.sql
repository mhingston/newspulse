ALTER TABLE `content_versions` ADD `backfilled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE content_versions SET backfilled=1;
