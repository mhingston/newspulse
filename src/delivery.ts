import { DeliveryStore } from "./db/delivery-store";

export interface DeliveryEmailProvider {
  send(
    message: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    },
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{ id: string }>;
}
export class DeliveryProviderError extends Error {
  constructor(readonly kind: "rejected" | "ambiguous") {
    super(kind);
  }
}
export class DeliveryWorker {
  constructor(
    private readonly store: DeliveryStore,
    private readonly provider: DeliveryEmailProvider,
    private readonly clock: () => number = Date.now,
  ) {}
  async send(now = this.clock()): Promise<void> {
    const claim = this.store.claim(now);
    if (!claim) return;
    const message = this.store.message(claim);
    if (!message || !this.store.beginSend(claim, this.clock())) return;
    try {
      const result = await this.provider.send(
        message,
        claim.idempotency_key,
        AbortSignal.timeout(20_000),
      );
      this.store.sent(claim, result.id, this.clock());
    } catch (error) {
      this.store.fail(
        claim,
        error instanceof DeliveryProviderError ? error.kind : "ambiguous",
        this.clock(),
      );
    }
  }
}
