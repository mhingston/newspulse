CREATE TABLE `item_url_aliases` (
  `canonical_url` text PRIMARY KEY NOT NULL,
  `item_id` text NOT NULL,
  FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `item_url_aliases_item` ON `item_url_aliases` (`item_id`);
--> statement-breakpoint
CREATE TABLE `item_redirects` (
  `old_id` text PRIMARY KEY NOT NULL,
  `item_id` text NOT NULL,
  FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `item_redirects_item` ON `item_redirects` (`item_id`);
--> statement-breakpoint
INSERT INTO item_url_aliases(canonical_url,item_id)
SELECT i.url,i.id FROM items i
WHERE i.url IS NOT NULL AND i.id=(
  SELECT earliest.id FROM items earliest WHERE earliest.url=i.url
  ORDER BY earliest.ingested_at,earliest.id LIMIT 1
);