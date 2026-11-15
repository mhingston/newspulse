import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

/**
 * Persistence for frozen event alerts (issue #27). Frozen alert bytes and
 * decision snapshots are immutable; the change-event unique key makes the
 * freeze idempotent across repeated evaluations and restarts. Suppression
 * records persist why an evaluated event did not alert.
 */

const SUBJECT_MAX = 1000;
const BODY_MAX = 1_000_000;
const DECISION_MAX = 200_000;

export interface FrozenAlertInput {
  changeEventId: number;
  kind: string;
  itemId: string;
  groupId: string | null;
  localDate: string;
  subject: string;
  html: string;
  text: string;
  decision: unknown;
  scoreId: string | null;
}

export interface AlertRecord {
  id: string;
  change_event_id: number;
  kind: string;
  item_id: string;
  group_id: string | null;
  local_date: string;
  subject: string;
  html: string;
  plain_text: string;
  decision: string;
  fingerprint: string;
  score_id: string | null;
  frozen_at: number;
  sealed: number;
}

export interface AlertSuppressionRow {
  changeEventId: number;
  reason: string;
  localDate: string;
  details: string;
  createdAt: number;
}

export class AlertStore {
  constructor(private readonly db: Database) {}

  /**
   * Freezes the alert inside the caller's transaction when its change event
   * has not been alerted yet; returns the frozen row, or null when the event
   * already carries an alert (deterministic dedup across restarts).
   */
  freeze(input: FrozenAlertInput, now: number): AlertRecord | null {
    if (input.subject.trim().length === 0 || input.subject.length > SUBJECT_MAX)
      throw new Error("Invalid alert subject");
    if (input.html.length > BODY_MAX || input.text.length > BODY_MAX)
      throw new Error("Alert body exceeds frozen size limit");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate))
      throw new Error("Invalid alert local date");
    const encodedDecision = JSON.stringify(input.decision);
    if (encodedDecision === undefined || encodedDecision.length > DECISION_MAX)
      throw new Error("Alert decision snapshot exceeds frozen size limit");
    const fingerprint = createHash("sha256")
      .update(encodedDecision)
      .update(input.subject)
      .update(input.html)
      .update(input.text)
      .digest("hex");
    const existing = this.db
      .query<{ id: string }, [number]>(
        "SELECT id FROM alerts WHERE change_event_id=?",
      )
      .get(input.changeEventId);
    if (existing) return null;
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO alerts(id,change_event_id,kind,item_id,group_id,local_date,subject,html,plain_text,decision,fingerprint,score_id,frozen_at,sealed)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      )
      .run(
        id,
        input.changeEventId,
        input.kind,
        input.itemId,
        input.groupId,
        input.localDate,
        input.subject,
        input.html,
        input.text,
        encodedDecision,
        fingerprint,
        input.scoreId,
        now,
      );
    return this.get(id);
  }

  get(id: string): AlertRecord | null {
    return (
      (this.db
        .query<AlertRecord, [string]>("SELECT * FROM alerts WHERE id=?")
        .get(id) as AlertRecord | undefined) ?? null
    );
  }

  byChangeEvent(changeEventId: number): AlertRecord | null {
    return (
      (this.db
        .query<AlertRecord, [number]>(
          "SELECT * FROM alerts WHERE change_event_id=?",
        )
        .get(changeEventId) as AlertRecord | undefined) ?? null
    );
  }

  /** The newest alert frozen for a development, for cooldown decisions. */
  latestForGroup(groupId: string): { id: string; frozenAt: number } | null {
    const row = this.db
      .query<{ id: string; frozen_at: number }, [string]>(
        "SELECT id,frozen_at FROM alerts WHERE group_id=? ORDER BY frozen_at DESC,id DESC LIMIT 1",
      )
      .get(groupId);
    return row ? { id: row.id, frozenAt: row.frozen_at } : null;
  }

  countForLocalDate(localDate: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM alerts WHERE local_date=?",
      )
      .get(localDate)!.n;
  }

  list(localDate?: string, limit = 100): AlertRecord[] {
    if (localDate !== undefined)
      return this.db
        .query<AlertRecord, [string, number]>(
          "SELECT * FROM alerts WHERE local_date=? ORDER BY frozen_at,id LIMIT ?",
        )
        .all(localDate, limit) as AlertRecord[];
    return this.db
      .query<AlertRecord, [number]>(
        "SELECT * FROM alerts ORDER BY frozen_at,id LIMIT ?",
      )
      .all(limit) as AlertRecord[];
  }

  clear(): number {
    return this.db.query("DELETE FROM alerts").run().changes;
  }

  /**
   * Records why an evaluated change event did not produce an alert. The
   * unique (event, reason, local day) key makes this idempotent: a repeated
   * evaluation of the same suppression is a no-op, never a flood.
   */
  suppress(row: AlertSuppressionRow): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO alert_suppressions(change_event_id,reason,local_date,details,created_at)
         VALUES(?,?,?,?,?)`,
      )
      .run(
        row.changeEventId,
        row.reason,
        row.localDate,
        row.details,
        row.createdAt,
      );
  }

  listSuppressions(limit = 200) {
    return this.db
      .query<
        {
          id: number;
          change_event_id: number;
          reason: string;
          local_date: string;
          details: string;
          created_at: number;
        },
        [number]
      >(
        "SELECT id,change_event_id,reason,local_date,details,created_at FROM alert_suppressions ORDER BY created_at DESC,id DESC LIMIT ?",
      )
      .all(limit);
  }
}

/**
 * Durable evaluation cursor. Advanced in the same immediate transaction as
 * each event decision, so a crash between evaluation and cursor advance
 * re-evaluates the event but cannot double-send (the change-event unique key
 * deduplicates the freeze, and the outbox row deduplicates the delivery).
 */
export function alertCursor(db: Database): number {
  return (
    db
      .query<{ last_event_id: number }, []>(
        "SELECT last_event_id FROM alert_state WHERE id=1",
      )
      .get()?.last_event_id ?? -1
  );
}

export function advanceAlertCursor(
  db: Database,
  lastEventId: number,
  now: number,
): void {
  if (!Number.isSafeInteger(lastEventId) || lastEventId < 0)
    throw new Error("Invalid alert cursor");
  db.query(
    `INSERT INTO alert_state(id,last_event_id,updated_at) VALUES(1,?,?)
     ON CONFLICT(id) DO UPDATE SET last_event_id=max(last_event_id,excluded.last_event_id),updated_at=excluded.updated_at`,
  ).run(lastEventId, now);
}
