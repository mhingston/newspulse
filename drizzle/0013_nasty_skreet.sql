CREATE INDEX `content_versions_source_native` ON `content_versions` (`source_id`,`native_id`,`id`);--> statement-breakpoint
CREATE INDEX `content_versions_item` ON `content_versions` (`item_id`,`id`);