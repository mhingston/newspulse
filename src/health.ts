import type { Database } from "bun:sqlite";

/**
 * Read-only operational health derived from persisted state. Thresholds are
 * conservative defaults; they flag work for review and never change state.
 */
export const HEALTH_THRESHOLDS = {
  stuckAfterMs: 15 * 60_000,
  failingSourceFailures: 3,
  queueAgeWarnMs: 60 * 60_000,
} as const;

export interface HealthReport {
  checked_at: number;
  ready: boolean;
  stuck_stages: {
    stage: string;
    status: string;
    count: number;
    oldest_age_ms: number;
  }[];
  failing_sources: {
    source_id: string;
    title: string;
    failures: number;
    last_error: string | null;
  }[];
  ambiguous_deliveries: { count: number };
  /** Lifetime delivery counts by status; ambiguous sends are never resent automatically. */
  delivery_outcomes: { status: string; count: number }[];
  /** Lifetime discovery (search) queries and reserved cost; unknown cost is never zero. */
  search_spend: { queries: number; reserved_cost_micros: number };
  queue: { stage: string; pending: number; oldest_age_ms: number | null }[];
  analysis_cost: {
    analyses: number;
    known_cost_micros: number;
    unknown_cost_count: number;
  };
  analysis_envelope_breach: boolean;
  warnings: string[];
}

export interface HealthOptions {
  /** Stages whose queues are intentionally idle (e.g. analysis disabled). */
  enabledStages?: readonly string[];
}

/**
 * Credential-free source label. Feed titles default to the feed URL, which can
 * carry tokens in its query string, so anything URL-shaped is redacted.
 */
export function safeLabel(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, (match) => {
    try {
      const url = new URL(match);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "[redacted-url]";
    }
  });
}

export function healthReport(
  db: Database,
  now = Date.now(),
  options: HealthOptions = {},
): HealthReport {
  const enabled = options.enabledStages
    ? new Set(options.enabledStages)
    : undefined;
  const stuck = db
    .query<
      { stage: string; status: string; count: number; oldest: number | null },
      [number]
    >(
      "SELECT stage,status,count(*) AS count,min(available_at) AS oldest FROM processing_jobs WHERE status='running' AND lease_until<? GROUP BY stage,status",
    )
    .all(now)
    .map((row) => ({
      stage: row.stage,
      status: "expired_lease",
      count: row.count,
      oldest_age_ms: row.oldest == null ? 0 : Math.max(0, now - row.oldest),
    }));

  const failing = db
    .query<
      {
        source_id: string;
        title: string;
        failures: number;
        last_error: string | null;
      },
      [number]
    >(
      "SELECT id AS source_id,title,failures,last_error FROM sources WHERE removed=0 AND enabled=1 AND failures>=? ORDER BY failures DESC,title,id LIMIT 50",
    )
    .all(HEALTH_THRESHOLDS.failingSourceFailures)
    .map((row) => ({
      ...row,
      title: safeLabel(row.title),
      last_error: row.last_error == null ? null : safeLabel(row.last_error),
    }));

  const ambiguous = db
    .query<{ count: number }, []>(
      "SELECT count(*) AS count FROM deliveries WHERE status='ambiguous'",
    )
    .get()!.count;

  const delivery_outcomes = db
    .query<{ status: string; count: number }, []>(
      "SELECT status, count(*) AS count FROM deliveries GROUP BY status ORDER BY status",
    )
    .all();

  const search = db
    .query<{ queries: number; micros: number }, []>(
      "SELECT count(*) AS queries, coalesce(sum(reserved_cost_micros),0) AS micros FROM discovery_pages",
    )
    .get()!;

  const queue = db
    .query<{ stage: string; pending: number; oldest: number | null }, []>(
      "SELECT stage,count(*) AS pending,min(coalesce(queued_at,available_at)) AS oldest FROM processing_jobs WHERE status='pending' GROUP BY stage ORDER BY stage",
    )
    .all()
    .map((row) => ({
      stage: row.stage,
      pending: row.pending,
      oldest_age_ms: row.oldest == null ? null : Math.max(0, now - row.oldest),
    }));

  // A reused analysis is a copy of an earlier billed call, so cost is counted
  // once per provider request identity (the earliest row), not once per row.
  const cost = db
    .query<{ analyses: number; known: number; unknown: number }, []>(
      `SELECT count(*) AS analyses,
        coalesce(sum(CASE WHEN first_row=1 THEN cost ELSE 0 END),0) AS known,
        coalesce(sum(CASE WHEN first_row=1 AND cost IS NULL THEN 1 ELSE 0 END),0) AS unknown
       FROM (
         SELECT cost, row_number() OVER (
           PARTITION BY item_id,input_hash,provider,model,prompt_version,profiles
           ORDER BY created_at, id
         ) AS first_row
         FROM analyses
       )`,
    )
    .get()!;

  const breach = !!db
    .query<{ envelope_breach: number }, []>(
      "SELECT envelope_breach FROM analysis_control WHERE id=1",
    )
    .get()?.envelope_breach;

  const warnings: string[] = [];
  if (stuck.length) warnings.push("expired_leases");
  if (failing.length) warnings.push("failing_sources");
  if (ambiguous) warnings.push("ambiguous_deliveries");
  if (breach) warnings.push("analysis_envelope_breach");
  if (
    queue.some(
      (q) =>
        (!enabled || enabled.has(q.stage)) &&
        q.oldest_age_ms != null &&
        q.oldest_age_ms > HEALTH_THRESHOLDS.queueAgeWarnMs,
    )
  )
    warnings.push("queue_age");

  return {
    checked_at: now,
    ready: warnings.length === 0,
    stuck_stages: stuck,
    failing_sources: failing,
    ambiguous_deliveries: { count: ambiguous },
    delivery_outcomes,
    search_spend: {
      queries: search.queries,
      reserved_cost_micros: search.micros,
    },
    queue,
    analysis_cost: {
      analyses: cost.analyses,
      known_cost_micros: cost.known,
      unknown_cost_count: cost.unknown,
    },
    analysis_envelope_breach: !!breach,
    warnings,
  };
}
