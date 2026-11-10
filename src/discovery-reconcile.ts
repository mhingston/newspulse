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
