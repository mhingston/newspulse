import type { Database } from "bun:sqlite";

export interface DiscoveryLimits {
  dailyQueries: number;
  dailyResults: number;
  dailyCostMicros: number;
  runQueries: number;
  runResults: number;
  runCostMicros: number;
}
export interface DiscoveryObservation {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: number;
  observedAt?: number;
}
function boundedText(value: string, max: number, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw new Error("Invalid discovery text");
}
function natural(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid discovery budget or time");
}
function json(value: unknown, max: number): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > max)
    throw new Error("Invalid discovery data");
  return encoded;
}

/** Provider requests are made outside transactions; reservations are never released. */
export class DiscoveryStore {
  constructor(private readonly db: Database) {}

  /** GDELT tolerates short gaps; GitHub's search quota needs a minute pacing. */
  private pacingGapMs(provider: string): number | null {
    if (provider === "github") return 6_010;
    if (provider === "gdelt") return 5_000;
    // Algolia has no documented per-second limit; keep a conservative gap so a
    // scheduler bug cannot burst requests.
    if (provider === "hackernews") return 5_000;
    return null;
  }
  createRun(input: {
    id: string;
    query: string;
    provider: string;
    providerVersion: string;
    now: number;
    queryKind?: "manual" | "interest" | "adjacent";
    scheduleKey?: string;
    interestLineage?: Array<{ id: string; version: number }>;
  }) {
    boundedText(input.id, 128);
    boundedText(input.query, 1000);
    boundedText(input.provider, 128);
    boundedText(input.providerVersion, 128);
    natural(input.now);
    if (
      input.queryKind !== undefined &&
      !["manual", "interest", "adjacent"].includes(input.queryKind)
    )
      throw new Error("Invalid discovery query kind");
    if (input.scheduleKey !== undefined) boundedText(input.scheduleKey, 500);
    const lineage = input.interestLineage ?? [];
    if (
      lineage.length > 1000 ||
      lineage.some(
        (entry) =>
          !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(entry.id) ||
          !Number.isSafeInteger(entry.version) ||
          entry.version < 1,
      )
    )
      throw new Error("Invalid discovery interest lineage");
    const lineageJson = json(lineage, 65536);
    this.db
      .transaction(() => {
        const sources = this.db
          .query<{ id: string }, []>(
            "SELECT id FROM sources WHERE kind IN ('rss','github','hackernews') AND enabled=1 AND removed=0 ORDER BY id LIMIT 10001",
          )
          .all();
        if (sources.length > 10000)
          throw new Error("Too many subscribed sources");
        const highWater = this.db
          .query<{ n: number }, []>(
            "SELECT coalesce(max(id),0) AS n FROM item_sources",
          )
          .get()!.n;
        const snapshot = json(
          { sources: sources.map((source) => source.id), highWater },
          1024 * 1024,
        );
        this.db
          .query(
            "INSERT INTO discovery_runs(id,query,provider,provider_version,subscription_snapshot,status,started_at,query_kind,schedule_key,interest_lineage) VALUES(?,?,?,?,?,'running',?,?,?,?)",
          )
          .run(
            input.id,
            input.query,
            input.provider,
            input.providerVersion,
            snapshot,
            input.now,
            input.queryKind ?? "manual",
            input.scheduleKey ?? null,
            lineageJson,
          );
      })
      .immediate();
  }

  reservePage(input: {
    id: string;
    runId: string;
    cursor?: string;
    now: number;
    reservedResults: number;
    reservedCostMicros: number;
    limits: DiscoveryLimits;
  }): number {
    boundedText(input.id, 128);
    boundedText(input.runId, 128);
    if (input.cursor !== undefined) boundedText(input.cursor, 2048, true);
    natural(input.now);
    natural(input.reservedResults);
    natural(input.reservedCostMicros);
    if (input.reservedResults < 1 || input.reservedResults > 250)
      throw new Error("Invalid discovery result reservation");
    for (const value of Object.values(input.limits)) natural(value);
    return this.db
      .transaction(() => {
        const run = this.db
          .query<{ status: string; provider: string }, [string]>(
            "SELECT status,provider FROM discovery_runs WHERE id=?",
          )
          .get(input.runId);
        if (!run || run.status !== "running")
          throw new Error("Discovery run is not running");
        // Hold the provider slot through completion; a pre-dispatch timestamp alone
        // cannot pace a process that is paused before making its request. Unknown
        // outcomes retain the slot until an operator investigates with workers stopped.
        const pacingGap = this.pacingGapMs(run.provider);
        if (
          pacingGap !== null &&
          this.db
            .query<{ found: number }, [string, number]>(
              "SELECT EXISTS(SELECT 1 FROM discovery_pages p JOIN discovery_runs r ON r.id=p.run_id WHERE r.provider=? AND (p.status='reserved' OR p.finished_at>?)) AS found",
            )
            .get(run.provider, input.now - pacingGap)!.found
        )
          return 0;
        const day = Math.floor(input.now / 86400000);
        const daily = this.db
          .query<
            { queries: number; results: number; cost: number },
            [number, number]
          >(
            "SELECT count(*) AS queries,coalesce(sum(reserved_results),0) AS results,coalesce(sum(reserved_cost_micros),0) AS cost FROM discovery_pages WHERE budget_day>=? OR status='reserved' OR finished_at>=?",
          )
          .get(day, day * 86400000)!;
        const used = this.db
          .query<{ queries: number; results: number; cost: number }, [string]>(
            "SELECT count(*) AS queries,coalesce(sum(reserved_results),0) AS results,coalesce(sum(reserved_cost_micros),0) AS cost FROM discovery_pages WHERE run_id=?",
          )
          .get(input.runId)!;
        const l = input.limits;
        if (
          daily.queries >= l.dailyQueries ||
          daily.cost + input.reservedCostMicros > l.dailyCostMicros ||
          used.queries >= l.runQueries ||
          used.cost + input.reservedCostMicros > l.runCostMicros
        )
          return 0;
        const reservedResults = Math.min(
          input.reservedResults,
          l.dailyResults - daily.results,
          l.runResults - used.results,
        );
        if (reservedResults <= 0) return 0;
        this.db
          .query(
            "INSERT INTO discovery_pages(id,run_id,cursor,budget_day,reserved_results,reserved_cost_micros,status,started_at) VALUES(?,?,?,?,?,?,'reserved',?)",
          )
          .run(
            input.id,
            input.runId,
            input.cursor ?? null,
            day,
            reservedResults,
            input.reservedCostMicros,
            input.now,
          );
        return reservedResults;
      })
      .immediate();
  }

