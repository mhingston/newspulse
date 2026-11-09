import type { SourceAdapter } from "./domain";
import { HttpError } from "./adapters/rss";
import { Store } from "./db/store";
import { normalizeNewsletter } from "./adapters/newsletter";
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
          { maxEntries: source.max_entries, maxBytes: source.max_bytes },
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
  processing?: ProcessingWorker,
  inbound?: { retrieve(): Promise<void>; reconcile(): Promise<void> },
): { stop(): Promise<void> } {
  let active: Promise<unknown> | undefined;
  let stopping = false;
  const stageActive = new Map<string, Promise<unknown>>();
  let inboundNext = 0;
  const tick = () => {
    if (stopping) return;
    try {
      store.indexNextNewsletter(normalizeNewsletter);
    } catch (error) {
      log("newsletter_index_error", { error: String(error) });
    }
    if (inbound && Date.now() >= inboundNext && !stageActive.has("inbound")) {
      inboundNext = Date.now() + 2_000;
      const task = inbound
        .reconcile()
        .then(() => (stopping ? undefined : inbound.retrieve()))
        .catch((e) => log("inbound_worker_error", { error: String(e) }))
        .finally(() => stageActive.delete("inbound"));
      stageActive.set("inbound", task);
    }
    if (processing)
      for (const stage of ["extract", "analyse", "group", "score"] as const) {
        if (stageActive.has(stage)) continue;
        const task = processing
          .drain(stage, 20, () => stopping)
          .catch((e) => log("processing_error", { stage, error: String(e) }))
          .finally(() => stageActive.delete(stage));
        stageActive.set(stage, task);
      }
    if (active) return;
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
      await Promise.all(stageActive.values());
    },
  };
}

/** Handlers perform external work without writing to the store; completion is fenced. */
export type ProcessingHandler = (
  job: import("./db/store").ProcessingJob,
  signal: AbortSignal,
) => Promise<{
  status: string;
  result?: string;
  analysisRecord?: import("./db/store").AnalysisRecord;
  scoreRecord?: import("./db/store").ScoreRecord;
}>;
export class ProcessingWorker {
  private inFlight = new Set<string>();
  constructor(
    private store: Store,
    private handlers: Partial<
      Record<import("./db/store").ProcessingStage, ProcessingHandler>
    >,
    private timeoutMs = 50_000,
  ) {
    if (timeoutMs <= 0 || timeoutMs >= 60_000)
      throw new Error("Invalid processing timeout");
  }
  async drain(
    stage: import("./db/store").ProcessingStage,
    limit = 20,
    shouldStop: () => boolean = () => false,
  ): Promise<number> {
    const handler = this.handlers[stage];
    if (!handler || this.inFlight.has(stage)) return 0;
    let count = 0;
    while (count < limit && !shouldStop()) {
      const job = this.store.claimProcessing(stage);
      if (!job) break;
      count++;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.inFlight.add(stage);
      const running = Promise.resolve().then(() =>
        handler(job, controller.signal),
      );
      void running.then(
        () => this.inFlight.delete(stage),
        () => this.inFlight.delete(stage),
      );
      try {
        const output = await Promise.race([
          running,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Stage timed out"));
            }, this.timeoutMs);
          }),
        ]);
        if (output.analysisRecord)
          this.store.completeAnalysis(job, output.analysisRecord);
        else if (output.scoreRecord)
          this.store.completeScore(job, output.scoreRecord);
        else
          this.store.completeProcessing(
            job,
            output.status,
            Date.now(),
            output.result ?? null,
          );
      } catch (error) {
        this.store.failProcessing(
          job,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (this.inFlight.has(stage)) break;
    }
    return count;
  }
}
