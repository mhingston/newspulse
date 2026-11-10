CREATE TABLE `digest_activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`related_item_id` text,
	`activity_at` integer NOT NULL,
	`kind` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `digest_activity_events_time` ON `digest_activity_events` (`activity_at`,`item_id`);--> statement-breakpoint
CREATE TABLE `digest_history_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`evidence_from` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `score_validity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text,
	`score_id` text,
	`kind` text NOT NULL,
	`event_at` integer NOT NULL,
	`valid_until` integer
);
--> statement-breakpoint
CREATE INDEX `score_validity_item_time` ON `score_validity_events` (`item_id`,`event_at`);--> statement-breakpoint
CREATE INDEX `score_validity_score` ON `score_validity_events` (`score_id`,`event_at`);--> statement-breakpoint
CREATE INDEX `score_validity_global_time` ON `score_validity_events` (`kind`,`event_at`);--> statement-breakpoint
CREATE INDEX `score_validity_time` ON `score_validity_events` (`event_at`);--> statement-breakpoint
CREATE TABLE `story_grouping_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state` text NOT NULL,
	`event_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `story_grouping_events_time` ON `story_grouping_events` (`event_at`,`id`);--> statement-breakpoint
ALTER TABLE `publication_schedule_history` ADD `details` text;
--> statement-breakpoint
INSERT INTO digest_history_state(id,evidence_from)
VALUES(1,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
--> statement-breakpoint
INSERT INTO story_grouping_events(state,event_at)
SELECT CASE WHEN EXISTS (SELECT 1 FROM story_grouping_state WHERE id=1 AND fingerprint<>'dirty')
  THEN 'ready' ELSE 'dirty' END,
  CAST((julianday('now')-2440587.5)*86400000 AS INTEGER);
--> statement-breakpoint
CREATE TRIGGER digest_evidence_item_insert AFTER INSERT ON items BEGIN
  INSERT INTO digest_activity_events(item_id,activity_at,kind) VALUES(NEW.id,NEW.ingested_at,'ingested');
END;
--> statement-breakpoint
CREATE TRIGGER digest_evidence_observation_insert AFTER INSERT ON content_versions BEGIN
  INSERT INTO digest_activity_events(item_id,activity_at,kind) VALUES(NEW.item_id,NEW.observed_at,'observed');
END;
--> statement-breakpoint
CREATE TRIGGER digest_evidence_first_score AFTER INSERT ON item_scores WHEN NOT EXISTS (
  SELECT 1 FROM item_scores WHERE item_id=NEW.item_id AND generation=NEW.generation AND id<>NEW.id
) BEGIN
  INSERT INTO digest_activity_events(item_id,activity_at,kind) VALUES(NEW.item_id,NEW.created_at,'first_score');
END;
--> statement-breakpoint
CREATE TRIGGER digest_evidence_redirect AFTER INSERT ON item_redirects BEGIN
  INSERT INTO digest_activity_events(item_id,related_item_id,activity_at,kind)
  VALUES(NEW.item_id,NEW.old_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),'identity_merge');
END;
--> statement-breakpoint
CREATE TRIGGER digest_evidence_retention AFTER INSERT ON digest_activity_events BEGIN
  DELETE FROM digest_activity_events
  WHERE activity_at < CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) - 31622400000;
  UPDATE digest_history_state
  SET evidence_from=max(evidence_from,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) - 31622400000)
  WHERE id=1;
END;