  completePage(
    input: {
      id: string;
      now: number;
      nextCursor?: string;
      actualCostMicros?: number;
      usage?: unknown;
      results: DiscoveryObservation[];
    },
    ingest: (results: DiscoveryObservation[]) => string[],
  ): boolean {
    boundedText(input.id, 128);
    natural(input.now);
    if (input.nextCursor !== undefined)
      boundedText(input.nextCursor, 2048, true);
    if (input.actualCostMicros !== undefined) natural(input.actualCostMicros);
    if (!Array.isArray(input.results) || input.results.length > 250)
      throw new Error("Invalid discovery results");
    for (const result of input.results) {
      boundedText(result.url, 8192);
      boundedText(result.title, 1000);
      boundedText(result.snippet ?? "", 10000, true);
      if (result.publishedAt !== undefined) natural(result.publishedAt);
      if (result.observedAt !== undefined) natural(result.observedAt);
    }
    const usage = input.usage === undefined ? null : json(input.usage, 65536);
    return this.db
      .transaction(() => {
        const page = this.db
          .query<
            {
              run_id: string;
              reserved_results: number;
              reserved_cost_micros: number;
              started_at: number;
              subscription_snapshot: string;
            },
            [string]
          >(
            "SELECT p.run_id,p.reserved_results,p.reserved_cost_micros,p.started_at,r.subscription_snapshot FROM discovery_pages p JOIN discovery_runs r ON r.id=p.run_id WHERE p.id=? AND p.status='reserved' AND r.status='running'",
          )
          .get(input.id);
        if (!page) return false;
        if (
          input.results.length > page.reserved_results ||
          (input.actualCostMicros !== undefined &&
            input.actualCostMicros > page.reserved_cost_micros) ||
          input.now < page.started_at
        )
          throw new Error("Discovery response exceeds reservation");
        const ids = ingest(input.results);
        if (ids.length !== input.results.length)
          throw new Error("Discovery ingestion count mismatch");
        const snapshot = JSON.parse(page.subscription_snapshot) as {
          sources: string[];
          highWater: number;
        };
        const isSubscribed = this.db.query<
          { found: number },
          [string, string, number]
        >(
          "SELECT EXISTS(SELECT 1 FROM item_sources WHERE item_id=? AND source_id IN (SELECT value FROM json_each(?)) AND id<=?) AS found",
        );
        const insert = this.db.query(
          "INSERT INTO discovery_results(page_id,item_id,url,title,snippet,published_at,observed_at,origin) VALUES(?,?,?,?,?,?,?,?)",
        );
        for (let i = 0; i < input.results.length; i++) {
          const item = input.results[i]!;
          const itemId = ids[i]!;
          boundedText(itemId, 128);
          insert.run(
            input.id,
            itemId,
            item.url,
            item.title,
            item.snippet ?? "",
            item.publishedAt ?? null,
            item.observedAt ?? null,
            isSubscribed.get(
              itemId,
              JSON.stringify(snapshot.sources),
              snapshot.highWater,
            )!.found
              ? "subscribed"
              : "discovered",
          );
        }
        this.db
          .query(
            "UPDATE discovery_pages SET status='completed',next_cursor=?,actual_cost_micros=?,usage=?,finished_at=?,latency_ms=? WHERE id=? AND status='reserved'",
          )
          .run(
            input.nextCursor ?? null,
            input.actualCostMicros ?? null,
            usage,
            input.now,
            input.now - page.started_at,
            input.id,
          );
        return true;
      })
      .immediate();
  }

  failPage(id: string, now: number, error: string): boolean {
    boundedText(id, 128);
    natural(now);
    if (!/^[a-z0-9_]{1,80}$/.test(error))
      throw new Error("Invalid discovery error code");
    return (
      this.db
        .query(
          "UPDATE discovery_pages SET status='failed',finished_at=?,latency_ms=max(0,?-started_at),last_error=? WHERE id=? AND status='reserved'",
        )
        .run(now, now, error, id).changes === 1
    );
  }

  finishRun(id: string, now: number, error?: string): boolean {
    boundedText(id, 128);
    natural(now);
    if (error !== undefined && !/^[a-z0-9_]{1,80}$/.test(error))
      throw new Error("Invalid discovery error code");
    return (
      this.db
        .query(
          "UPDATE discovery_runs SET status=?,finished_at=?,last_error=? WHERE id=? AND status='running'",
        )
        .run(
          error === "budget_exhausted"
            ? "budget_exhausted"
            : error
              ? "failed"
              : "completed",
          now,
          error ?? null,
          id,
        ).changes === 1
    );
  }
}
