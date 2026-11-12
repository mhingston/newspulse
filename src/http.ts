import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "./db/store";
import { handleMcp, type McpOptions } from "./mcp";
import { applyFeedbackLink } from "./email-feedback";
import { ConfirmationError } from "./confirmations";
export interface HttpConfig {
  token: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  inboundWebhook?: (body: string, headers: Headers) => void;
  /** Extra, non-MCP routes; the feedback link is the only public one. */
  mcp?: McpOptions;
  /** Public origin that generated feedback links, accepted for their POSTs. */
  feedbackOrigin?: string;
}
export function createApp(store: Store, config: HttpConfig) {
  const app = new Hono();
  let inboundRequests = 0;
  let feedbackRequests = 0;
  const feedbackOrigin =
    config.feedbackOrigin ?? config.allowedOrigins[0] ?? null;
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const host = url.hostname;
    if (!config.allowedHosts.includes(host))
      return c.json({ error: "Host not allowed" }, 403);
    const isFeedback = url.pathname.startsWith("/feedback/");
    const origin = c.req.header("origin");
    // Feedback pages are opened from an email, so their form POST is
    // same-origin. Accept that origin specifically without relaxing the MCP
    // origin policy.
    if (
      origin &&
      !config.allowedOrigins.includes(origin) &&
      !(
        isFeedback &&
        feedbackOrigin &&
        (origin === feedbackOrigin || origin === url.origin)
      )
    )
      return c.json({ error: "Origin not allowed" }, 403);
    if (
      c.req.method === "POST" &&
      url.pathname === "/webhooks/resend" &&
      config.inboundWebhook
    ) {
      await next();
      return;
    }
    // Digest feedback links are bearer-less by design: the narrowly scoped,
    // signed token is the credential. They are the only non-webhook public
    // routes and cannot read data or mutate sources/spend.
    if (isFeedback) {
      await next();
      return;
    }
    const actual = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return c.json({ error: "Unauthorized" }, 401);
    await next();
  });
  app.use("/feedback/*", async (c, next) => {
    if (feedbackRequests >= 16) return c.json({ error: "Busy" }, 503);
    feedbackRequests++;
    try {
      await next();
    } finally {
      feedbackRequests--;
    }
  });
  app.use("/webhooks/resend", async (c, next) => {
    if (inboundRequests >= 16) return c.json({ error: "Busy" }, 503);
    inboundRequests++;
    try {
      await next();
    } finally {
      inboundRequests--;
    }
  });
  app.post("/webhooks/resend", async (c) => {
    if (!config.inboundWebhook) return c.notFound();
    const read = await readBoundedBody(c.req.raw, 65536, 10_000);
    if (!read.ok) return c.json({ error: read.error }, read.status);
    try {
      config.inboundWebhook(read.body, c.req.raw.headers);
    } catch (error) {
      if (error instanceof InboundWebhookError)
        return c.json({ error: "Invalid webhook" }, 400);
      throw error;
    }
    return c.json({ ok: true });
  });
  // `ok` is process liveness and stays true while the server answers. `ready`
  // reflects the same durable health warnings `get_status` reports, so a
  // process that is up but backed up or failing is visible to supervisors.
  app.get("/health", (c) => {
    const health = store.status().health;
    return c.json({
      ok: true,
      ready: health.ready,
      warnings: health.warnings,
      checked_at: health.checked_at,
    });
  });
  // GET never mutates: link scanners and prefetchers see only a confirmation
  // page. The action is applied by the explicit POST the user submits.
  app.get("/feedback/:token", (c) => {
    const token = c.req.param("token");
    if (!/^v1\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{20,128}$/.test(token))
      return c.html(
        feedbackPage("Invalid link", "This feedback link is not valid."),
        400,
      );
    return c.html(feedbackForm(token, c.req.query("action")));
  });
  app.post("/feedback/:token", async (c) => {
    const token = c.req.param("token");
    if (!/^v1\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{20,128}$/.test(token))
      return c.html(
        feedbackPage("Invalid link", "This feedback link is not valid."),
        400,
      );
    // The public route must not buffer an unbounded body. The form is a single
    // small field, so a tight byte cap and deadline are enough.
    const read = await readBoundedBody(c.req.raw, 1024, 10_000);
    if (!read.ok)
      return c.html(feedbackPage("Invalid feedback", read.error), read.status);
    // Exactly one action field: a duplicated parameter is ambiguous and refused.
    const actions = new URLSearchParams(read.body).getAll("action");
    const action = actions.length === 1 ? actions[0]! : "";
    if (action !== "useful" && action !== "not_useful")
      return c.html(
        feedbackPage("Invalid feedback", "Choose useful or not useful."),
        400,
      );
    try {
      applyFeedbackLink(store.sqlite, { token, action });
    } catch (error) {
      const message =
        error instanceof ConfirmationError
          ? error.message
          : "Feedback could not be recorded.";
      return c.html(feedbackPage("Feedback not recorded", message), 400);
    }
    return c.html(
      feedbackPage(
        "Thanks",
        action === "useful" ? "Recorded: useful." : "Recorded: not useful.",
      ),
    );
  });
  app.all("/mcp", (c) => handleMcp(store, c.req.raw, config.mcp));
  app.onError((error, c) => {
    console.error(
      JSON.stringify({ event: "http_error", error: error.message }),
    );
    return c.json({ error: "Internal server error" }, 500);
  });
  return app;
}

type BoundedRead =
  | { ok: true; body: string }
  | { ok: false; status: 400 | 408 | 413; error: string };

/**
 * Read a request body with a hard byte cap and a read deadline, so a public or
 * authenticated route cannot be held open or buffered without bound. Returns a
 * discriminated result rather than throwing.
 */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
  timeoutMs: number,
): Promise<BoundedRead> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes))
    return { ok: false, status: 413, error: "Payload too large" };
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          timer = setTimeout(
            () => resolve(null),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (!chunk) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 408, error: "Request timeout" };
      }
      const { done, value } = chunk;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: "Payload too large" };
      }
      chunks.push(value);
    }
  }
  try {
    return {
      ok: true,
      body: new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      ),
    };
  } catch {
    return { ok: false, status: 400, error: "Invalid payload" };
  }
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

/** Minimal, self-contained HTML with no external resources or scripts. */
function feedbackPage(heading: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head><body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function feedbackForm(token: string, action: string | undefined): string {
  const chosen = action === "not_useful" ? "not_useful" : "useful";
  const label = chosen === "useful" ? "Useful" : "Not useful";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Confirm feedback</title></head><body><h1>Confirm feedback</h1><p>Record &ldquo;${label}&rdquo; for this item? This link can only be used once.</p><form method="post" action="/feedback/${escapeHtml(token)}"><input type="hidden" name="action" value="${chosen}"><button type="submit">Record &ldquo;${label}&rdquo;</button></form></body></html>`;
}

/** Invalid signatures and payloads are distinct from storage failures. */
export class InboundWebhookError extends Error {}
