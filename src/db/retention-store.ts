import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  PURGED_ANALYSIS,
  PURGED_EXTRACTION,
  PURGED_INBOUND_BODY,
  retentionCutoff,
  type RetentionClass,
  type RetentionPolicy,
} from "../retention";

/**
 * Deterministic fingerprint of a body's original text. It is recorded when a
 * purge destroys the text so a later re-poll can still tell an unchanged body
 * from a changed one; it is not a security boundary, only a change signal.
 */
export function contentFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Marks an observation that was purged while already empty, so it stays
 * distinguishable from a legacy tombstone whose text was destroyed before
 * fingerprints existed and whose body is therefore unknown.
 */
export const EMPTY_CONTENT_FINGERPRINT = contentFingerprint("");

export interface RetentionCandidate {
  itemId: string;
  generation: number;
  class: RetentionClass;
}

/** Inbound bodies are retained per message; they have no extraction generation. */
export interface InboundBodyCandidate {
  messageId: string;
  itemId: string;
}

/** A feed-text row (`content` and `content_versions`) selected by age; never by generation. */
export interface FeedTextCandidate {
  itemId: string;
  observedAt: number;
}

export interface RetentionReport {
  dryRun: boolean;
  policy: RetentionPolicy;
  eligible: Record<RetentionClass, number>;
  purged: Record<RetentionClass, number>;
  /** Indexed inbound bodies selected for, or purged by, this pass. */
  inboundBodies: { eligible: number; purged: number };
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
  feedTextCutoff: number | null,
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
  const feedText =
    feedTextCutoff === null
      ? 0
      : (db
          .query<{ n: number }, [number]>(
            `SELECT count(*) n FROM (
              SELECT c.item_id FROM content c
                JOIN items i ON i.id=c.item_id
                JOIN content_versions v ON v.item_id=c.item_id
               WHERE c.purged_at IS NULL AND c.text<>''
                 AND ${UNSETTLED_ITEM_SQL}
               GROUP BY c.item_id
               HAVING max(v.observed_at)<=?)`,
          )
          .get(feedTextCutoff)?.n ?? 0);
  return extracted + summaries + feedText;
}

/**
 * Inbound bodies that have been indexed (`item_id` set) and whose message is
 * complete with no lease. Unindexed, failed, pending, running or retrying
 * messages keep their body because the index step still reads it, and an
 * ambiguous or in-flight retrieval must never lose its evidence.
 */
