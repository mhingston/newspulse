import type { Database } from "bun:sqlite";
import type { PlannedQuery } from "../discovery-planner";
import { normalizeDiscoveryQuery } from "../discovery-planner";

export class DiscoveryPlannerStore {
  constructor(private readonly db: Database) {}

  sync(queries: PlannedQuery[], now: number, intervalMs: number): void {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 60_000
    )
      throw new Error("Invalid discovery schedule time");
    this.db
      .transaction(() => {
        this.db.query("UPDATE discovery_query_state SET enabled=0").run();
        const upsert = this.db
          .query(`INSERT INTO discovery_query_state(query_key,query,kind,interest_id,interest_version,priority,negative_terms,interest_lineage,enabled,next_due_at)
        VALUES(?,?,?,?,?,?,?,?,1,?) ON CONFLICT(query_key) DO UPDATE SET
        next_due_at=CASE WHEN discovery_query_state.query IS NOT excluded.query OR discovery_query_state.kind IS NOT excluded.kind OR discovery_query_state.interest_id IS NOT excluded.interest_id OR discovery_query_state.interest_version IS NOT excluded.interest_version OR discovery_query_state.priority IS NOT excluded.priority OR discovery_query_state.negative_terms IS NOT excluded.negative_terms OR discovery_query_state.interest_lineage IS NOT excluded.interest_lineage THEN excluded.next_due_at ELSE discovery_query_state.next_due_at END,
        query=excluded.query,kind=excluded.kind,interest_id=excluded.interest_id,interest_version=excluded.interest_version,priority=excluded.priority,negative_terms=excluded.negative_terms,interest_lineage=excluded.interest_lineage,enabled=1`);
        for (const query of queries)
          upsert.run(
            query.key,
            query.query,
            query.kind,
            query.interestId ?? null,
            query.interestVersion ?? null,
            query.priority,
            JSON.stringify(query.negative),
            JSON.stringify(query.interestLineage),
            now,
          );
        const priorRuns = this.db
          .query<{ query: string; last_at: number }, []>(
            "SELECT r.query,max(r.started_at) AS last_at FROM discovery_runs r JOIN discovery_pages p ON p.run_id=r.id GROUP BY r.query",
          )
          .all();
        const latestRunByQuery = new Map<string, number>();
        for (const row of priorRuns) {
          const key = normalizeDiscoveryQuery(row.query);
          latestRunByQuery.set(
            key,
            Math.max(latestRunByQuery.get(key) ?? 0, row.last_at),
          );
        }
        const reschedule = this.db.query(
          "UPDATE discovery_query_state SET next_due_at=max(next_due_at,?) WHERE query_key=?",
        );
        for (const query of queries) {
          const lastAt =
            latestRunByQuery.get(normalizeDiscoveryQuery(query.query)) ?? 0;
          if (lastAt > 0) reschedule.run(lastAt + intervalMs, query.key);
        }
      })
      .immediate();
  }

  due(
    now: number,
    limit: number,
  ): Array<PlannedQuery & { nextDueAt: number; utility: number }> {
    return this.db
      .query(
        `WITH latest_item_feedback AS (
        SELECT r.item_id, f.useful
        FROM discovery_result_feedback f
        JOIN discovery_results r ON r.id=f.result_id
        WHERE f.id=(SELECT max(last.id) FROM discovery_result_feedback last JOIN discovery_results lr ON lr.id=last.result_id WHERE lr.item_id=r.item_id)
      ), item_query_feedback AS (
        SELECT DISTINCT run.schedule_key,r.item_id,latest.useful
        FROM discovery_runs run JOIN discovery_pages p ON p.run_id=run.id
        JOIN discovery_results r ON r.page_id=p.id
        JOIN latest_item_feedback latest ON latest.item_id=r.item_id
      )
      SELECT s.query_key,s.query,s.kind,s.interest_id,s.interest_version,s.priority,s.negative_terms,s.interest_lineage,s.next_due_at,
      coalesce(sum(CASE WHEN f.useful=1 THEN 1 ELSE 0 END),0) AS useful,
      coalesce(sum(CASE WHEN f.useful=0 THEN 1 ELSE 0 END),0) AS not_useful,
      (SELECT count(*) FROM item_query_feedback f WHERE f.schedule_key=s.query_key AND f.useful=1) AS useful_items,
      (SELECT count(*) FROM item_query_feedback f WHERE f.schedule_key=s.query_key AND f.useful=0) AS not_useful_items
      FROM discovery_query_state s LEFT JOIN discovery_query_feedback f ON f.query_key=s.query_key
      WHERE s.enabled=1 AND s.next_due_at<=? GROUP BY s.query_key
      ORDER BY (s.priority
        +50*coalesce(sum(CASE WHEN f.useful=1 THEN 1 ELSE 0 END),0)
        -40*coalesce(sum(CASE WHEN f.useful=0 THEN 1 ELSE 0 END),0)
        +50*(SELECT count(*) FROM item_query_feedback f WHERE f.schedule_key=s.query_key AND f.useful=1)
        -40*(SELECT count(*) FROM item_query_feedback f WHERE f.schedule_key=s.query_key AND f.useful=0)) DESC,s.kind,s.query_key LIMIT ?`,
      )
      .all(now, limit)
      .map((r: any) => ({
        key: r.query_key,
        query: r.query,
        kind: r.kind,
        interestId: r.interest_id ?? undefined,
        interestVersion: r.interest_version ?? undefined,
        interestLineage: JSON.parse(r.interest_lineage),
        priority: r.priority,
        nextDueAt: r.next_due_at,
        utility:
          50 * r.useful -
          40 * r.not_useful +
          50 * r.useful_items -
          40 * r.not_useful_items,
        negative: JSON.parse(r.negative_terms),
      }));
  }

  matchingQuery(query: string): PlannedQuery | null {
    const row = this.db
      .query<
        {
          query_key: string;
          query: string;
          kind: PlannedQuery["kind"];
          interest_id: string | null;
          interest_version: number | null;
          priority: number;
          negative_terms: string;
          interest_lineage: string;
        },
        []
      >("SELECT * FROM discovery_query_state WHERE enabled=1")
      .all()
      .find(
        (candidate) =>
          normalizeDiscoveryQuery(candidate.query) ===
          normalizeDiscoveryQuery(query),
      );
    return row
      ? {
          key: row.query_key,
          query: row.query,
          kind: row.kind,
          interestId: row.interest_id ?? undefined,
          interestVersion: row.interest_version ?? undefined,
          priority: row.priority,
          negative: JSON.parse(row.negative_terms),
          interestLineage: JSON.parse(row.interest_lineage),
        }
      : null;
  }

  markAttempt(
    queryKey: string,
    runId: string,
    now: number,
    intervalMs: number,
  ): void {
    this.db
      .query(
        "UPDATE discovery_query_state SET last_run_at=?,last_run_id=?,next_due_at=? WHERE query_key=? AND enabled=1",
      )
      .run(now, runId, now + intervalMs, queryKey);
  }

  feedback(queryKey: string, useful: boolean, now: number): void {
    const state = this.db
      .query("SELECT 1 FROM discovery_query_state WHERE query_key=?")
      .get(queryKey);
    if (!state) throw new Error("Unknown discovery query");
    this.db
      .query(
        "INSERT INTO discovery_query_feedback(query_key,useful,created_at) VALUES(?,?,?)",
      )
      .run(queryKey, Number(useful), now);
  }

  feedbackForQuery(query: string, useful: boolean, now: number): number {
    const key = normalizeDiscoveryQuery(query);
    const rows = this.db
      .query<{ query_key: string; query: string }, []>(
        "SELECT query_key,query FROM discovery_query_state WHERE enabled=1",
      )
      .all()
      .filter((row) => normalizeDiscoveryQuery(row.query) === key);
    if (!rows.length) throw new Error("No scheduled query matches that text");
    const insert = this.db.query(
      "INSERT INTO discovery_query_feedback(query_key,useful,created_at) VALUES(?,?,?)",
    );
    this.db
      .transaction(() => {
        for (const row of rows) insert.run(row.query_key, Number(useful), now);
      })
      .immediate();
    return rows.length;
  }

  feedbackForLatestItemResult(
    itemId: string,
    useful: boolean,
    now: number,
  ): number {
    const result = this.db
      .query<{ id: number }, [string]>(
        "SELECT r.id FROM discovery_results r JOIN discovery_pages p ON p.id=r.page_id JOIN discovery_runs run ON run.id=p.run_id WHERE r.item_id=? ORDER BY run.started_at DESC,r.id DESC LIMIT 1",
      )
      .get(itemId);
    if (!result) throw new Error("No discovery result exists for that item");
    return this.db
      .query(
        "INSERT INTO discovery_result_feedback(result_id,useful,created_at) VALUES(?,?,?)",
      )
      .run(result.id, Number(useful), now).changes;
  }

  history(): unknown[] {
    return this.db
      .query(
        `WITH latest_item_feedback AS (
        SELECT r.item_id, f.useful
        FROM discovery_result_feedback f
        JOIN discovery_results r ON r.id=f.result_id
        WHERE f.id=(SELECT max(last.id) FROM discovery_result_feedback last JOIN discovery_results lr ON lr.id=last.result_id WHERE lr.item_id=r.item_id)
      ), item_query_feedback AS (
        SELECT DISTINCT run.schedule_key,r.item_id,latest.useful
        FROM discovery_runs run JOIN discovery_pages p ON p.run_id=run.id
        JOIN discovery_results r ON r.page_id=p.id
        JOIN latest_item_feedback latest ON latest.item_id=r.item_id
      )
      SELECT s.query_key,s.query,s.kind,s.interest_id,s.interest_version,s.interest_lineage,s.priority,s.enabled,s.next_due_at,s.last_run_at,s.last_run_id,
      coalesce(sum(CASE WHEN f.useful=1 THEN 1 ELSE 0 END),0) AS useful_feedback,
      coalesce(sum(CASE WHEN f.useful=0 THEN 1 ELSE 0 END),0) AS not_useful_feedback,
      (SELECT count(*) FROM item_query_feedback f WHERE f.schedule_key=s.query_key AND f.useful=1) AS useful_discoveries,
      (SELECT count(*) FROM item_query_feedback f WHERE f.schedule_key=s.query_key AND f.useful=0) AS not_useful_discoveries,
      (SELECT count(*) FROM discovery_results r JOIN discovery_pages p ON p.id=r.page_id WHERE p.run_id=s.last_run_id) AS latest_result_count,
      (SELECT status FROM discovery_runs WHERE id=s.last_run_id) AS latest_run_status
      FROM discovery_query_state s LEFT JOIN discovery_query_feedback f ON f.query_key=s.query_key
      GROUP BY s.query_key ORDER BY s.kind,s.query_key`,
      )
      .all();
  }
}
