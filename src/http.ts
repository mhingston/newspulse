import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "./db/store";
import { handleMcp } from "./mcp";
export interface HttpConfig {
  token: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  inboundWebhook?: (body: string, headers: Headers) => void;
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
  app.all("/mcp", (c) => handleMcp(store, c.req.raw));
  app.onError((error, c) => {
    console.error(
      JSON.stringify({ event: "http_error", error: error.message }),
    );
    return c.json({ error: "Internal server error" }, 500);
  });
  return app;
}

/** Invalid signatures and payloads are distinct from storage failures. */
export class InboundWebhookError extends Error {}
