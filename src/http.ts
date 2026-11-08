import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "./db/store";
import { handleMcp } from "./mcp";
export interface HttpConfig {
  token: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}
export function createApp(store: Store, config: HttpConfig) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!config.allowedHosts.includes(host))
      return c.json({ error: "Host not allowed" }, 403);
    const origin = c.req.header("origin");
    if (origin && !config.allowedOrigins.includes(origin))
      return c.json({ error: "Origin not allowed" }, 403);
    const actual = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return c.json({ error: "Unauthorized" }, 401);
    await next();
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
