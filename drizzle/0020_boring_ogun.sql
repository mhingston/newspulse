ALTER TABLE `content_versions` ADD `url` text;--> statement-breakpoint
UPDATE content_versions SET url=(SELECT r.url FROM item_sources r WHERE r.source_id=content_versions.source_id AND r.native_id=content_versions.native_id);
