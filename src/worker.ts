import type { PollResult, PollState, SourceAdapter } from "./domain";
import type { Job } from "./db/store";
import { HttpError } from "./adapters/rss";
import { Store } from "./db/store";
import { normalizeNewsletter } from "./adapters/newsletter";
import { pruneHistoricalDigestActivity } from "./historical-digest";
export function log(event: string, details: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({ at: new Date().toISOString(), event, ...details }),
  );
}
export interface PollLimits {
  /** Polls running at once across all sources. */
  concurrency: number;
  /** Polls running at once against one host, so a slow host cannot take every slot. */
  perHost: number;
}

export function hostOfSource(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

export class Worker {
  constructor(
    private store: Store,
    private adapter: SourceAdapter,
    private limits: PollLimits = { concurrency: 1, perHost: 1 },
  ) {
    if (
      !Number.isSafeInteger(limits.concurrency) ||
      limits.concurrency < 1 ||
      !Number.isSafeInteger(limits.perHost) ||
      limits.perHost < 1
    )
      throw new Error("Invalid poll limits");
  }
  async drain(
    limit = 20,
    shouldStop: () => boolean = () => false,
  ): Promise<number> {
    let processed = 0;
    const active = new Set<Promise<void>>();
    const claimNext = () =>
      this.store.claim(Date.now(), {
        hostLimit: this.limits.perHost,
        hostOf: hostOfSource,
      });
    // Claims are serialized by the store transaction; polls themselves overlap.
    while (!shouldStop()) {
      while (
        active.size < this.limits.concurrency &&
        processed < limit &&
        !shouldStop()
      ) {
        const job = claimNext();
        if (!job) break;
        processed++;
        const run = this.runJob(job).finally(() => active.delete(run));
        active.add(run);
      }
      if (active.size === 0) break;
      await Promise.race(active);
    }
    await Promise.all(active);
    return processed;
  }
  private async runJob(job: Job): Promise<void> {
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
}

export interface SourceRoute {
  matches: (url: string) => boolean;
  adapter: SourceAdapter;
}
/** Dispatch polls per source URL so provider adapters stay behind one contract. */
export class SourceRouter implements SourceAdapter {
  constructor(
    private readonly routes: SourceRoute[],
    private readonly fallback: SourceAdapter,
  ) {}
  async poll(
    url: string,
    state: PollState,
    limits?: { maxEntries: number; maxBytes: number },
  ): Promise<PollResult> {
    const adapter =
      this.routes.find((route) => route.matches(url))?.adapter ?? this.fallback;
    return adapter.poll(url, state, limits);
  }
}
export function schedule(
  store: Store,
  worker: Worker,
  processing?: ProcessingWorker,
  inbound?: { retrieve(): Promise<void>; reconcile(): Promise<void> },
  publication?: { tick(): Promise<void> },
  discovery?: { tick(): Promise<void> },
  githubDiscovery?: { tick(): Promise<void> },
  hnDiscovery?: { tick(): Promise<void> },
): { stop(): Promise<void> } {
  let active: Promise<unknown> | undefined;
  let stopping = false;
  const stageActive = new Map<string, Promise<unknown>>();
  let inboundNext = 0;
  let digestHistoryPruneNext = 0;
  const tick = () => {
    if (stopping) return;
    const now = Date.now();
    if (now >= digestHistoryPruneNext) {
      digestHistoryPruneNext = now + 3_600_000;
      try {
        pruneHistoricalDigestActivity(store, now);
      } catch (error) {
        log("digest_history_prune_error", { error: String(error) });
      }
    }
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
    if (publication && !stageActive.has("publication")) {
      const task = publication
        .tick()
        .catch(() => log("publication_worker_error"))
        .finally(() => stageActive.delete("publication"));
      stageActive.set("publication", task);
    }
    if (discovery && !stageActive.has("discovery")) {
      const task = discovery
        .tick()
        .catch((e) => log("discovery_scheduler_error", { error: String(e) }))
        .finally(() => stageActive.delete("discovery"));
      stageActive.set("discovery", task);
    }
    if (githubDiscovery && !stageActive.has("githubDiscovery")) {
      const task = githubDiscovery
        .tick()
        .catch((e) =>
          log("github_discovery_scheduler_error", { error: String(e) }),
        )
        .finally(() => stageActive.delete("githubDiscovery"));
      stageActive.set("githubDiscovery", task);
    }
    if (hnDiscovery && !stageActive.has("hnDiscovery")) {
      const task = hnDiscovery
        .tick()
        .catch((e) => log("hn_discovery_scheduler_error", { error: String(e) }))
        .finally(() => stageActive.delete("hnDiscovery"));
      stageActive.set("hnDiscovery", task);
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
export type StageConcurrency = Partial<
  Record<import("./db/store").ProcessingStage, number>
>;

/**
 * Runs each processing stage with its own bounded concurrency. A slot is held
 * until its handler actually settles: a job can be failed on timeout while a
 * non-cooperative handler keeps running, and that handler must keep counting
 * against the stage ceiling rather than being oversubscribed.
 */
type HandlerResult =
  | { ok: true; output: Awaited<ReturnType<ProcessingHandler>> }
  | { ok: false; error: string };

export class ProcessingWorker {
  private running = new Map<string, number>();
  constructor(
    private store: Store,
    private handlers: Partial<
      Record<import("./db/store").ProcessingStage, ProcessingHandler>
    >,
    private timeoutMs = 50_000,
    private concurrency: StageConcurrency = {},
  ) {
    if (timeoutMs <= 0 || timeoutMs >= 60_000)
      throw new Error("Invalid processing timeout");
    for (const value of Object.values(concurrency))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid stage concurrency");
  }
  private limitFor(stage: import("./db/store").ProcessingStage): number {
    return this.concurrency[stage] ?? 1;
  }
  async drain(
    stage: import("./db/store").ProcessingStage,
    limit = 20,
    shouldStop: () => boolean = () => false,
  ): Promise<number> {
    const handler = this.handlers[stage];
    if (!handler) return 0;
    let count = 0;
    const jobs = new Set<Promise<void>>();
    const slots = () => this.running.get(stage) ?? 0;
    while (!shouldStop()) {
      while (slots() < this.limitFor(stage) && count < limit && !shouldStop()) {
        const job = this.store.claimProcessing(stage);
        if (!job) break;
        count++;
        this.running.set(stage, slots() + 1);
        const handlerDone = this.invoke(handler, job).finally(() => {
          this.running.set(stage, slots() - 1);
        });
        const jobDone = this.finish(job, handlerDone);
        jobs.add(jobDone);
        void jobDone.finally(() => jobs.delete(jobDone));
      }
      if (jobs.size === 0) break;
      await Promise.race(jobs);
      if (count >= limit && jobs.size === 0) break;
    }
    await Promise.all(jobs);
    return count;
  }
  /** Settles when the handler returns or throws, whether or not the job was failed. */
  private invoke(
    handler: ProcessingHandler,
    job: import("./db/store").ProcessingJob,
  ): Promise<HandlerResult> {
    const controller = new AbortController();
    this.aborters.set(job.id, controller);
    return Promise.resolve()
      .then(() => handler(job, controller.signal))
      .then(
        (output): HandlerResult => ({ ok: true, output }),
        (error: unknown): HandlerResult => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => this.aborters.delete(job.id));
  }
  /** Completes or fails the job exactly once; a timeout fails it without releasing the slot. */
  private async finish(
    job: import("./db/store").ProcessingJob,
    handlerDone: Promise<HandlerResult>,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<HandlerResult>((resolve) => {
      timer = setTimeout(() => {
        this.aborters.get(job.id)?.abort();
        resolve({ ok: false, error: "Stage timed out" });
      }, this.timeoutMs);
    });
    const result = await Promise.race([handlerDone, timedOut]);
    if (timer) clearTimeout(timer);
    try {
      if (!result.ok) {
        this.store.failProcessing(job, result.error);
        return;
      }
      const output = result.output;
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
    }
  }
  private aborters = new Map<string, AbortController>();
}
