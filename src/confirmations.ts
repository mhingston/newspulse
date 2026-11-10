import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

/**
 * Consequential MCP mutations require a preview first. The preview records a
 * server-computed hash of the exact normalized payload; the confirmation token
 * is single-use, expires quickly and is bound to that hash, so a boolean flag
 * or a token reused for different parameters can never authorize a change.
 */
export const CONFIRMATION_TTL_MS = 10 * 60_000;
const maxPreviewChars = 20_000;

export class ConfirmationError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "expired"
      | "used"
      | "payload_changed"
      | "action_mismatch"
      | "too_large",
    message: string,
  ) {
    super(message);
  }
}

/** Deterministic key-order-independent serialization for hashing. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

export function payloadHash(action: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${action}\n${stable(payload)}`)
    .digest("hex");
}

export interface PreparedMutation<T> {
  preview: Record<string, unknown> & { status: "confirmation_required" };
  token: string;
  expiresAt: number;
  apply: () => T;
}

/**
 * Compute a preview and persist its approval record before the caller applies
 * anything. `prepare` must stay free of side effects: it only normalizes input
 * and describes what would change.
 */
export function prepareMutation<T>(
  db: Database,
  input: {
    action: string;
    payload: unknown;
    preview: Record<string, unknown>;
    apply: () => T;
    now?: number;
    ttlMs?: number;
  },
): PreparedMutation<T> {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? CONFIRMATION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3_600_000)
    throw new Error("Invalid confirmation lifetime");
  // The stored preview must stay valid JSON: a truncated document would make
  // the confirmation unusable. A preview larger than the HTTP body ceiling is
  // rejected up front instead.
  const preview = JSON.stringify(input.preview);
  if (preview.length > maxPreviewChars)
    throw new ConfirmationError(
      "too_large",
      "Preview exceeds the confirmation size limit",
    );
  const token = randomUUID();
  const expiresAt = now + ttlMs;
  db.query(
    "INSERT INTO mutation_confirmations(id,action,payload_hash,preview,expires_at,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    token,
    input.action,
    payloadHash(input.action, input.payload),
    preview,
    expiresAt,
    now,
  );
  // Expired approvals are useless; drop them before they accumulate.
  db.query("DELETE FROM mutation_confirmations WHERE expires_at<?").run(
    now - 86_400_000,
  );
  return {
    preview: {
      ...input.preview,
      status: "confirmation_required",
      confirm_token: token,
      expires_at: expiresAt,
    },
    token,
    expiresAt,
    apply: input.apply,
  };
}

/**
 * Consume an approval and run the single side effect it authorizes. Validation
 * and consumption happen in one transaction so a failure leaves the token
 * unused; the effect itself must stay short and network-free.
 */
export function consumeConfirmation<T>(
  db: Database,
  input: {
    action: string;
    token: string;
    payload: unknown;
    now?: number;
    apply: () => T;
  },
): T {
  const now = input.now ?? Date.now();
  return db
    .transaction(() => {
      const row = db
        .query<
          {
            action: string;
            payload_hash: string;
            expires_at: number;
            used_at: number | null;
          },
          [string]
        >(
          "SELECT action,payload_hash,expires_at,used_at FROM mutation_confirmations WHERE id=?",
        )
        .get(input.token);
      if (!row)
        throw new ConfirmationError("not_found", "Unknown confirmation token");
      if (row.action !== input.action)
        throw new ConfirmationError(
          "action_mismatch",
          "Confirmation token belongs to a different action",
        );
      if (row.used_at !== null)
        throw new ConfirmationError(
          "used",
          "Confirmation token was already used",
        );
      if (row.expires_at <= now)
        throw new ConfirmationError(
          "expired",
          "Confirmation token has expired",
        );
      if (row.payload_hash !== payloadHash(input.action, input.payload))
        throw new ConfirmationError(
          "payload_changed",
          "Confirmed payload differs from the preview",
        );
      if (
        db
          .query(
            "UPDATE mutation_confirmations SET used_at=? WHERE id=? AND used_at IS NULL",
          )
          .run(now, input.token).changes !== 1
      )
        throw new ConfirmationError(
          "used",
          "Confirmation token was already used",
        );
      return input.apply();
    })
    .immediate();
}

/** Replay protection for bearer-less email feedback links. */
export function consumeFeedbackToken(
  db: Database,
  input: {
    tokenHash: string;
    action: string;
    now?: number;
    apply: (row: {
      digestId: string;
      itemId: string;
      editionDate: string;
      action: string;
    }) => unknown;
  },
): { status: "recorded"; itemId: string; action: string; editionDate: string } {
  const now = input.now ?? Date.now();
  return db
    .transaction(() => {
      const row = db
        .query<
          {
            digest_id: string;
            item_id: string;
            edition_date: string;
            action: string;
            used_at: number | null;
          },
          [string]
        >(
          "SELECT digest_id,item_id,edition_date,action,used_at FROM digest_feedback_tokens WHERE token_hash=?",
        )
        .get(input.tokenHash);
      if (!row || row.action !== input.action)
        throw new ConfirmationError("not_found", "Unknown feedback token");
      if (row.used_at !== null)
        throw new ConfirmationError(
          "used",
          "Feedback already recorded for this link",
        );
      if (
        db
          .query(
            "UPDATE digest_feedback_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL",
          )
          .run(now, input.tokenHash).changes !== 1
      )
        throw new ConfirmationError(
          "used",
          "Feedback already recorded for this link",
        );
      input.apply({
        digestId: row.digest_id,
        itemId: row.item_id,
        editionDate: row.edition_date,
        action: row.action,
      });
      return {
        status: "recorded" as const,
        itemId: row.item_id,
        action: row.action,
        editionDate: row.edition_date,
      };
    })
    .immediate();
}
