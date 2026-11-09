import type { Database } from "bun:sqlite";
import type {
  InboundEmailMetadata,
  ReceivedEmail,
  VerifiedInboundEvent,
} from "../inbound";

/** Body and metadata remain untrusted source data. */
export type InboundMetadata = InboundEmailMetadata;
export interface InboundJob {
  id: string;
  provider: string;
  providerId: string;
  attempts: number;
  leaseToken: string;
}
export interface ReconciliationJob {
  provider: string;
  state: unknown;
  leaseToken: string;
}
function identity(value: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error("Invalid inbound identity");
}
function time(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid inbound time");
}
function serialized(value: unknown, limit: number): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > limit)
    throw new Error("Invalid inbound payload");
  return encoded;
}
function errorCode(value: string): string {
  if (!/^[a-z0-9_]{1,80}$/.test(value))
    throw new Error("Invalid inbound error code");
  return value;
}
function duration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86400000)
    throw new Error("Invalid inbound duration");
}

/** Durable inbox and cursor transactions. Provider calls must occur outside this class. */
export class InboundStore {
  constructor(private readonly db: Database) {}
  private enqueue(
    provider: string,
    metadata: InboundMetadata,
    now: number,
  ): { id: string; inserted: boolean } {
    identity(provider);
    identity(metadata.providerId);
    time(metadata.receivedAt);
    const data = serialized(metadata, 65536),
      id = crypto.randomUUID();
    const inserted =
      this.db
        .query(
          "INSERT OR IGNORE INTO inbound_messages(id,provider,provider_id,received_at,metadata,status,available_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)",
        )
        .run(
          id,
          provider,
          metadata.providerId,
          metadata.receivedAt,
          data,
          now,
          now,
        ).changes === 1;
    const existing = this.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM inbound_messages WHERE provider=? AND provider_id=?",
      )
      .get(provider, metadata.providerId)!;
    return { id: existing.id, inserted };
  }
  recordEvent(provider: string, event: VerifiedInboundEvent, now = Date.now()) {
    identity(provider);
    identity(event.eventId);
    time(now);
    return this.db
      .transaction(() => {
        const previous = this.db
          .query<{ provider_id: string }, [string, string]>(
            "SELECT m.provider_id FROM inbound_events e JOIN inbound_messages m ON m.id=e.message_id WHERE e.provider=? AND e.event_id=?",
          )
          .get(provider, event.eventId);
        if (previous) {
          if (previous.provider_id !== event.metadata.providerId)
            throw new Error("Inbound event identity conflict");
          return { eventInserted: false, messageInserted: false };
        }
        const message = this.enqueue(provider, event.metadata, now);
        this.db
          .query(
            "INSERT INTO inbound_events(id,provider,event_id,message_id,received_at,metadata) VALUES(?,?,?,?,?,?)",
          )
          .run(
            crypto.randomUUID(),
            provider,
            event.eventId,
            message.id,
            now,
            serialized(event.metadata, 65536),
          );
        return { eventInserted: true, messageInserted: message.inserted };
      })
      .immediate();
  }
  claimMessage(now = Date.now(), leaseMs = 60000): InboundJob | null {
    time(now);
    duration(leaseMs);
    return this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE inbound_messages SET status='pending',lease_until=NULL,lease_token=NULL,last_error='lease_expired',updated_at=? WHERE id=(SELECT id FROM inbound_messages WHERE status='running' AND lease_until<=? ORDER BY lease_until,id LIMIT 1)",
          )
          .run(now, now);
        const row = this.db
          .query<
            {
              id: string;
              provider: string;
              provider_id: string;
              attempts: number;
              lease_token: string;
            },
            [string, number, number, number]
          >(
            "UPDATE inbound_messages SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=(SELECT id FROM inbound_messages WHERE status='pending' AND available_at<=? ORDER BY available_at,id LIMIT 1) RETURNING id,provider,provider_id,attempts,lease_token",
          )
          .get(crypto.randomUUID(), now + leaseMs, now, now);
        return row
          ? {
              id: row.id,
              provider: row.provider,
              providerId: row.provider_id,
              attempts: row.attempts,
              leaseToken: row.lease_token,
            }
          : null;
      })
      .immediate();
  }
  renewMessage(job: InboundJob, leaseMs: number, now = Date.now()): boolean {
    time(now);
    duration(leaseMs);
    return (
      this.db
        .query(
          "UPDATE inbound_messages SET lease_until=?,updated_at=? WHERE id=? AND provider=? AND provider_id=? AND status='running' AND lease_token=? AND lease_until>?",
        )
        .run(
          now + leaseMs,
          now,
          job.id,
          job.provider,
          job.providerId,
          job.leaseToken,
          now,
        ).changes === 1
    );
  }
  completeMessage(
    job: InboundJob,
    email: ReceivedEmail,
    now = Date.now(),
  ): boolean {
    time(now);
    if (email.metadata.providerId !== job.providerId)
      throw new Error("Inbound message identity mismatch");
    const payload = serialized(email, 5000000);
    return (
      this.db
        .query(
          "UPDATE inbound_messages SET status='complete',body=?,lease_until=NULL,lease_token=NULL,last_error=NULL,updated_at=? WHERE id=? AND provider=? AND provider_id=? AND status='running' AND lease_token=? AND lease_until>?",
        )
        .run(
          payload,
          now,
          job.id,
          job.provider,
          job.providerId,
          job.leaseToken,
          now,
        ).changes === 1
    );
  }
  failMessage(
    job: InboundJob,
    code: string,
    retryAfterMs: number,
    permanent: boolean,
    now = Date.now(),
  ): boolean {
    time(now);
    errorCode(code);
    duration(retryAfterMs);
    const status = permanent ? "unavailable" : "pending";
    return (
      this.db
        .query(
          "UPDATE inbound_messages SET status=?,available_at=?,lease_until=NULL,lease_token=NULL,last_error=?,updated_at=? WHERE id=? AND provider=? AND provider_id=? AND status='running' AND lease_token=? AND lease_until>?",
        )
        .run(
          status,
          now + retryAfterMs,
          code,
          now,
          job.id,
          job.provider,
          job.providerId,
          job.leaseToken,
          now,
        ).changes === 1
    );
  }
  claimReconciliation(
    provider: string,
    now = Date.now(),
    leaseMs = 60000,
  ): ReconciliationJob | null {
    identity(provider);
    time(now);
    duration(leaseMs);
    return this.db
      .transaction(() => {
        this.db
          .query(
            "INSERT OR IGNORE INTO inbound_reconciliation(key,state,available_at,updated_at) VALUES(?,'{}',0,?)",
          )
          .run(provider, now);
        const row = this.db
          .query<
            { state: string; lease_token: string },
            [string, number, number, string, number, number]
          >(
            "UPDATE inbound_reconciliation SET lease_token=?,lease_until=?,updated_at=?,attempts=attempts+1 WHERE key=? AND available_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING state,lease_token",
          )
          .get(crypto.randomUUID(), now + leaseMs, now, provider, now, now);
        return row
          ? {
              provider,
              state: JSON.parse(row.state) as unknown,
              leaseToken: row.lease_token,
            }
          : null;
      })
      .immediate();
  }
  renewReconciliation(
    job: ReconciliationJob,
    leaseMs: number,
    now = Date.now(),
  ): boolean {
    time(now);
    duration(leaseMs);
    return (
      this.db
        .query(
          "UPDATE inbound_reconciliation SET lease_until=?,updated_at=? WHERE key=? AND lease_token=? AND lease_until>?",
        )
        .run(now + leaseMs, now, job.provider, job.leaseToken, now).changes ===
      1
    );
  }
  commitPage(
    job: ReconciliationJob,
    items: InboundMetadata[],
    nextState: unknown,
    nextAt: number,
    now = Date.now(),
  ): boolean {
    time(now);
    time(nextAt);
    if (nextAt < now || items.length > 100)
      throw new Error("Invalid reconciliation page");
    const state = serialized(nextState, 65536);
    return this.db
      .transaction(() => {
        const owned = this.db
          .query(
            "SELECT 1 FROM inbound_reconciliation WHERE key=? AND lease_token=? AND lease_until>?",
          )
          .get(job.provider, job.leaseToken, now);
        if (!owned) return false;
        for (const item of items) this.enqueue(job.provider, item, now);
        return (
          this.db
            .query(
              "UPDATE inbound_reconciliation SET state=?,available_at=?,lease_token=NULL,lease_until=NULL,attempts=0,last_error=NULL,updated_at=? WHERE key=? AND lease_token=? AND lease_until>?",
            )
            .run(state, nextAt, now, job.provider, job.leaseToken, now)
            .changes === 1
        );
      })
      .immediate();
  }
  failReconciliation(
    job: ReconciliationJob,
    code: string,
    retryAfterMs: number,
    now = Date.now(),
  ): boolean {
    time(now);
    errorCode(code);
    duration(retryAfterMs);
    return (
      this.db
        .query(
          "UPDATE inbound_reconciliation SET available_at=?,lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE key=? AND lease_token=? AND lease_until>?",
        )
        .run(now + retryAfterMs, code, now, job.provider, job.leaseToken, now)
        .changes === 1
    );
  }
}
