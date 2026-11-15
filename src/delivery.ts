import { DeliveryStore } from "./db/delivery-store";

export interface DeliveryMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  digestId?: string;
  editionDate?: string;
  decisions?: string;
}
export interface DeliveryEmailProvider {
  send(
    message: DeliveryMessage,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{ id: string }>;
}
export class DeliveryProviderError extends Error {
  constructor(readonly kind: "rejected" | "ambiguous") {
    super(kind);
  }
}
export type DeliveryArtifactScope = "alert" | "digest";

export class DeliveryWorker {
  constructor(
    private readonly store: DeliveryStore,
    private readonly provider: DeliveryEmailProvider,
    private readonly clock: () => number = Date.now,
    /**
     * Optional artifact scope: a scoped worker claims only outbox rows for
     * that artifact type, so the digest sender (with its feedback-link
     * decoration) never claims alert rows and the opt-in alert sender can
     * never send a pending daily digest through the shared outbox.
     */
    private readonly scope?: DeliveryArtifactScope,
  ) {}
  /**
   * Claims at most one due row and sends it. Returns true when the provider
   * was contacted, so callers draining the outbox can loop; false means
   * nothing was due (or the row was cancelled at the claim boundary).
   */
  async send(now = this.clock()): Promise<boolean> {
    const claim = this.store.claim(
      now,
      this.scope ? { artifact: this.scope } : undefined,
    );
    if (!claim) return false;
    const message = this.store.message(claim);
    if (!message || !this.store.beginSend(claim, this.clock())) return false;
    try {
      const result = await this.provider.send(
        message,
        claim.idempotency_key,
        AbortSignal.timeout(20_000),
      );
      this.store.sent(claim, result.id, this.clock());
      return true;
    } catch (error) {
      this.store.fail(
        claim,
        error instanceof DeliveryProviderError ? error.kind : "ambiguous",
        this.clock(),
      );
      // A provider contact happened, even without acceptance.
      return true;
    }
  }
}
