import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

// Resend retains keys for 24 hours; stop early to leave room for request time and clock drift.
export const DELIVERY_RETRY_WINDOW = 23 * 60 * 60_000;
export const DELIVERY_MAX_ATTEMPTS = 10;
const LEASE = 60_000;
const RETRY = 60_000;
export interface Delivery {
  id: string;
  digest_id: string;
  edition_date: string;
  recipient: string;
  sender: string;
  idempotency_key: string;
  status: string;
  attempts: number;
  available_at: number;
  first_attempt_at: number | null;
  lease_until: number | null;
  lease_token: string | null;
  provider_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
export interface DeliveryClaim extends Delivery {
  lease_token: string;
}

export function validateEmailAddress(value: string): string {
  if (
    value.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(
      value,
    ) ||
    value.includes("..")
  )
    throw new Error("Invalid email address");
  const at = value.lastIndexOf("@");
  return value.slice(0, at + 1) + value.slice(at + 1).toLowerCase();
}

export class DeliveryStore {
  constructor(private readonly db: Database) {}
  list(): Delivery[] {
    return this.db
      .query<Delivery, []>("SELECT * FROM deliveries ORDER BY created_at,id")
      .all();
  }
  get(id: string): Delivery | null {
    return this.db
      .query<Delivery, [string]>("SELECT * FROM deliveries WHERE id=?")
      .get(id);
  }
  prepare(
    date: string,
    recipient: string,
    sender: string,
    freeze: () => { id: string } | null,
    now = Date.now(),
  ): Delivery | null {
    recipient = validateEmailAddress(recipient);
    sender = validateEmailAddress(sender);
    return this.db
      .transaction(() => {
        const prior = this.db
          .query<Delivery, [string, string]>(
            "SELECT * FROM deliveries WHERE edition_date=? AND recipient=?",
          )
          .get(date, recipient);
        if (prior) return prior;
        const digest = freeze();
        if (!digest) return null;
        const valid = this.db
          .query<{ id: string }, [string, string]>(
            "SELECT id FROM digests WHERE id=? AND edition_date=? AND sealed=1",
          )
          .get(digest.id, date);
        if (!valid)
          throw new Error("Delivery requires a sealed edition for its date");
        const id = crypto.randomUUID();
        const key =
          "newspulse/" +
          createHash("sha256")
            .update(JSON.stringify([digest.id, recipient]))
            .digest("hex");
        this.db
          .query(
            "INSERT INTO deliveries(id,digest_id,edition_date,recipient,sender,idempotency_key,status,attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',0,?,?,?)",
          )
          .run(id, digest.id, date, recipient, sender, key, now, now, now);
        return this.get(id)!;
      })
      .immediate();
  }
  claim(now = Date.now()): DeliveryClaim | null {
    return this.db
      .transaction(() => {
        // An expired sending lease is ambiguous, even if the process died before calling the provider.
        this.db
          .query(
            "UPDATE deliveries SET status=CASE WHEN first_attempt_at IS NULL THEN 'pending' ELSE 'ambiguous' END,lease_token=NULL,lease_until=NULL,last_error='lease_expired',updated_at=? WHERE status='sending' AND lease_until<=?",
          )
          .run(now, now);
        // A crash before the first provider call is safe but must not spin forever.
        this.db
          .query(
            "UPDATE deliveries SET status='failed',last_error='attempts_exhausted',updated_at=? WHERE status='pending' AND attempts>=?",
          )
          .run(now, DELIVERY_MAX_ATTEMPTS);
        const row = this.db
          .query<Delivery, [number, number, number]>(
            "SELECT * FROM deliveries WHERE (status='pending' OR (status='ambiguous' AND first_attempt_at IS NOT NULL AND first_attempt_at>?)) AND available_at<=? AND attempts<? ORDER BY available_at,id LIMIT 1",
          )
          .get(now - DELIVERY_RETRY_WINDOW, now, DELIVERY_MAX_ATTEMPTS);
        if (!row) return null;
        const token = crypto.randomUUID();
        this.db
          .query(
            "UPDATE deliveries SET status='sending',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?",
          )
          .run(token, now + LEASE, now, row.id);
        return this.get(row.id) as DeliveryClaim;
      })
      .immediate();
  }
  beginSend(claim: DeliveryClaim, now = Date.now()) {
    const result = this.db
      .query(
        "UPDATE deliveries SET first_attempt_at=COALESCE(first_attempt_at,?),updated_at=? WHERE id=? AND status='sending' AND lease_token=? AND lease_until>? AND (first_attempt_at IS NULL OR first_attempt_at>?)",
      )
      .run(
        now,
        now,
        claim.id,
        claim.lease_token,
        now,
        now - DELIVERY_RETRY_WINDOW,
      );
    return result.changes === 1;
  }
  message(claim: DeliveryClaim) {
    return this.db
      .query<
        {
          from: string;
          to: string;
          subject: string;
          html: string;
          text: string;
        },
        [string, string]
      >(
        "SELECT d.sender AS 'from',d.recipient AS 'to',g.subject,g.html,g.plain_text AS text FROM deliveries d JOIN digests g ON g.id=d.digest_id WHERE d.id=? AND d.lease_token=? AND d.status='sending' AND g.sealed=1",
      )
      .get(claim.id, claim.lease_token);
  }
  sent(claim: DeliveryClaim, providerId: string, now = Date.now()) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(providerId))
      throw new Error("Invalid provider ID");
    return (
      this.db
        .query(
          "UPDATE deliveries SET status='sent',provider_id=?,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='sending' AND lease_token=? AND lease_until>?",
        )
        .run(providerId, now, claim.id, claim.lease_token, now).changes === 1
    );
  }
  fail(claim: DeliveryClaim, kind: "rejected" | "ambiguous", now = Date.now()) {
    return (
      this.db
        .query(
          "UPDATE deliveries SET status=?,available_at=?,lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND status='sending' AND lease_token=? AND lease_until>?",
        )
        .run(
          kind === "rejected" ? "failed" : "ambiguous",
          now + RETRY,
          kind,
          now,
          claim.id,
          claim.lease_token,
          now,
        ).changes === 1
    );
  }
  reconcile(
    id: string,
    resolution: "accepted" | "not_sent",
    providerId: string | null,
    now = Date.now(),
  ) {
    if (
      resolution === "accepted" &&
      (!providerId || !/^[A-Za-z0-9_-]{1,200}$/.test(providerId))
    )
      throw new Error("Provider ID required");
    if (resolution === "not_sent" && providerId !== null)
      throw new Error("Unexpected provider ID");
    const result = this.db
      .query(
        "UPDATE deliveries SET status=?,provider_id=?,first_attempt_at=?,available_at=?,last_error=?,updated_at=?,attempts=CASE WHEN ?='not_sent' THEN 0 ELSE attempts END WHERE id=? AND status IN ('ambiguous','failed')",
      )
      .run(
        resolution === "accepted" ? "sent" : "pending",
        providerId,
        resolution === "not_sent" ? null : now,
        now,
        `operator_${resolution}`,
        now,
        resolution,
        id,
      );
    if (result.changes !== 1)
      throw new Error("Delivery is not eligible for reconciliation");
  }
}
