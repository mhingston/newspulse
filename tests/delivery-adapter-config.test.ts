import { describe, expect, test } from "bun:test";
import { ResendDelivery } from "../src/adapters/resend-delivery";
import { deliveryConfig } from "../src/delivery-config";
import { DeliveryProviderError } from "../src/delivery";

const message = {
  from: "sender@example.com",
  to: "reader@example.com",
  subject: "Edition",
  html: "<p>Story</p>",
  text: "Story",
};

describe("Resend delivery adapter", () => {
  test("sends the frozen payload and stable idempotency key", async () => {
    const signal = new AbortController().signal;
    let request: { url: string; init?: RequestInit } | undefined;
    const fetcher = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      request = { url: String(url), init };
      return Response.json({ id: "email-123" });
    }) as unknown as typeof fetch;
    const adapter = new ResendDelivery("secret-key", fetcher);
    expect(await adapter.send(message, "edition/key", signal)).toEqual({
      id: "email-123",
    });
    expect(request?.url).toBe("https://api.resend.com/emails");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.redirect).toBe("error");
    expect(request?.init?.signal).toBe(signal);
    expect(JSON.parse(String(request?.init?.body))).toEqual(message);
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-key");
    expect(headers.get("idempotency-key")).toBe("edition/key");
  });

  test("treats network errors, provider errors and invalid responses as ambiguous without leaking details", async () => {
    const responses: Array<() => Promise<Response>> = [
      async () => {
        throw new Error("secret-key network failure");
      },
      async () => new Response("secret-key rejected", { status: 409 }),
      async () => new Response("invalid json"),
      async () => Response.json({ id: "bad id" }),
      async () => new Response("x".repeat(4097)),
    ];
    for (const response of responses) {
      const adapter = new ResendDelivery(
        "secret-key",
        response as unknown as typeof fetch,
      );
      try {
        await adapter.send(
          message,
          "edition/key",
          new AbortController().signal,
        );
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(DeliveryProviderError);
        expect((error as DeliveryProviderError).kind).toBe("ambiguous");
        expect(String(error)).not.toContain("secret-key");
      }
    }
  });

  test("abort bounds a stalled transport and a stalled response body", async () => {
    const transportController = new AbortController();
    const stalledFetch = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;
    const transport = new ResendDelivery("key", stalledFetch).send(
      message,
      "key",
      transportController.signal,
    );
    transportController.abort();
    await expect(transport).rejects.toBeInstanceOf(DeliveryProviderError);

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const bodyFetch = (async () =>
      new Response(body)) as unknown as typeof fetch;
    const bodyController = new AbortController();
    const pending = new ResendDelivery("key", bodyFetch).send(
      message,
      "key",
      bodyController.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    bodyController.abort();
    await expect(pending).rejects.toBeInstanceOf(DeliveryProviderError);
    expect(cancelled).toBe(true);

    let called = false;
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const neverCalled = (async () => {
      called = true;
      return Response.json({ id: "id" });
    }) as unknown as typeof fetch;
    await expect(
      new ResendDelivery("key", neverCalled).send(
        message,
        "key",
        alreadyAborted.signal,
      ),
    ).rejects.toBeInstanceOf(DeliveryProviderError);
    expect(called).toBe(false);
  });
});

describe("delivery configuration", () => {
  test("is opt-in and validates required settings", () => {
    expect(deliveryConfig({})).toBeNull();
    expect(deliveryConfig({ DELIVERY_ENABLED: "false" })).toBeNull();
    expect(() => deliveryConfig({ DELIVERY_ENABLED: "yes" })).toThrow();
    expect(() => deliveryConfig({ DELIVERY_ENABLED: "true" })).toThrow();
    expect(() =>
      deliveryConfig({ DELIVERY_ENABLED: "true", RESEND_API_KEY: "key" }),
    ).toThrow();
  });

  test("uses London defaults and rejects invalid clocks and zones", () => {
    const env = {
      DELIVERY_ENABLED: "true",
      RESEND_API_KEY: "key",
      DELIVERY_FROM: "sender@example.com",
      DELIVERY_TO: "reader@example.com",
    };
    expect(deliveryConfig(env)).toMatchObject({
      timezone: "Europe/London",
      hour: 6,
      minute: 0,
    });
    expect(
      deliveryConfig({
        ...env,
        DELIVERY_TIMEZONE: "America/New_York",
        DELIVERY_TIME: "23:15",
      }),
    ).toMatchObject({ timezone: "America/New_York", hour: 23, minute: 15 });
    expect(() =>
      deliveryConfig({ ...env, DELIVERY_TIMEZONE: "Invalid/Zone" }),
    ).toThrow();
    expect(() => deliveryConfig({ ...env, DELIVERY_TIME: "24:00" })).toThrow();
    expect(() => deliveryConfig({ ...env, DELIVERY_TIME: "6:00" })).toThrow();
  });
});
