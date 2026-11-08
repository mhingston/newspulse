DROP TRIGGER content_search_insert;
--> statement-breakpoint
DROP TRIGGER content_search_update;
--> statement-breakpoint
DROP TRIGGER content_search_delete;
--> statement-breakpoint
DROP TRIGGER processing_search_insert;
--> statement-breakpoint
DROP TRIGGER processing_search_update;
--> statement-breakpoint
DROP TRIGGER processing_search_delete;
--> statement-breakpoint
CREATE TRIGGER content_search_insert AFTER INSERT ON content BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=new.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=new.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract')),'') || char(10) || coalesce((SELECT json_extract(result,'$.summary') FROM analyses WHERE item_id=new.item_id AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract') ORDER BY created_at DESC LIMIT 1),'') WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER content_search_update AFTER UPDATE ON content BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=new.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=new.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract')),'') || char(10) || coalesce((SELECT json_extract(result,'$.summary') FROM analyses WHERE item_id=new.item_id AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract') ORDER BY created_at DESC LIMIT 1),'') WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER content_search_delete AFTER DELETE ON content BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=old.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=old.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=old.item_id AND stage='extract')),'') || char(10) || coalesce((SELECT json_extract(result,'$.summary') FROM analyses WHERE item_id=old.item_id AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=old.item_id AND stage='extract') ORDER BY created_at DESC LIMIT 1),'') WHERE rowid=(SELECT rowid FROM items WHERE id=old.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER processing_search_insert AFTER INSERT ON processing_jobs WHEN new.stage='extract' BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=new.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=new.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract')),'') || char(10) || coalesce((SELECT json_extract(result,'$.summary') FROM analyses WHERE item_id=new.item_id AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract') ORDER BY created_at DESC LIMIT 1),'') WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER processing_search_update AFTER UPDATE OF status,result,outcome,generation ON processing_jobs WHEN new.stage='extract' BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=new.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=new.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract')),'') || char(10) || coalesce((SELECT json_extract(result,'$.summary') FROM analyses WHERE item_id=new.item_id AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract') ORDER BY created_at DESC LIMIT 1),'') WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER processing_search_delete AFTER DELETE ON processing_jobs WHEN old.stage='extract' BEGIN
  UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=old.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=old.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=old.item_id AND stage='extract')),'') || char(10) || coalesce((SELECT json_extract(result,'$.summary') FROM analyses WHERE item_id=old.item_id AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=old.item_id AND stage='extract') ORDER BY created_at DESC LIMIT 1),'') WHERE rowid=(SELECT rowid FROM items WHERE id=old.item_id);
END;

--> statement-breakpoint
CREATE TRIGGER analysis_search_insert AFTER INSERT ON analyses BEGIN
 UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=new.item_id),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=new.item_id AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract')),'') || char(10) || coalesce((SELECT json_extract(result,'$.summary') FROM analyses WHERE item_id=new.item_id AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=new.item_id AND stage='extract') ORDER BY created_at DESC LIMIT 1),'') WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
