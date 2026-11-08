INSERT OR IGNORE INTO processing_jobs(id, stage, item_id, available_at, created_at)
SELECT lower(hex(randomblob(16))), 'extract', id, ingested_at, ingested_at FROM items;
