import { Resend } from "resend";
import { z } from "zod";
import {
  InboundProviderError,
  type InboundEmailMetadata,
  type InboundEmailProvider,
} from "../inbound";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const address = z.string().max(2000);
const metadataSchema = z.object({
  id,
  created_at: z.string().max(100),
  from: address,
  to: z.array(address).max(100),
  subject: z.string().max(10000),
  message_id: z.string().max(2000).nullable().optional(),
  received_for: z.array(address).max(100).optional(),
});
const bodySchema = metadataSchema.extend({
  text: z.string().nullable(),
  html: z.string().nullable(),
});
const listSchema = z.object({
  object: z.literal("list"),
  has_more: z.boolean(),
  data: z.array(metadataSchema).max(100),
});
const eventSchema = z.object({
  type: z.literal("email.received"),
  data: z.object({
    email_id: id,
    created_at: z.string().max(100),
    from: address,
    to: z.array(address).max(100),
    subject: z.string().max(10000),
    message_id: z.string().max(2000).nullable().optional(),
    received_for: z.array(address).max(100).optional(),
  }),
});
type ProviderMetadata = z.infer<typeof metadataSchema>;
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
function normalized(value: ProviderMetadata): InboundEmailMetadata {
  const receivedAt = Date.parse(value.created_at);
  if (!Number.isSafeInteger(receivedAt))
    throw new InboundProviderError("invalid", "Invalid inbound timestamp");
  return {
    providerId: value.id,
    receivedAt,
    from: value.from,
    to: value.to,
    subject: value.subject,
    messageId: value.message_id ?? null,
    receivedFor: value.received_for ?? [],
  };
}

/** Receiving uses bounded streaming HTTP; SDK verifies the exact raw signed body. */
export class ResendInbound implements InboundEmailProvider {
  private verifier: Resend;
  constructor(
    private apiKey: string,
    private secret: string,
    private fetcher: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
    private timeoutMs = 15_000,
    private maxBytes = 2_000_000,
  ) {
    if (
      !apiKey.trim() ||
      !secret.trim() ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    )
      throw new Error("Invalid inbound provider configuration");
    this.verifier = new Resend(apiKey);
  }
  verifyWebhook(
    payload: string,
    headers: { id: string; timestamp: string; signature: string },
  ) {
    if (
      Buffer.byteLength(payload) > 128_000 ||
      !headers.id ||
      headers.id.length > 500 ||
      !headers.timestamp ||
      headers.timestamp.length > 30 ||
      !headers.signature ||
      headers.signature.length > 5000
    )
      throw new InboundProviderError("invalid", "Invalid webhook envelope");
    try {
      const verified = this.verifier.webhooks.verify({
        payload,
        headers,
        webhookSecret: this.secret,
      });
      const event = eventSchema.parse(verified);
      return {
        eventId: headers.id,
        metadata: normalized({ ...event.data, id: event.data.email_id }),
      };
    } catch {
      throw new InboundProviderError(
        "invalid",
        "Invalid webhook signature or event",
      );
    }
  }
  private async request(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await abortable(
        this.fetcher(`https://api.resend.com${path}`, {
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: "application/json",
          },
          redirect: "error",
          signal: requestSignal,
        }),
        requestSignal,
      );
    } catch {
      throw new InboundProviderError(
        "transient",
        "Inbound provider request failed",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new InboundProviderError(
        response.status === 404
          ? "unavailable"
          : response.status === 401 ||
              response.status === 403 ||
              response.status === 429 ||
              response.status >= 500
            ? "transient"
            : "invalid",
        `Inbound provider HTTP ${response.status}`,
      );
    }
    if (!response.body)
      throw new InboundProviderError(
        "invalid",
        "Inbound provider returned no body",
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await abortable(reader.read(), requestSignal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.maxBytes) {
          await reader.cancel();
          throw new InboundProviderError(
            "invalid",
            "Inbound provider response exceeds limit",
          );
        }
        chunks.push(chunk.value);
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown;
    } catch (error) {
      if (error instanceof InboundProviderError) throw error;
      if (requestSignal.aborted) void reader.cancel().catch(() => {});
      throw new InboundProviderError(
        timeout.aborted || signal?.aborted ? "transient" : "invalid",
        "Inbound provider response failed",
      );
    } finally {
      reader.releaseLock();
    }
  }
  async get(providerId: string, signal?: AbortSignal) {
    const parsedId = id.safeParse(providerId);
    if (!parsedId.success)
      throw new InboundProviderError("invalid", "Invalid inbound message ID");
    const raw = await this.request(
      `/emails/receiving/${encodeURIComponent(parsedId.data)}?html_format=cid`,
      signal,
    );
    const result = bodySchema.safeParse(raw);
    if (!result.success || result.data.id !== providerId)
      throw new InboundProviderError(
        "invalid",
        "Invalid inbound message response",
      );
    return {
      metadata: normalized(result.data),
      text: result.data.text,
      html: result.data.html,
    };
  }
  async list(after?: string, signal?: AbortSignal) {
    if (after !== undefined && !id.safeParse(after).success)
      throw new InboundProviderError(
        "invalid",
        "Invalid inbound pagination cursor",
      );
    const params = new URLSearchParams({ limit: "100" });
    if (after !== undefined) params.set("after", after);
    const result = listSchema.safeParse(
      await this.request(`/emails/receiving?${params}`, signal),
    );
    if (!result.success || (result.data.has_more && !result.data.data.length))
      throw new InboundProviderError(
        "invalid",
        "Invalid inbound list response",
      );
    return {
      items: result.data.data.map(normalized),
      hasMore: result.data.has_more,
    };
  }
}
