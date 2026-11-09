-- Custom SQL migration file, put your code below! --
CREATE TRIGGER digest_sealed_update_collision BEFORE UPDATE ON digests
WHEN EXISTS (SELECT 1 FROM digests WHERE sealed=1 AND (id=NEW.id OR edition_date=NEW.edition_date) AND id<>OLD.id)
BEGIN SELECT RAISE(ABORT,'frozen digest is immutable'); END;
