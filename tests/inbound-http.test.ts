import { expect, test } from "bun:test";
import { createApp, InboundWebhookError } from "../src/http";
import { Store } from "../src/db/store";

test("only the bounded webhook bypasses bearer authentication, and storage failure is not acknowledged", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  let fail = false;
  const app = createApp(store, {
    token: "private-token-with-enough-length",
    allowedHosts: ["localhost"],
    allowedOrigins: [],
    inboundWebhook: (body) => {
      calls++;
      if (body === "invalid") throw new InboundWebhookError();
      if (fail) throw new Error("database unavailable");
    },
  });
  const send = (path: string, body = "event") =>
    app.request(`http://localhost${path}`, { method: "POST", body });
  try {
    expect((await send("/webhooks/resend")).status).toBe(200);
    expect((await send("/webhooks/resend", "invalid")).status).toBe(400);
    expect((await send("/mcp")).status).toBe(401);
    expect((await app.request("http://localhost/health")).status).toBe(401);
    expect((await send("/webhooks/resend", "x".repeat(65537))).status).toBe(
      413,
    );
    expect(calls).toBe(2);
    fail = true;
    expect((await send("/webhooks/resend")).status).toBe(500);
  } finally {
    store.close();
  }
});
