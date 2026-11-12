ALTER TABLE `processing_jobs` ADD `queued_at` integer;--> statement-breakpoint
UPDATE `processing_jobs` SET `queued_at` = `available_at` WHERE `queued_at` IS NULL;
