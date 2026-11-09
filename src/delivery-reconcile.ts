import { createHash } from "node:crypto";
import { DeliveryStore } from "./db/delivery-store";
import type { Database } from "bun:sqlite";

export type DeliveryResolution = "accepted" | "not_sent";
export interface Reconciliation {
  id: string;
  resolution: DeliveryResolution;
  providerId: string | null;
}

function snapshot(db: Database, action: Reconciliation, asOf: number) {
  if (!Number.isSafeInteger(asOf) || asOf < 0)
    throw new Error("Invalid confirmation time");
  if (action.resolution !== "accepted" && action.resolution !== "not_sent")
    throw new Error("Invalid resolution");
  if (
    action.resolution === "accepted" &&
    (!action.providerId || !/^[A-Za-z0-9_-]{1,200}$/.test(action.providerId))
  )
    throw new Error("Provider ID required");
  if (action.resolution === "not_sent" && action.providerId !== null)
    throw new Error("Unexpected provider ID");
  const delivery = new DeliveryStore(db).get(action.id);
  if (
    !delivery ||
    (delivery.status !== "ambiguous" && delivery.status !== "failed")
  )
    throw new Error("Delivery is not eligible for reconciliation");
  const hash = createHash("sha256")
    .update(JSON.stringify({ action, asOf, delivery }))
    .digest("hex");
  return {
    action,
    delivery,
    confirmation: { asOf, expiresAt: asOf + 300_000, hash },
  };
}
export function previewDeliveryReconciliation(
  db: Database,
  action: Reconciliation,
  now = Date.now(),
) {
  return snapshot(db, action, now);
}
export function confirmDeliveryReconciliation(
  db: Database,
  action: Reconciliation,
  asOf: number,
  hash: string,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(now) || now < asOf || now - asOf > 300_000)
    throw new Error("Delivery confirmation expired");
  db.transaction(() => {
    const preview = snapshot(db, action, asOf);
    if (!/^[0-9a-f]{64}$/.test(hash) || hash !== preview.confirmation.hash)
      throw new Error("Delivery confirmation does not match current state");
    new DeliveryStore(db).reconcile(
      action.id,
      action.resolution,
      action.providerId,
      now,
    );
  }).immediate();
}
