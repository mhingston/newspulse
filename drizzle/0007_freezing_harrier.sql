DROP INDEX `processing_stage_item_unique`;--> statement-breakpoint
ALTER TABLE `processing_jobs` ADD `generation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `processing_stage_item_unique` ON `processing_jobs` (`stage`,`item_id`,`generation`);