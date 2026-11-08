DROP TRIGGER content_search_insert;
--> statement-breakpoint
DROP TRIGGER content_search_update;
--> statement-breakpoint
DROP TRIGGER content_search_delete;
--> statement-breakpoint
CREATE TRIGGER content_search_insert AFTER INSERT ON content BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=new.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=new.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract')),'') WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER content_search_update AFTER UPDATE ON content BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=new.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=new.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract')),'') WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER content_search_delete AFTER DELETE ON content BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=old.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=old.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=old.item_id AND stage='extract')),'') WHERE rowid=(SELECT rowid FROM items WHERE id=old.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER processing_search_insert AFTER INSERT ON processing_jobs WHEN new.stage='extract' BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=new.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=new.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract')),'') WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER processing_search_update AFTER UPDATE OF status,result,outcome,generation ON processing_jobs WHEN new.stage='extract' BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=new.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=new.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract')),'') WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER processing_search_delete AFTER DELETE ON processing_jobs WHEN old.stage='extract' BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=old.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=old.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=old.item_id AND stage='extract')),'') WHERE rowid=(SELECT rowid FROM items WHERE id=old.item_id);
END;
--> statement-breakpoint
UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=(SELECT id FROM items WHERE rowid=items_fts.rowid)),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=(SELECT id FROM items WHERE rowid=items_fts.rowid) AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(p.generation) FROM processing_jobs p WHERE p.item_id=(SELECT id FROM items WHERE rowid=items_fts.rowid) AND p.stage='extract')),'');
