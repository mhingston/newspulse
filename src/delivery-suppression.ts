import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { validateEmailAddress } from "./db/delivery-store";
import { invalidateScores } from "./db/score-queue";

export interface SuppressionAction {
  editionDate: string;
  recipient: string;
  providerId: string;
}
export interface SuppressionContext {
  sender: string;
}

interface FrozenEdition {
  id: string;
  edition_date: string;
  sealed: number;
}
interface OutboxRow {
  id: string;
  digest_id: string;
  status: string;
  provider_id: string | null;
  idempotency_key: string;
  sender: string;
}
interface AuditRow {
  id: string;
  provider_id: string;
}

export type SuppressionOutcome =
  "suppressed_pending" | "suppressed_missing" | "already_suppressed";

const PROVIDER_ID = /^[A-Za-z0-9_-]{1,200}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalize(action: SuppressionAction): SuppressionAction {
  if (!DATE.test(action.editionDate)) throw new Error("Invalid edition date");
  if (!PROVIDER_ID.test(action.providerId))
    throw new Error("Provider acceptance ID required");
  return {
    editionDate: action.editionDate,
    recipient: validateEmailAddress(action.recipient),
    providerId: action.providerId,
  };
}

/**
 * Resolves the suppression without writing. It refuses anything that would
 * fabricate an edition, or that is in an unsettled provider state where a
 * reconciliation (not a suppression) is the correct operator path.
 */
function plan(db: Database, action: SuppressionAction) {
  const edition = db
    .query<FrozenEdition, [string]>(
      "SELECT id,edition_date,sealed FROM digests WHERE edition_date=? AND sealed=1",
    )
    .get(action.editionDate);
  if (!edition) throw new Error("No sealed frozen edition for that date");
  const outbox = db
    .query<OutboxRow, [string, string]>(
      "SELECT id,digest_id,status,provider_id,idempotency_key,sender FROM deliveries WHERE edition_date=? AND recipient=?",
    )
    .get(action.editionDate, action.recipient);
  const audit = db
    .query<AuditRow, [string, string]>(
      "SELECT id,provider_id FROM delivery_suppressions WHERE edition_date=? AND recipient=?",
    )
    .get(action.editionDate, action.recipient);
  if (outbox) {
    if (outbox.digest_id !== edition.id)
      throw new Error("Outbox row belongs to a different frozen edition");
    if (outbox.status === "sent") {
      if (outbox.provider_id !== action.providerId)
        throw new Error(
          "Recipient already has a different accepted provider ID",
        );
      if (!audit)
        throw new Error("Accepted outbox row has no suppression audit");
      return { edition, outbox, audit, outcome: "already_suppressed" as const };
    }
    if (outbox.status !== "pending")
      throw new Error(
        "Delivery is not pending; use delivery reconciliation for an in-flight or failed send",
      );
    if (audit)
      throw new Error("Pending outbox has a conflicting suppression audit");
    return {
      edition,
      outbox,
      audit: null,
      outcome: "suppressed_pending" as const,
    };
  }
  if (audit) {
    if (audit.provider_id !== action.providerId)
      throw new Error("Recipient already has a different accepted provider ID");
    throw new Error("Suppression audit exists without an outbox row");
  }
  return {
    edition,
    outbox: null,
    audit: null,
    outcome: "suppressed_missing" as const,
  };
}

function snapshot(
  db: Database,
  action: SuppressionAction,
  context: SuppressionContext,
  asOf: number,
) {
  if (!Number.isSafeInteger(asOf) || asOf < 0)
    throw new Error("Invalid confirmation time");
  const normal = normalize(action);
  const sender = validateEmailAddress(context.sender);
  const planned = plan(db, normal);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        action: normal,
        asOf,
        edition: planned.edition.id,
        outbox: planned.outbox,
        audit: planned.audit,
        sender,
      }),
    )
    .digest("hex");
  return {
    action: normal,
    outcome: planned.outcome,
    edition: {
      id: planned.edition.id,
      editionDate: planned.edition.edition_date,
    },
    outbox: planned.outbox
      ? { id: planned.outbox.id, status: planned.outbox.status }
      : null,
    confirmation: { asOf, expiresAt: asOf + 300_000, hash },
  };
}

/**
 * Caller must hold the exclusive delivery lock with senders stopped. Preview
 * writes nothing; it only reports what confirmation would record.
 */
export function previewDeliverySuppression(
  db: Database,
  action: SuppressionAction,
  context: SuppressionContext,
  now = Date.now(),
) {
  return db.transaction(() => snapshot(db, action, context, now)).immediate();
}

/**
 * Applies the bound suppression in one short transaction with no provider
 * call. Pending rows become accepted without being resent; a missing row
 * receives an audit-only accepted record tied to the frozen edition.
 */
export function confirmDeliverySuppression(
  db: Database,
  action: SuppressionAction,
  context: SuppressionContext,
  asOf: number,
  hash: string,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(now) || now < asOf || now - asOf > 300_000)
    throw new Error("Delivery suppression confirmation expired");
  db.transaction(() => {
    const preview = snapshot(db, action, context, asOf);
    if (!/^[0-9a-f]{64}$/.test(hash) || hash !== preview.confirmation.hash)
      throw new Error(
        "Delivery suppression confirmation does not match current state",
      );
    const normal = preview.action;
    const sender = validateEmailAddress(context.sender);
    if (preview.outcome === "already_suppressed") return;
    const edition = preview.edition.id;
    if (preview.outcome === "suppressed_pending") {
      const changed = db
        .query(
          "UPDATE deliveries SET status='sent',provider_id=?,last_error=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='pending' AND digest_id=?",
        )
        .run(normal.providerId, now, preview.outbox!.id, edition).changes;
      if (changed !== 1) throw new Error("Delivery changed during suppression");
      recordAudit(db, {
        deliveryId: preview.outbox!.id,
        action: normal,
        digestId: edition,
        priorStatus: "pending",
        outcome: "suppressed_pending",
        payloadHash: hash,
        now,
      });
    } else {
      const id = crypto.randomUUID();
      const key =
        "newspulse/" +
        createHash("sha256")
          .update(JSON.stringify([edition, normal.recipient]))
          .digest("hex");
      db.query(
        "INSERT INTO deliveries(id,digest_id,edition_date,recipient,sender,idempotency_key,status,attempts,available_at,provider_id,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,'sent',0,?,?,'operator_suppressed',?,?)",
      ).run(
        id,
        edition,
        normal.editionDate,
        normal.recipient,
        sender,
        key,
        now,
        normal.providerId,
        now,
        now,
      );
      recordAudit(db, {
        deliveryId: id,
        action: normal,
        digestId: edition,
        priorStatus: null,
        outcome: "suppressed_missing",
        payloadHash: hash,
        now,
      });
    }
    invalidateScores(db, now);
  }).immediate();
}

function recordAudit(
  db: Database,
  input: {
    deliveryId: string;
    action: SuppressionAction;
    digestId: string;
    priorStatus: string | null;
    outcome: SuppressionOutcome;
    payloadHash: string;
    now: number;
  },
) {
  db.query(
    "INSERT INTO delivery_suppressions(id,delivery_id,edition_date,recipient,digest_id,provider_id,prior_status,outcome,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    crypto.randomUUID(),
    input.deliveryId,
    input.action.editionDate,
    input.action.recipient,
    input.digestId,
    input.action.providerId,
    input.priorStatus,
    input.outcome,
    input.payloadHash,
    input.now,
  );
}
