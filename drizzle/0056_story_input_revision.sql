CREATE TABLE story_input_revision (
  id integer PRIMARY KEY NOT NULL,
  revision integer NOT NULL
);
--> statement-breakpoint
INSERT INTO story_input_revision(id,revision) VALUES(1,0);
--> statement-breakpoint
CREATE TRIGGER story_input_items_insert AFTER INSERT ON items BEGIN
  UPDATE story_input_revision SET revision=revision+1 WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER story_input_items_update AFTER UPDATE OF identity,url,title,published_at,ingested_at ON items BEGIN
  UPDATE story_input_revision SET revision=revision+1 WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER story_input_items_delete AFTER DELETE ON items BEGIN
  UPDATE story_input_revision SET revision=revision+1 WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER story_input_content_insert AFTER INSERT ON content BEGIN
  UPDATE story_input_revision SET revision=revision+1 WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER story_input_content_update AFTER UPDATE OF text ON content BEGIN
  UPDATE story_input_revision SET revision=revision+1 WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER story_input_content_delete AFTER DELETE ON content BEGIN
  UPDATE story_input_revision SET revision=revision+1 WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER story_input_extract_insert AFTER INSERT ON processing_jobs WHEN new.stage='extract' BEGIN
  UPDATE story_input_revision SET revision=revision+1 WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER story_input_extract_update AFTER UPDATE OF status,outcome,result,generation,item_id ON processing_jobs WHEN old.stage='extract' OR new.stage='extract' BEGIN
  UPDATE story_input_revision SET revision=revision+1 WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER story_input_extract_delete AFTER DELETE ON processing_jobs WHEN old.stage='extract' BEGIN
  UPDATE story_input_revision SET revision=revision+1 WHERE id=1;
END;
