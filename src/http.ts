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
}
export function createApp(store: Store, config: HttpConfig) {
  const app = new Hono();
  let inboundRequests = 0;
  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!config.allowedHosts.includes(host))
      return c.json({ error: "Host not allowed" }, 403);
    const origin = c.req.header("origin");
    if (origin && !config.allowedOrigins.includes(origin))
      return c.json({ error: "Origin not allowed" }, 403);
    if (
      c.req.method === "POST" &&
      new URL(c.req.url).pathname === "/webhooks/resend" &&
      config.inboundWebhook
    ) {
      await next();
      return;
    }
    // Digest feedback links are bearer-less by design: the narrowly scoped,
    // signed token is the credential. They are the only non-webhook public
    // routes and cannot read data or mutate sources/spend.
    if (new URL(c.req.url).pathname.startsWith("/feedback/")) {
      await next();
      return;
    }
    const actual = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return c.json({ error: "Unauthorized" }, 401);
    await next();
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
    const length = c.req.header("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > 65536))
      return c.json({ error: "Payload too large" }, 413);
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      const deadline = Date.now() + 10_000;
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
          return c.json({ error: "Request timeout" }, 408);
        }
        const { done, value } = chunk;
        if (done) break;
        size += value.byteLength;
        if (size > 65536) {
          void reader.cancel().catch(() => {});
          return c.json({ error: "Payload too large" }, 413);
        }
        chunks.push(value);
      }
    }
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      return c.json({ error: "Invalid payload" }, 400);
    }
    try {
      config.inboundWebhook(body, c.req.raw.headers);
    } catch (error) {
      if (error instanceof InboundWebhookError)
        return c.json({ error: "Invalid webhook" }, 400);
      throw error;
    }
    return c.json({ ok: true });
  });
  app.get("/health", (c) => c.json({ ok: true, milestone: "M1" }));
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
    let action: string;
    try {
      const body = await c.req.parseBody();
      action = String(body.action ?? "");
    } catch {
      action = "";
    }
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
