ALTER TABLE `processing_jobs` ADD `origin_source_id` text REFERENCES sources(id);--> statement-breakpoint
ALTER TABLE `processing_jobs` ADD `origin_url` text;