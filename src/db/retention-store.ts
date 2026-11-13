import type { Database } from "bun:sqlite";
import {
  PURGED_ANALYSIS,
  PURGED_EXTRACTION,
  retentionCutoff,
  type RetentionClass,
  type RetentionPolicy,
} from "../retention";

export interface RetentionCandidate {
  itemId: string;
  generation: number;
  class: RetentionClass;
}

export interface RetentionReport {
  dryRun: boolean;
  policy: RetentionPolicy;
  eligible: Record<RetentionClass, number>;
  purged: Record<RetentionClass, number>;
  /** Items skipped because processing, grouping, scoring or analysis was not settled. */
  deferred: number;
  /** True when an analysis reservation is in flight, which blocks summary purges. */
  analysisReservationsActive: boolean;
  /** Distinct items considered in this pass; a bounded pass may leave more eligible. */
  scanned: number;
  complete: boolean;
}

/**
 * Any queued or running extract, analyse, group or score stage may still read
 * the payload, so it blocks removal. Grouping reads extraction text to detect
 * syndicated coverage, so it is included. A disabled analysis stage that never
 * ran therefore keeps payloads until an operator decides, which is the
 * conservative outcome.
 */
const UNSETTLED_ITEM_SQL = `EXISTS (
  SELECT 1 FROM processing_jobs p WHERE p.item_id=i.id AND p.status IN ('pending','running'))`;
const SETTLED_ITEM_SQL = `NOT ${UNSETTLED_ITEM_SQL}`;

/**
 * Current-generation extraction payloads that are no longer needed by any
 * pending stage. The item must have a completed score for that generation, so
 * a later rescore is not silently fed a removed payload.
 */
function extractedCandidates(
  db: Database,
  cutoff: number,
  limit: number,
): RetentionCandidate[] {
  return db
    .query<{ item_id: string; generation: number }, [string, number, number]>(
      `SELECT x.item_id, x.generation FROM processing_jobs x
        JOIN items i ON i.id=x.item_id
       WHERE x.stage='extract' AND x.status='done' AND x.outcome='extracted'
         AND x.result IS NOT NULL AND x.result<>?
         AND x.generation=(SELECT max(g.generation) FROM processing_jobs g WHERE g.item_id=x.item_id AND g.stage='extract')
         AND x.created_at<=?
         AND ${SETTLED_ITEM_SQL}
         AND EXISTS (SELECT 1 FROM processing_jobs s WHERE s.item_id=x.item_id AND s.stage='score' AND s.generation=x.generation AND s.status='done')
         AND NOT EXISTS (SELECT 1 FROM retention_purges r WHERE r.item_id=x.item_id AND r.generation=x.generation AND r.class='extracted_payload')
       ORDER BY x.item_id, x.generation
       LIMIT ?`,
    )
    .all(PURGED_EXTRACTION, cutoff, limit)
    .map((row) => ({
      itemId: row.item_id,
      generation: row.generation,
      class: "extracted_payload",
    }));
}

/** Analyses for the current generation whose item is otherwise settled. */
function analysisCandidates(
  db: Database,
  cutoff: number,
  limit: number,
): RetentionCandidate[] {
  return db
    .query<{ item_id: string; generation: number }, [number, number]>(
      `SELECT a.item_id, a.generation FROM analyses a
        JOIN items i ON i.id=a.item_id
       WHERE a.created_at<=?
         AND a.generation=(SELECT max(g.generation) FROM processing_jobs g WHERE g.item_id=a.item_id AND g.stage='extract')
         AND a.result<>'{"purged":true}'
         AND ${SETTLED_ITEM_SQL}
         AND EXISTS (SELECT 1 FROM processing_jobs s WHERE s.item_id=a.item_id AND s.stage='score' AND s.generation=a.generation AND s.status='done')
         AND NOT EXISTS (SELECT 1 FROM retention_purges r WHERE r.item_id=a.item_id AND r.generation=a.generation AND r.class='analysis_summary')
       GROUP BY a.item_id, a.generation
       ORDER BY a.item_id, a.generation
       LIMIT ?`,
    )
    .all(cutoff, limit)
    .map((row) => ({
      itemId: row.item_id,
      generation: row.generation,
      class: "analysis_summary",
    }));
}

/** Old-enough generations skipped because the item still has unsettled work. */
function countDeferred(
  db: Database,
  extractCutoff: number | null,
  summaryCutoff: number | null,
): number {
  const extracted =
    extractCutoff === null
      ? 0
      : (db
          .query<{ n: number }, [string, number]>(
            `SELECT count(*) n FROM processing_jobs x JOIN items i ON i.id=x.item_id
            WHERE x.stage='extract' AND x.status='done' AND x.outcome='extracted' AND x.result IS NOT NULL AND x.result<>?
              AND x.created_at<=?
              AND ${UNSETTLED_ITEM_SQL}`,
          )
          .get(PURGED_EXTRACTION, extractCutoff)?.n ?? 0);
  const summaries =
    summaryCutoff === null
      ? 0
      : (db
          .query<{ n: number }, [number]>(
            `SELECT count(*) n FROM analyses a JOIN items i ON i.id=a.item_id
          WHERE a.created_at<=? AND a.result<>'{"purged":true}'
            AND a.generation=(SELECT max(g.generation) FROM processing_jobs g WHERE g.item_id=a.item_id AND g.stage='extract')
            AND ${UNSETTLED_ITEM_SQL}`,
          )
          .get(summaryCutoff)?.n ?? 0);
  return extracted + summaries;
}

