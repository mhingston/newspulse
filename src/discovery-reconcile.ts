import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

/** Caller must hold the exclusive discovery lock, with other clients stopped. */
export function previewDiscoveryReconciliation(
  db: Database,
  id: string,
  now = Date.now(),
) {
  if (!id || id.length > 128 || !Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid discovery reconciliation");
  const page = db
    .query<
      {
        id: string;
        run_id: string;
        cursor: string | null;
        budget_day: number;
        reserved_results: number;
        reserved_cost_micros: number;
        started_at: number;
        run_status: string;
        provider: string;
      },
      [string]
    >(
      `SELECT p.id,p.run_id,p.cursor,p.budget_day,p.reserved_results,p.reserved_cost_micros,p.started_at,r.status AS run_status,r.provider
    FROM discovery_pages p JOIN discovery_runs r ON r.id=p.run_id
    WHERE p.id=? AND p.status='reserved' AND r.status='running'`,
    )
    .get(id);
  if (!page)
    throw new Error("Discovery page is not eligible for reconciliation");
  const action = { id, resolution: "outcome_unknown" };
  const hash = createHash("sha256")
    .update(JSON.stringify({ action, asOf: now, page }))
    .digest("hex");
  return {
    action,
    page,
    confirmation: { asOf: now, expiresAt: now + 300_000, hash },
  };
}

/** Retire an unknown in-flight page without refunding its reservation or retrying it. */
export function confirmDiscoveryReconciliation(
  db: Database,
  id: string,
  asOf: number,
  hash: string,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(asOf) ||
    asOf < 0 ||
    !Number.isSafeInteger(now) ||
    now < asOf ||
    now - asOf > 300_000
  )
    throw new Error("Discovery confirmation expired");
  db.transaction(() => {
    const preview = previewDiscoveryReconciliation(db, id, asOf);
    if (!/^[0-9a-f]{64}$/.test(hash) || hash !== preview.confirmation.hash)
      throw new Error("Discovery confirmation does not match current state");
    const changed = db
      .query(
        "UPDATE discovery_pages SET status='failed',finished_at=?,latency_ms=max(0,?-started_at),last_error='outcome_unknown' WHERE id=? AND status='reserved'",
      )
      .run(now, now, id).changes;
    if (changed !== 1) throw new Error("Discovery page changed");
    db.query(
      "UPDATE discovery_runs SET status='failed',finished_at=?,last_error='outcome_unknown' WHERE id=? AND status='running'",
    ).run(now, preview.page.run_id);
  }).immediate();
}

/** Caller must hold the exclusive discovery lock and ensure all clients are stopped. */
export function previewInterruptedDiscoveryRun(
  db: Database,
  id: string,
  now = Date.now(),
) {
  if (!id || id.length > 128 || !Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid discovery reconciliation");
  const run = db
    .query<
      {
        id: string;
        query: string;
        provider: string;
        provider_version: string;
        started_at: number;
        status: string;
      },
      [string]
    >(
      "SELECT id,query,provider,provider_version,started_at,status FROM discovery_runs WHERE id=? AND status='running'",
    )
    .get(id);
  if (!run) throw new Error("Discovery run is not eligible for reconciliation");
  const pages = db
    .query<
      {
        id: string;
        status: string;
        cursor: string | null;
        next_cursor: string | null;
        reserved_results: number;
        reserved_cost_micros: number;
        started_at: number;
        finished_at: number | null;
      },
      [string]
    >(
      "SELECT id,status,cursor,next_cursor,reserved_results,reserved_cost_micros,started_at,finished_at FROM discovery_pages WHERE run_id=? ORDER BY id LIMIT 101",
    )
    .all(id);
  if (pages.length > 100 || pages.some((page) => page.status === "reserved"))
    throw new Error("Discovery run has reserved pages or too many pages");
  const action = { id, resolution: "interrupted" };
  const hash = createHash("sha256")
    .update(JSON.stringify({ action, asOf: now, run, pages }))
    .digest("hex");
  return {
    action,
    run,
    pages,
    confirmation: { asOf: now, expiresAt: now + 300_000, hash },
  };
}

/** Retire a run interrupted between pages or before finalization, without claiming completion. */
export function confirmInterruptedDiscoveryRun(
  db: Database,
  id: string,
  asOf: number,
  hash: string,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(asOf) ||
    asOf < 0 ||
    !Number.isSafeInteger(now) ||
    now < asOf ||
    now - asOf > 300_000
  )
    throw new Error("Discovery confirmation expired");
  db.transaction(() => {
    const preview = previewInterruptedDiscoveryRun(db, id, asOf);
    if (!/^[a-f0-9]{64}$/.test(hash) || hash !== preview.confirmation.hash)
      throw new Error("Discovery confirmation does not match current state");
    const changed = db
      .query(
        "UPDATE discovery_runs SET status='failed',finished_at=?,last_error='interrupted' WHERE id=? AND status='running'",
      )
      .run(now, id).changes;
    if (changed !== 1) throw new Error("Discovery run changed");
  }).immediate();
}
