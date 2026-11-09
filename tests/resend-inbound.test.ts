import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ResendInbound } from "../src/adapters/resend-inbound";
import { InboundProviderError } from "../src/inbound";

const secretBytes = Buffer.from("0123456789abcdef0123456789abcdef");
const secret = `whsec_${secretBytes.toString("base64")}`;
const metadata = {
  id: "message-1",
  created_at: "2026-11-09T08:00:00Z",
  from: "sender@example.test",
  to: ["inbox@example.test"],
  subject: "Example",
  message_id: "<original@example.test>",
  received_for: ["inbox@example.test"],
};
function signed(
  payload: string,
  timestamp = Math.floor(Date.now() / 1000),
  id = "evt-1",
) {
  return {
    id,
    timestamp: String(timestamp),
    signature: `v1,${createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${payload}`).digest("base64")}`,
  };
}

test("pinned SDK verifies exact body, rejects changed and expired signatures", () => {
  const adapter = new ResendInbound("test-key", secret);
  const payload = JSON.stringify({
    type: "email.received",
    data: { ...metadata, email_id: metadata.id },
  });
  const headers = signed(payload);
  expect(adapter.verifyWebhook(payload, headers)).toMatchObject({
    eventId: "evt-1",
    metadata: { providerId: "message-1", messageId: "<original@example.test>" },
  });
  expect(() => adapter.verifyWebhook(`${payload} `, headers)).toThrow(
    InboundProviderError,
  );
  expect(() =>
    adapter.verifyWebhook(
      payload,
      signed(payload, Math.floor(Date.now() / 1000) - 301),
    ),
  ).toThrow(InboundProviderError);
  expect(() =>
    adapter.verifyWebhook(payload, { ...headers, signature: "" }),
  ).toThrow(InboundProviderError);
  const wrong = JSON.stringify({ type: "email.sent", data: {} });
  expect(() => adapter.verifyWebhook(wrong, signed(wrong))).toThrow(
    InboundProviderError,
  );
});

test("Receiving get and list use pinned contract with bounded pagination and bodies", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json(
      String(url).includes("message-1?")
        ? {
            ...metadata,
            object: "email",
            html: "<p>Hello</p>",
            text: "Hello",
            attachments: [{ id: "never-fetched" }],
          }
        : { object: "list", has_more: true, data: [metadata] },
    );
  };
  const adapter = new ResendInbound("test-key", secret, fake);
  const page = await adapter.list("cursor-1");
  expect(page).toMatchObject({
    hasMore: true,
    items: [{ providerId: "message-1", receivedFor: ["inbox@example.test"] }],
  });
  expect((await adapter.get("message-1")).text).toBe("Hello");
  expect(calls.map((call) => call.url)).toEqual([
    "https://api.resend.com/emails/receiving?limit=100&after=cursor-1",
    "https://api.resend.com/emails/receiving/message-1?html_format=cid",
  ]);
  expect(calls[0]!.init?.redirect).toBe("error");
  expect(() =>
    adapter.verifyWebhook("x".repeat(128001), signed("x")),
  ).toThrow();
});

test("provider failure and response limits do not expose credentials", async () => {
  for (const [status, kind] of [
    [429, "transient"],
    [503, "transient"],
    [404, "unavailable"],
    [401, "transient"],
    [403, "transient"],
    [400, "invalid"],
  ] as const) {
    const adapter = new ResendInbound(
      "sensitive-key",
      secret,
      async () => new Response("sensitive-key", { status }),
    );
    try {
      await adapter.list();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(InboundProviderError);
      expect((error as InboundProviderError).kind).toBe(kind);
      expect(String(error)).not.toContain("sensitive-key");
    }
  }
  const oversized = new ResendInbound(
    "key",
    secret,
    async () => new Response("0123456789"),
    1000,
    9,
  );
  await expect(oversized.list()).rejects.toMatchObject({ kind: "invalid" });
  const malformed = new ResendInbound("key", secret, async () =>
    Response.json({ object: "list", has_more: true, data: [] }),
  );
  await expect(malformed.list()).rejects.toMatchObject({ kind: "invalid" });
  await expect(malformed.get("../private")).rejects.toMatchObject({
    kind: "invalid",
  });
});

test("timeout bounds stalled dispatch and stalled response streams", async () => {
  const stuckFetch = new ResendInbound(
    "key",
    secret,
    () => new Promise(() => {}),
    5,
  );
  await expect(stuckFetch.list()).rejects.toMatchObject({ kind: "transient" });
  const stalled = new ResendInbound(
    "key",
    secret,
    async () => new Response(new ReadableStream({ start() {} })),
    5,
  );
  await expect(stalled.list()).rejects.toMatchObject({ kind: "transient" });
});

test("response stream read failures are transient, but malformed content is invalid", async () => {
  let reads = 0;
  const reset = new ResendInbound("key", secret, async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads++ === 0)
            controller.enqueue(new TextEncoder().encode('{"object":"list",'));
          else controller.error(new Error("connection reset"));
        },
      }),
    ),
  );
  await expect(reset.list()).rejects.toMatchObject({ kind: "transient" });

  const invalidJson = new ResendInbound(
    "key",
    secret,
    async () => new Response("{invalid json"),
  );
  await expect(invalidJson.list()).rejects.toMatchObject({ kind: "invalid" });

  const invalidUtf8 = new ResendInbound(
    "key",
    secret,
    async () => new Response(new Uint8Array([0xc3, 0x28])),
  );
  await expect(invalidUtf8.list()).rejects.toMatchObject({ kind: "invalid" });
});