function activeAnalysisReservation(db: Database): boolean {
  return !!db
    .query(
      "SELECT 1 FROM analysis_reservations WHERE status='reserved' LIMIT 1",
    )
    .get();
}

/**
 * Removes the summary from every copy of the analysis: the analysis row, the
 * completed analyse job and the settled budget reservation. Accounting
 * (tokens, micros, status) is kept. The reservation key is renamed so the
 * original deterministic key is free for a budgeted regeneration and purged
 * results are never returned from the cache.
 */
function purgeAnalysisCopies(
  db: Database,
  itemId: string,
  generation: number,
  now: number,
) {
  const rows = db
    .query<
      {
        id: string;
        input_hash: string;
        provider: string;
        model: string;
        prompt_version: string;
        profiles: string;
        created_at: number;
      },
      [string, number]
    >(
      "SELECT id,input_hash,provider,model,prompt_version,profiles,created_at FROM analyses WHERE item_id=? AND generation=?",
    )
    .all(itemId, generation);
  db.query("UPDATE analyses SET result=? WHERE item_id=? AND generation=?").run(
    PURGED_ANALYSIS,
    itemId,
    generation,
  );
  db.query(
    "UPDATE processing_jobs SET result=? WHERE item_id=? AND stage='analyse' AND generation=? AND status='done' AND result IS NOT NULL",
  ).run(PURGED_ANALYSIS, itemId, generation);
  for (const row of rows) {
    const settled = db
      .query<{ key: string }, [string, string, string, string]>(
        "SELECT key FROM analysis_reservations WHERE status='settled' AND json_valid(result) AND json_extract(result,'$.inputHash')=? AND json_extract(result,'$.provider')=? AND json_extract(result,'$.model')=? AND json_extract(result,'$.promptVersion')=?",
      )
      .all(row.input_hash, row.provider, row.model, row.prompt_version);
    for (const { key } of settled)
      db.query(
        "UPDATE analysis_reservations SET key=?,result=? WHERE key=?",
      ).run(`purged:${key}:${row.id}`, PURGED_ANALYSIS, key);
  }
}

/** Rebuilds one item's FTS row with the same composition as the search triggers. */
function rebuildItemSearch(db: Database, itemId: string) {
  db.query(
    `UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=?1),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=?1 AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=?1 AND stage='extract')),'') || char(10) || coalesce((SELECT json_extract(result,'$.summary') FROM analyses WHERE item_id=?1 AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=?1 AND stage='extract') ORDER BY created_at DESC LIMIT 1),'') WHERE rowid=(SELECT rowid FROM items WHERE id=?1)`,
  ).run(itemId);
}

/**
 * Previews or applies one bounded retention pass. Applying runs in a single
 * short transaction per call and never calls providers. Repeated calls are
 * idempotent: audited generations are never selected again.
 */
export function runRetention(
  db: Database,
  policy: RetentionPolicy,
  now: number,
  options: { dryRun: boolean; limit: number },
): RetentionReport {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1)
    throw new Error("Retention limit must be a positive integer");
  const extractCutoff = retentionCutoff(policy, "extracted_payload", now);
  const summaryCutoff = retentionCutoff(policy, "analysis_summary", now);
  const reservationsActive = activeAnalysisReservation(db);
  const report: RetentionReport = {
    dryRun: options.dryRun,
    policy,
    eligible: { extracted_payload: 0, analysis_summary: 0 },
    purged: { extracted_payload: 0, analysis_summary: 0 },
    deferred: 0,
    analysisReservationsActive: reservationsActive,
    scanned: 0,
    complete: true,
  };
  const work = db.transaction((): void => {
    const extracted =
      extractCutoff === null
        ? []
        : extractedCandidates(db, extractCutoff, options.limit);
    const summaries =
      summaryCutoff === null || reservationsActive
        ? []
        : analysisCandidates(db, summaryCutoff, options.limit);
    const candidates = [...extracted, ...summaries];
    const items = new Set<string>();
    for (const candidate of candidates) {
      items.add(candidate.itemId);
      report.eligible[candidate.class] += 1;
      if (options.dryRun) continue;
      if (candidate.class === "extracted_payload") {
        db.query(
          "UPDATE processing_jobs SET result=? WHERE item_id=? AND stage='extract' AND generation=? AND status='done' AND outcome='extracted'",
        ).run(PURGED_EXTRACTION, candidate.itemId, candidate.generation);
      } else {
        purgeAnalysisCopies(db, candidate.itemId, candidate.generation, now);
      }
      db.query(
        "INSERT INTO retention_purges(item_id,generation,class,purged_at,reason) VALUES(?,?,?,?,'retention')",
      ).run(candidate.itemId, candidate.generation, candidate.class, now);
      report.purged[candidate.class] += 1;
      rebuildItemSearch(db, candidate.itemId);
    }
    report.scanned = items.size;
    report.complete =
      extracted.length < options.limit && summaries.length < options.limit;
  });
  work.immediate();
  // Counting history is unbounded, so it runs after the writer lock is released.
  report.deferred = countDeferred(db, extractCutoff, summaryCutoff);
  return report;
}
