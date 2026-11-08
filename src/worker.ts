import type { SourceAdapter } from "./domain";
import { HttpError } from "./adapters/rss";
import { Store } from "./db/store";
export function log(event: string, details: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({ at: new Date().toISOString(), event, ...details }),
  );
}
export class Worker {
  constructor(
    private store: Store,
    private adapter: SourceAdapter,
  ) {}
  async drain(
    limit = 20,
    shouldStop: () => boolean = () => false,
  ): Promise<number> {
    let processed = 0;
    while (processed < limit && !shouldStop()) {
      const job = this.store.claim();
      if (!job) break;
      processed++;
      try {
        const source = this.store.source(job.source_id);
        if (!source) throw new Error("Source no longer exists");
        const start = Date.now();
        const result = await this.adapter.poll(
          source.url,
          this.store.state(source.id),
        );
        const committed = this.store.complete(job, result);
        log("poll_completed", {
          source_id: source.id,
          items: result.items.length,
          committed,
          duration_ms: Date.now() - start,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.fail(
          job,
          message,
          error instanceof HttpError ? error.retryAfterMs : 0,
        );
        log("poll_failed", {
          source_id: job.source_id,
          error: message,
          attempt: job.attempts,
        });
      }
    }
    return processed;
  }
}
export function schedule(
  store: Store,
  worker: Worker,
): { stop(): Promise<void> } {
  let active: Promise<unknown> | undefined;
  let stopping = false;
  const tick = () => {
    if (active || stopping) return;
    active = (async () => {
      store.enqueueDue();
      await worker.drain(20, () => stopping);
    })()
      .catch((e) => log("worker_error", { error: String(e) }))
      .finally(() => {
        active = undefined;
      });
  };
  // Persisted next_poll is authoritative; cron is only a wake-up signal.
  const cron = Bun.cron("* * * * *", tick);
  const interval = setInterval(tick, 1000);
  tick();
  return {
    async stop() {
      stopping = true;
      cron.stop();
      clearInterval(interval);
      await active;
    },
  };
}
