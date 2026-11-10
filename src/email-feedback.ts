import type { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { ConfirmationError, consumeFeedbackToken } from "./confirmations";
import { recordFeedback } from "./feedback";

/**
 * Bearer-less digest feedback links. Each link carries a token derived from a
 * dedicated secret and the edition/item/action triple; only the hash is
 * stored. A link authorizes exactly one feedback action — it is not an MCP
 * credential, cannot read data, mutate sources or trigger spending, and it
 * expires with the edition's feedback window.
 */
export const FEEDBACK_TOKEN_VERSION = "v1";
export const FEEDBACK_MAX_AGE_MS = 30 * 86_400_000;
const noncePattern = /^[A-Za-z0-9_-]{16,64}$/;

export function feedbackToken(input: {
  secret: string;
  digestId: string;
  editionDate: string;
  itemId: string;
  action: "useful" | "not_useful";
  nonce: string;
}): string {
  if (!noncePattern.test(input.nonce)) throw new Error("Invalid link nonce");
  const mac = createHmac("sha256", input.secret)
    .update(
      [
        FEEDBACK_TOKEN_VERSION,
        input.digestId,
        input.editionDate,
        input.itemId,
        input.action,
        input.nonce,
      ].join("\n"),
    )
    .digest("base64url");
  return [FEEDBACK_TOKEN_VERSION, input.nonce, mac].join(".");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface FeedbackLinkRequest {
  digestId: string;
  editionDate: string;
  itemId: string;
  action: "useful" | "not_useful";
  nonce: string;
  token: string;
  href: string;
}

/**
 * Create the narrow feedback tokens for a frozen edition right before its
 * body is rendered for delivery. The stored envelope keeps placeholder
 * markers so the digest row itself stays immutable.
 */
export function createFeedbackLinks(
  db: Database,
  input: {
    secret: string;
    baseUrl: string;
    digestId: string;
    editionDate: string;
    items: { itemId: string; actions: ("useful" | "not_useful")[] }[];
    now?: number;
  },
): Map<string, FeedbackLinkRequest[]> {
  const now = input.now ?? Date.now();
  const base = input.baseUrl.replace(/\/+$/, "");
  const links = new Map<string, FeedbackLinkRequest[]>();
  db.transaction(() => {
    for (const item of input.items) {
      const perItem: FeedbackLinkRequest[] = [];
      for (const action of item.actions) {
        const nonce = randomBytes(12).toString("base64url");
        const token = feedbackToken({
          secret: input.secret,
          digestId: input.digestId,
          editionDate: input.editionDate,
          itemId: item.itemId,
          action,
          nonce,
        });
        db.query(
          "INSERT INTO digest_feedback_tokens(token_hash,digest_id,edition_date,item_id,action,nonce,created_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          tokenHash(token),
          input.digestId,
          input.editionDate,
          item.itemId,
          action,
          nonce,
          now,
        );
        perItem.push({
          digestId: input.digestId,
          editionDate: input.editionDate,
          itemId: item.itemId,
          action,
          nonce,
          token,
          href: `${base}/feedback/${token}?action=${action}`,
        });
      }
      links.set(item.itemId, perItem);
    }
  }).immediate();
  return links;
}

/** One item's stable HTML markers inside a rendered digest. */
export function feedbackMarkers(itemId: string) {
  return {
    start: `<!--np:feedback:${itemId}:start-->`,
    end: `<!--np:feedback:${itemId}:end-->`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

function formatLinks(links: FeedbackLinkRequest[]): string {
  const parts = links.map(
    (link) =>
      `<a href="${escapeHtml(link.href)}">${link.action === "useful" ? "Useful" : "Not useful"}</a>`,
  );
  return `<p>Was this useful? ${parts.join(" | ")}</p>`;
}

/** Replace each item's markers with its scoped links; unknown markers stay. */
export function injectFeedbackLinks(
  html: string,
  links: Map<string, FeedbackLinkRequest[]>,
): string {
  let output = html;
  for (const [itemId, itemLinks] of links) {
    const { start, end } = feedbackMarkers(itemId);
    const from = output.indexOf(start);
    const to = output.indexOf(end);
    if (from === -1 || to === -1 || to < from) continue;
    output = `${output.slice(0, to)}${formatLinks(itemLinks)}${output.slice(to)}`;
  }
  return output;
}

/**
 * The plain-text and HTML bodies for one delivery. A frozen digest never
 * records whether a link was used, so re-rendering for a retry keeps the same
 * addresses; the token rows already exist.
 */
export function deliverableDigest(
  db: Database,
  input: {
    secret: string;
    baseUrl: string;
    digestId: string;
    editionDate: string;
    html: string;
    text: string;
    feedbackTargets: { itemId: string; actions: ("useful" | "not_useful")[] }[];
    now?: number;
  },
): { html: string; text: string } {
  const existing = db
    .query<
      { token_hash: string; nonce: string; item_id: string; action: string },
      [string]
    >(
      "SELECT token_hash,nonce,item_id,action FROM digest_feedback_tokens WHERE digest_id=?",
    )
    .all(input.digestId);
  const links = new Map<string, FeedbackLinkRequest[]>();
  if (existing.length) {
    const base = input.baseUrl.replace(/\/+$/, "");
    for (const row of existing) {
      const token = feedbackToken({
        secret: input.secret,
        digestId: input.digestId,
        editionDate: input.editionDate,
        itemId: row.item_id,
        action: row.action as "useful" | "not_useful",
        nonce: row.nonce,
      });
      const perItem = links.get(row.item_id) ?? [];
      perItem.push({
        digestId: input.digestId,
        editionDate: input.editionDate,
        itemId: row.item_id,
        action: row.action as "useful" | "not_useful",
        nonce: row.nonce,
        token,
        href: `${base}/feedback/${token}?action=${row.action}`,
      });
      links.set(row.item_id, perItem);
    }
  } else {
    for (const [itemId, perItem] of createFeedbackLinks(db, {
      secret: input.secret,
      baseUrl: input.baseUrl,
      digestId: input.digestId,
      editionDate: input.editionDate,
      items: input.feedbackTargets,
      now: input.now,
    }))
      links.set(itemId, perItem);
  }
  const html = injectFeedbackLinks(input.html, links);
  const text = [
    input.text,
    ...input.feedbackTargets.map((target) =>
      [
        `Was "${target.itemId}" useful?`,
        ...(links.get(target.itemId) ?? []).map(
          (link) => `- ${link.action.replace("_", " ")}: ${link.href}`,
        ),
      ].join("\n"),
    ),
  ].join("\n\n");
  return { html, text };
}

/**
 * Apply one feedback link. The stored token hash, edition and link age are all
 * checked; replay is rejected. Frozen digest bodies are never modified — the
 * event is recorded separately with its edition context.
 */
export function applyFeedbackLink(
  db: Database,
  input: { token: string; action: string; now?: number },
): { status: "recorded"; itemId: string; action: string; editionDate: string } {
  const now = input.now ?? Date.now();
  const result = consumeFeedbackToken(db, {
    tokenHash: tokenHash(input.token),
    action: input.action,
    now,
    apply: (row) => {
      const created = db
        .query<{ created_at: number; digest_id: string }, [string]>(
          "SELECT created_at,digest_id FROM digest_feedback_tokens WHERE token_hash=?",
        )
        .get(tokenHash(input.token))!;
      // Thrown inside the transaction so the token stays unused.
      if (now - created.created_at > FEEDBACK_MAX_AGE_MS)
        throw new ConfirmationError("expired", "Feedback link has expired");
      if (
        !db
          .query<{ id: string }, [string, string]>(
            "SELECT id FROM digests WHERE id=? AND edition_date=?",
          )
          .get(created.digest_id, row.editionDate)
      )
        throw new ConfirmationError(
          "not_found",
          "Feedback link does not match a frozen edition",
        );
      recordFeedback(db, {
        itemId: row.itemId,
        action: row.action as "useful" | "not_useful",
        source: "email",
        editionDate: row.editionDate,
        digestId: row.digestId,
        now,
      });
    },
  });
  return result;
}
