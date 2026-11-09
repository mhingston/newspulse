ALTER TABLE `digests` ADD `sealed` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER digest_sealed_update BEFORE UPDATE ON digests WHEN OLD.sealed=1 BEGIN SELECT RAISE(ABORT,'frozen digest is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER digest_sealed_delete BEFORE DELETE ON digests WHEN OLD.sealed=1 BEGIN SELECT RAISE(ABORT,'frozen digest is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER digest_item_sealed_insert BEFORE INSERT ON digest_items WHEN EXISTS (SELECT 1 FROM digests WHERE id=NEW.digest_id AND sealed=1) BEGIN SELECT RAISE(ABORT,'frozen digest is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER digest_item_sealed_update BEFORE UPDATE ON digest_items WHEN EXISTS (SELECT 1 FROM digests WHERE id=OLD.digest_id AND sealed=1) OR EXISTS (SELECT 1 FROM digests WHERE id=NEW.digest_id AND sealed=1) BEGIN SELECT RAISE(ABORT,'frozen digest is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER digest_item_sealed_delete BEFORE DELETE ON digest_items WHEN EXISTS (SELECT 1 FROM digests WHERE id=OLD.digest_id AND sealed=1) BEGIN SELECT RAISE(ABORT,'frozen digest is immutable'); END;
