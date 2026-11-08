CREATE VIRTUAL TABLE items_fts USING fts5(title, text);
--> statement-breakpoint
CREATE TRIGGER item_search_insert AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid,title,text) VALUES(new.rowid,new.title,'');
END;
--> statement-breakpoint
CREATE TRIGGER item_search_update AFTER UPDATE OF title ON items BEGIN
  UPDATE items_fts SET title=new.title WHERE rowid=new.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER content_search_insert AFTER INSERT ON content BEGIN
  UPDATE items_fts SET text=new.text WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER content_search_update AFTER UPDATE ON content BEGIN
  UPDATE items_fts SET text=new.text WHERE rowid=(SELECT rowid FROM items WHERE id=new.item_id);
END;
--> statement-breakpoint
CREATE TRIGGER item_search_delete AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE rowid=old.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER content_search_delete AFTER DELETE ON content BEGIN
  UPDATE items_fts SET text='' WHERE rowid=(SELECT rowid FROM items WHERE id=old.item_id);
END;
--> statement-breakpoint
CREATE INDEX jobs_due ON jobs(status,available_at);
