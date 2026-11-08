CREATE TABLE `analysis_control` (
	`id` integer PRIMARY KEY NOT NULL,
	`envelope_breach` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO processing_jobs(id,stage,generation,item_id,status,attempts,available_at,created_at)
SELECT lower(hex(randomblob(16))),'analyse',e.generation,e.item_id,'pending',0,e.created_at,e.created_at
FROM processing_jobs e JOIN content c ON c.item_id=e.item_id
WHERE e.stage='extract' AND e.status='done' AND e.outcome='unavailable' AND c.text<>''
AND e.generation=(SELECT max(p.generation) FROM processing_jobs p WHERE p.item_id=e.item_id AND p.stage='extract');
