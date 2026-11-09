import { InboundProviderError, type InboundEmailProvider } from "./inbound";
import { InboundStore } from "./db/inbound";
import { InboundWebhookError } from "./http";

const PROVIDER = "resend";
const PAGE_INTERVAL = 2_000;
const CYCLE_INTERVAL = 15 * 60_000;
const RETRY_INTERVAL = 60_000;

/** Verify synchronously and durably record before acknowledging; never fetch in this path. */
export function inboundWebhook(
  store: InboundStore,
  provider: InboundEmailProvider,
) {
  return (body: string, headers: Headers) => {
    let event;
    try {
      event = provider.verifyWebhook(body, {
        id: headers.get("svix-id") ?? "",
        timestamp: headers.get("svix-timestamp") ?? "",
        signature: headers.get("svix-signature") ?? "",
      });
    } catch {
      throw new InboundWebhookError();
    }
    store.recordEvent(PROVIDER, event);
  };
}

/** One bounded request per invocation. Cursor commits and message insertion share a transaction. */
export class InboundWorker {
  constructor(
    private store: InboundStore,
    private provider: InboundEmailProvider,
  ) {}
  async retrieve(): Promise<void> {
    const job = this.store.claimMessage();
    if (!job) return;
    try {
      const email = await this.provider.get(
        job.providerId,
        AbortSignal.timeout(20_000),
      );
      this.store.completeMessage(job, email, Date.now());
    } catch (error) {
      const kind =
        error instanceof InboundProviderError ? error.kind : "transient";
      this.store.failMessage(
        job,
        kind,
        RETRY_INTERVAL,
        kind === "unavailable",
        Date.now(),
      );
    }
  }
  async reconcile(): Promise<void> {
    const job = this.store.claimReconciliation(PROVIDER, Date.now());
    if (!job) return;
    try {
      const state = job.state as { after?: string; scanHead?: boolean } | null;
      const scanningHead = Boolean(state?.after && state.scanHead);
      const cursor = scanningHead ? undefined : state?.after;
      const page = await this.provider.list(
        cursor,
        AbortSignal.timeout(20_000),
      );
      const last = page.items.at(-1)?.providerId;
      if (page.hasMore && (!last || last === cursor))
        throw new Error("Invalid pagination cursor");
      const now = Date.now();
      this.store.commitPage(
        job,
        page.items,
        scanningHead
          ? { after: state?.after, scanHead: false }
          : page.hasMore
            ? { after: last, scanHead: true }
            : {},
        now + (scanningHead || page.hasMore ? PAGE_INTERVAL : CYCLE_INTERVAL),
        now,
      );
    } catch {
      this.store.failReconciliation(
        job,
        "transient",
        RETRY_INTERVAL,
        Date.now(),
      );
    }
  }
}
