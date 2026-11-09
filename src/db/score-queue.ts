import type { Database } from "bun:sqlite";

/** Requeue only the latest completed input generation, fencing any active claimant. */
export function invalidateScores(
  db: Database,
  now: number,
  itemId?: string,
): void {
  db.query(
    `UPDATE processing_jobs SET status='pending', attempts=0, available_at=?, lease_token=NULL, lease_until=NULL, last_error=NULL
    WHERE stage='score' AND (? IS NULL OR item_id=?) AND generation=(SELECT max(e.generation) FROM processing_jobs e WHERE e.item_id=processing_jobs.item_id AND e.stage='extract')`,
  ).run(now, itemId ?? null, itemId ?? null);
  db.query(
    `INSERT OR IGNORE INTO processing_jobs(id,stage,item_id,generation,available_at,created_at)
    SELECT lower(hex(randomblob(16))), 'score', e.item_id, e.generation, ?, ? FROM processing_jobs e
    WHERE e.stage='extract' AND e.status='done' AND (? IS NULL OR e.item_id=?)
      AND e.generation=(SELECT max(x.generation) FROM processing_jobs x WHERE x.item_id=e.item_id AND x.stage='extract')`,
  ).run(now, now, itemId ?? null, itemId ?? null);
}
