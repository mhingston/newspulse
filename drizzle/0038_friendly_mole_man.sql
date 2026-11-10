CREATE INDEX `delivery_by_digest` ON `deliveries` (`digest_id`);--> statement-breakpoint
CREATE INDEX `digest_item_by_item` ON `digest_items` (`item_id`,`digest_id`);