CREATE TABLE `digest_activity` (
	`item_id` text PRIMARY KEY NOT NULL,
	`activity_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `digest_activity_time` ON `digest_activity` (`activity_at`,`item_id`);
--> statement-breakpoint
INSERT INTO digest_activity(item_id,activity_at)
SELECT i.id, max(i.ingested_at, coalesce((SELECT max(c.observed_at) FROM content_versions c WHERE c.item_id=i.id),i.ingested_at), coalesce((SELECT max(first_at) FROM (SELECT min(s.created_at) AS first_at FROM item_scores s WHERE s.item_id=i.id GROUP BY s.generation)),i.ingested_at)) FROM items i;
--> statement-breakpoint
CREATE TRIGGER digest_activity_item_insert AFTER INSERT ON items BEGIN
  INSERT INTO digest_activity(item_id,activity_at) VALUES(NEW.id,NEW.ingested_at);
END;
--> statement-breakpoint
CREATE TRIGGER digest_activity_observation_insert AFTER INSERT ON content_versions BEGIN
  INSERT INTO digest_activity(item_id,activity_at) VALUES(NEW.item_id,NEW.observed_at) ON CONFLICT(item_id) DO UPDATE SET activity_at=max(activity_at,excluded.activity_at);
END;
--> statement-breakpoint
CREATE TRIGGER digest_activity_observation_merge AFTER UPDATE OF item_id ON content_versions WHEN NEW.item_id<>OLD.item_id BEGIN
  INSERT INTO digest_activity(item_id,activity_at) VALUES(NEW.item_id,NEW.observed_at) ON CONFLICT(item_id) DO UPDATE SET activity_at=max(activity_at,excluded.activity_at);
END;
--> statement-breakpoint
CREATE TRIGGER digest_activity_identity_merge AFTER INSERT ON item_redirects BEGIN
  INSERT INTO digest_activity(item_id,activity_at) SELECT NEW.item_id,activity_at FROM digest_activity WHERE item_id=NEW.old_id ON CONFLICT(item_id) DO UPDATE SET activity_at=max(activity_at,excluded.activity_at);
END;
--> statement-breakpoint
CREATE TRIGGER digest_activity_first_score AFTER INSERT ON item_scores WHEN NOT EXISTS (SELECT 1 FROM item_scores WHERE item_id=NEW.item_id AND generation=NEW.generation AND id<>NEW.id) BEGIN
  INSERT INTO digest_activity(item_id,activity_at) VALUES(NEW.item_id,NEW.created_at) ON CONFLICT(item_id) DO UPDATE SET activity_at=max(activity_at,excluded.activity_at);
END;
