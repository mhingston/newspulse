import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { invalidateScores } from "./db/score-queue";

/**
 * Explicit feedback only. Missing clicks, unread material and digest omission
 * never become events: every row here comes from a user action.
 */
export type FeedbackAction = "useful" | "not_useful";
export type FeedbackSource = "mcp" | "email";

export interface FeedbackEvent {
  id: string;
  itemId: string;
  useful: boolean;
  source: FeedbackSource;
  editionDate: string | null;
  digestId: string | null;
  createdAt: number;
}

/** Record one explicit feedback event and invalidate derived item scores. */
export function recordFeedback(
  db: Database,
  event: {
    itemId: string;
    action: FeedbackAction;
    source: FeedbackSource;
    editionDate?: string | null;
    digestId?: string | null;
    now?: number;
  },
): FeedbackEvent {
  const now = event.now ?? Date.now();
  const useful = event.action === "useful";
  const id = randomUUID();
  db.transaction(() => {
    db.query(
      "INSERT INTO item_feedback(id,item_id,useful,source,edition_date,digest_id,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      id,
      event.itemId,
      Number(useful),
      event.source,
      event.editionDate ?? null,
      event.digestId ?? null,
      now,
    );
    // When the item came from discovery, propagate the signal to the existing
    // discovery-feedback ledger so query selection is refined with recorded
    // provenance. A manual or feed item simply has no discovery result.
    const result = db
      .query<{ id: number }, [string]>(
        "SELECT r.id FROM discovery_results r JOIN discovery_pages p ON p.id=r.page_id JOIN discovery_runs run ON run.id=p.run_id WHERE r.item_id=? ORDER BY run.started_at DESC,r.id DESC LIMIT 1",
      )
      .get(event.itemId);
    if (result)
      db.query(
        "INSERT INTO discovery_result_feedback(result_id,useful,created_at) VALUES(?,?,?)",
      ).run(result.id, Number(useful), now);
    // Scores are derived views; a feedback change re-derives them explicitly.
    invalidateScores(db, now, event.itemId);
  }).immediate();
  return {
    id,
    itemId: event.itemId,
    useful,
    source: event.source,
    editionDate: event.editionDate ?? null,
    digestId: event.digestId ?? null,
    createdAt: now,
  };
}

/** Latest explicit feedback per item, newest first — never inferred. */
export function latestFeedback(db: Database, limit = 100): FeedbackEvent[] {
  return db
    .query<
      {
        id: string;
        item_id: string;
        useful: number;
        source: string;
        edition_date: string | null;
        digest_id: string | null;
        created_at: number;
      },
      [number]
    >(
      "SELECT id,item_id,useful,source,edition_date,digest_id,created_at FROM item_feedback f WHERE created_at=(SELECT max(last.created_at) FROM item_feedback last WHERE last.item_id=f.item_id) ORDER BY created_at DESC,id DESC LIMIT ?",
    )
    .all(Math.max(1, Math.min(1000, limit)))
    .map((row) => ({
      id: row.id,
      itemId: row.item_id,
      useful: row.useful === 1,
      source: row.source as FeedbackSource,
      editionDate: row.edition_date,
      digestId: row.digest_id,
      createdAt: row.created_at,
    }));
}
