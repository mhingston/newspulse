import { DeliveryProviderError, type DeliveryEmailProvider } from "../delivery";

/** Also bound custom transports and response streams that ignore AbortSignal. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("aborted");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Resend's POST /emails supports an identical payload/key for 24 hours. */
export class ResendDelivery implements DeliveryEmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!apiKey.trim()) throw new Error("Missing Resend API key");
  }
  async send(
    message: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    },
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{ id: string }> {
    let response: Response;
    try {
      if (signal.aborted) throw new Error("aborted");
      const pending = this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(message),
        redirect: "error",
        signal,
      });
      // A transport ignoring the signal may still return a body after timeout.
      void pending.then(
        (late) => {
          if (signal.aborted) void late.body?.cancel().catch(() => {});
        },
        () => {},
      );
      response = await abortable(pending, signal);
    } catch {
      throw new DeliveryProviderError("ambiguous");
    }
    // An error response does not prove that a previous attempt was not accepted.
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new DeliveryProviderError("ambiguous");
    }
    try {
      if (!response.body) throw new Error("missing response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await abortable(reader.read(), signal);
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 4096) {
            void reader.cancel().catch(() => {});
            throw new Error("oversized response");
          }
          chunks.push(part.value);
        }
      } finally {
        if (signal.aborted) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const data: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (
        !data ||
        typeof data !== "object" ||
        !("id" in data) ||
        typeof data.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(data.id)
      )
        throw new Error("invalid response");
      return { id: data.id };
    } catch {
      throw new DeliveryProviderError("ambiguous");
    }
  }
}