function inboundBodyCandidates(
  db: Database,
  cutoff: number,
  limit: number,
): InboundBodyCandidate[] {
  return db
    .query<{ id: string; item_id: string }, [string, number, number]>(
      `SELECT m.id, m.item_id FROM inbound_messages m
        WHERE m.status='complete' AND m.item_id IS NOT NULL AND m.body IS NOT NULL
          AND m.lease_until IS NULL
          AND m.body<>?
          AND m.received_at<=?
        ORDER BY m.id
        LIMIT ?`,
    )
    .all(PURGED_INBOUND_BODY, cutoff, limit)
    .map((row) => ({ messageId: row.id, itemId: row.item_id }));
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

/**
 * Feed text whose content is settled (no unsettled processing job, including
 * grouping, and a completed score) and whose versions are all older than the
 * cutoff. Rows are identified by item, so each item is selected at most once
 * per pass and an already-purged item is never selected again.
 */
function feedTextCandidates(
  db: Database,
  cutoff: number,
  limit: number,
): FeedTextCandidate[] {
  return db
    .query<{ item_id: string; observed_at: number }, [number, number]>(
      `SELECT c.item_id AS item_id, max(v.observed_at) AS observed_at
         FROM content c
         JOIN items i ON i.id=c.item_id
         JOIN content_versions v ON v.item_id=c.item_id
        WHERE c.purged_at IS NULL AND c.text<>''
          AND ${SETTLED_ITEM_SQL}
          AND EXISTS (SELECT 1 FROM processing_jobs s WHERE s.item_id=c.item_id AND s.stage='score' AND s.status='done')
        GROUP BY c.item_id
        HAVING max(v.observed_at)<=?
        ORDER BY c.item_id
        LIMIT ?`,
    )
    .all(cutoff, limit)
    .map((row) => ({ itemId: row.item_id, observedAt: row.observed_at }));
}

/** Bounds tombstone fingerprinting per pass so hashing never dominates the write lock. */
const FINGERPRINT_VERSION_LIMIT = 512;
const FINGERPRINT_BYTE_LIMIT = 8 * 1024 * 1024;

interface FingerprintBudget {
  versions: number;
  bytes: number;
}

/**
 * Records fingerprints for an item's unpurged versions before their text is
 * destroyed: the hash of each body still held, and the empty fingerprint for
 * observations that were already empty, so a later body from the same source
 * stays comparable. Legacy tombstones (purged before fingerprints existed) are
 * never given one. The work is bounded by the pass budget; the byte budget may
 * be exceeded by one version so a single oversized body still makes progress.
 * Returns false when versions remain unprocessed and the purge must wait for a
 * later pass.
 */
function fingerprintBeforePurge(
  db: Database,
  itemId: string,
  budget: FingerprintBudget,
): boolean {
  const next = db.query<{ id: number; text: string }, [string]>(
    "SELECT id,text FROM content_versions WHERE item_id=? AND purged_at IS NULL AND text_fingerprint IS NULL ORDER BY id LIMIT 1",
  );
  const record = db.query(
    "UPDATE content_versions SET text_fingerprint=? WHERE id=? AND text_fingerprint IS NULL",
  );
  for (;;) {
    const row = next.get(itemId);
    if (!row) return true;
    if (budget.versions <= 0 || budget.bytes < 0) return false;
    record.run(contentFingerprint(row.text), row.id);
    budget.versions -= 1;
    budget.bytes -= row.text.length;
  }
}

/**
 * Clears the content and every version's text and marks each row purged. Rows
 * stay so identity, observation timestamps, source references and the
 * observed-update history remain; comparison readers exclude purged rows, and
 * every version's fingerprint was recorded by fingerprintBeforePurge before
 * this runs. Each purge cycle writes its own audit row, so a restored body
 * that is later removed again records the later removal time.
 */
function purgeFeedText(db: Database, itemId: string, now: number) {
  db.query(
    "UPDATE content SET text='',purged_at=? WHERE item_id=? AND purged_at IS NULL",
  ).run(now, itemId);
  db.query(
    "UPDATE content_versions SET text='',purged_at=? WHERE item_id=? AND purged_at IS NULL",
  ).run(now, itemId);
  const cycle = db
    .query<{ n: number }, [string]>(
      "SELECT coalesce(max(generation)+1,0) AS n FROM retention_purges WHERE item_id=? AND class='feed_text'",
    )
    .get(itemId)!.n;
  db.query(
    "INSERT INTO retention_purges(item_id,generation,class,purged_at,reason) VALUES(?,?,'feed_text',?,'retention')",
  ).run(itemId, cycle, now);
}

/** Rebuilds one item's FTS row with the same composition as the search triggers. */
function rebuildItemSearch(db: Database, itemId: string) {
  db.query(
    `UPDATE items_fts SET text=coalesce((SELECT text FROM content WHERE item_id=?1),'') || char(10) || coalesce((SELECT CASE WHEN json_valid(result) THEN json_extract(result,'$.text') ELSE NULL END FROM processing_jobs WHERE item_id=?1 AND stage='extract' AND status='done' AND outcome='extracted' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=?1 AND stage='extract')),'') || char(10) || coalesce((SELECT json_extract(result,'$.summary') FROM analyses WHERE item_id=?1 AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=?1 AND stage='extract') ORDER BY created_at DESC LIMIT 1),'') WHERE rowid=(SELECT rowid FROM items WHERE id=?1)`,
  ).run(itemId);
}

/**
 * Previews or applies one bounded retention pass. Applying runs in a single
 * short transaction per call and never calls providers; tombstone hashing is
 * bounded by versions and bytes so it cannot stretch that transaction.
 * Repeated calls are idempotent: audited generations are never selected again.
 */
export function runRetention(
  db: Database,
  policy: RetentionPolicy,
  now: number,
  options: {
    dryRun: boolean;
    limit: number;
    /** Test hook: overrides the per-pass tombstone fingerprinting budget. */
    fingerprintBudget?: FingerprintBudget;
  },
): RetentionReport {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1)
    throw new Error("Retention limit must be a positive integer");
  const extractCutoff = retentionCutoff(policy, "extracted_payload", now);
  const summaryCutoff = retentionCutoff(policy, "analysis_summary", now);
  const bodyCutoff = retentionCutoff(policy, "inbound_body", now);
  const feedTextCutoff = retentionCutoff(policy, "feed_text", now);
  const reservationsActive = activeAnalysisReservation(db);
  const budget = options.fingerprintBudget ?? {
    versions: FINGERPRINT_VERSION_LIMIT,
    bytes: FINGERPRINT_BYTE_LIMIT,
  };
  let fingerprintDeferred = 0;
  const report: RetentionReport = {
    dryRun: options.dryRun,
    policy,
    eligible: { extracted_payload: 0, analysis_summary: 0, feed_text: 0 },
    purged: { extracted_payload: 0, analysis_summary: 0, feed_text: 0 },
    inboundBodies: { eligible: 0, purged: 0 },
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
    const bodies =
      bodyCutoff === null
        ? []
        : inboundBodyCandidates(db, bodyCutoff, options.limit);
    const items = new Set<string>();
    for (const body of bodies) {
      items.add(body.itemId);
      report.inboundBodies.eligible += 1;
      if (options.dryRun) continue;
      // Re-checked in the write statement: a message leased or changed since selection is skipped.
      const changed = db
        .query(
          "UPDATE inbound_messages SET body=?,updated_at=? WHERE id=? AND status='complete' AND lease_until IS NULL AND body IS NOT NULL AND body<>? AND item_id IS NOT NULL",
        )
        .run(
          PURGED_INBOUND_BODY,
          now,
          body.messageId,
          PURGED_INBOUND_BODY,
        ).changes;
      report.inboundBodies.purged += changed;
      if (changed > 0) {
        db.query(
          "INSERT OR IGNORE INTO retention_purges(item_id,generation,class,purged_at,reason) VALUES(?,0,'inbound_body',?,'retention')",
        ).run(body.itemId, now);
        rebuildItemSearch(db, body.itemId);
      }
    }
    const feedText =
      feedTextCutoff === null
        ? []
        : feedTextCandidates(db, feedTextCutoff, options.limit);
    report.eligible.feed_text = feedText.length;
    if (!options.dryRun)
      for (const row of feedText) {
        items.add(row.itemId);
        // Fingerprint first: an item whose tombstone is not fully prepared
        // waits for a later pass instead of losing text uncomparably.
        if (!fingerprintBeforePurge(db, row.itemId, budget)) {
          fingerprintDeferred += 1;
          continue;
        }
        purgeFeedText(db, row.itemId, now);
        report.purged.feed_text += 1;
        rebuildItemSearch(db, row.itemId);
      }
    for (const row of feedText) items.add(row.itemId);
    const candidates = [...extracted, ...summaries];
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
      extracted.length < options.limit &&
      summaries.length < options.limit &&
      bodies.length < options.limit &&
      feedText.length < options.limit &&
      fingerprintDeferred === 0;
  });
  work.immediate();
  // Counting history is unbounded, so it runs after the writer lock is released.
  report.deferred =
    countDeferred(db, extractCutoff, summaryCutoff, feedTextCutoff) +
    fingerprintDeferred;
  return report;
}
