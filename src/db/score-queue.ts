import type { Database } from "bun:sqlite";

/** Requeue only the latest completed input generation, fencing any active claimant. */
export function invalidateScores(
  db: Database,
  now: number,
  itemId?: string,
): void {
  if (itemId === undefined) {
    db.query(
      "INSERT INTO score_validity_events(item_id,score_id,kind,event_at) VALUES(NULL,NULL,'global_invalidation',?)",
    ).run(now);
    db.query(
      `INSERT INTO score_invalidation(id,cursor,pending,generation,pass_generation) VALUES(1,NULL,1,1,1)
      ON CONFLICT(id) DO UPDATE SET cursor=CASE WHEN pending=0 THEN NULL ELSE cursor END,
        pass_generation=CASE WHEN pending=0 THEN generation+1 ELSE pass_generation END,
        pending=1,generation=generation+1`,
    ).run();
    return;
  }
  db.query(
    "INSERT INTO score_validity_events(item_id,score_id,kind,event_at) VALUES(?,NULL,'item_invalidation',?)",
  ).run(itemId, now);
  db.query(
    `UPDATE processing_jobs SET status='pending', attempts=0, available_at=?, queued_at=?, lease_token=NULL, lease_until=NULL, last_error=NULL
    WHERE stage='score' AND item_id=? AND generation=(SELECT max(e.generation) FROM processing_jobs e WHERE e.item_id=processing_jobs.item_id AND e.stage='extract')`,
  ).run(now, now, itemId);
  db.query(
    `INSERT OR IGNORE INTO processing_jobs(id,stage,item_id,generation,available_at,queued_at,created_at)
    SELECT lower(hex(randomblob(16))), 'score', e.item_id, e.generation, ?, ?, ? FROM processing_jobs e
    WHERE e.stage='extract' AND e.status='done' AND e.item_id=?
      AND e.generation=(SELECT max(x.generation) FROM processing_jobs x WHERE x.item_id=e.item_id AND x.stage='extract')`,
  ).run(now, now, now, itemId);
}

/** Advance global invalidation by at most 32 indexed score jobs per claim. */
export function advanceScoreInvalidation(db: Database, now: number): void {
  const state = db
    .query<{ cursor: string | null; pending: number }, []>(
      "SELECT cursor,pending FROM score_invalidation WHERE id=1",
    )
    .get();
  if (!state?.pending) return;
  const rows = db
    .query<{ id: string; item_id: string; generation: number }, [string]>(
      "SELECT id,item_id,generation FROM processing_jobs WHERE stage='score' AND id>? ORDER BY id LIMIT 32",
    )
    .all(state.cursor ?? "");
  const invalidate =
    db.query(`UPDATE processing_jobs SET status='pending',attempts=0,available_at=?,lease_token=NULL,lease_until=NULL,last_error=NULL
    WHERE id=? AND generation=(SELECT max(e.generation) FROM processing_jobs e WHERE e.item_id=processing_jobs.item_id AND e.stage='extract')`);
  for (const row of rows) {
    if (invalidate.run(now, row.id).changes)
      db.query(
        "INSERT INTO score_validity_events(item_id,score_id,kind,event_at) VALUES(?,NULL,'item_invalidation',?)",
      ).run(row.item_id, now);
  }
  if (rows.length < 32) {
    db.query(
      "UPDATE score_invalidation SET pending=CASE WHEN generation=pass_generation THEN 0 ELSE 1 END,cursor=NULL,pass_generation=generation WHERE id=1",
    ).run();
    const after = db
      .query<{ pending: number }, []>(
        "SELECT pending FROM score_invalidation WHERE id=1",
      )
      .get();
    if (after && !after.pending)
      db.query(
        "INSERT INTO score_validity_events(item_id,score_id,kind,event_at) VALUES(NULL,NULL,'global_pass_complete',?)",
      ).run(now);
  } else
    db.query("UPDATE score_invalidation SET cursor=? WHERE id=1").run(
      rows[rows.length - 1]!.id,
    );
}
