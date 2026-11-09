CREATE TRIGGER digest_sealed_replace BEFORE INSERT ON digests
WHEN EXISTS (SELECT 1 FROM digests WHERE sealed=1 AND (id=NEW.id OR edition_date=NEW.edition_date))
BEGIN SELECT RAISE(ABORT,'frozen digest is immutable'); END;
