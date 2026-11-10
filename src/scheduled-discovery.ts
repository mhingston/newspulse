import type { Store } from "./db/store";
import { DiscoveryPlannerStore } from "./db/discovery-planner-store";
import { ProfileStore } from "./profiles";
import { allocateQuerySlots, planDiscoveryQueries } from "./discovery-planner";
import { discoveryConfig } from "./discovery-config";
import { GdeltSearchProvider } from "./adapters/gdelt";
import { runDiscovery } from "./discovery-service";
import type { SearchProvider } from "./search-provider";

export interface ScheduledDiscoveryConfig {
  limits: ReturnType<typeof discoveryConfig>;
  intervalMs: number;
  adjacentPercent: number;
}

export async function runScheduledDiscovery(
  store: Store,
  config: ScheduledDiscoveryConfig,
  now = Date.now(),
  provider: SearchProvider = new GdeltSearchProvider(),
  clock: () => number = Date.now,
): Promise<number> {
  const profiles = new ProfileStore(store.sqlite).activeInterests(now);
  const planned = planDiscoveryQueries(profiles);
  const state = new DiscoveryPlannerStore(store.sqlite);
  state.sync(planned, now, config.intervalMs);
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const dailyUsage = store.sqlite
    .query<
      { queries: number; results: number; micros: number },
      [number, number]
    >(
      "SELECT count(*) AS queries,coalesce(sum(reserved_results),0) AS results,coalesce(sum(reserved_cost_micros),0) AS micros FROM discovery_pages WHERE budget_day>=? OR status='reserved' OR finished_at>=?",
    )
    .get(Math.floor(now / 86_400_000), dayStart)!;
  const unresolved = store.sqlite
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM discovery_pages WHERE status='reserved'",
    )
    .get()!.n;
  if (unresolved > 0) return 0;
  const latestPage = store.sqlite
    .query<{ at: number | null }, [number]>(
      "SELECT max(coalesce(finished_at,started_at)) AS at FROM discovery_pages WHERE status='reserved' OR budget_day>=?",
    )
    .get(Math.floor(now / 86_400_000))!.at;
  if (latestPage !== null && now - latestPage < 5000) return 0;
  const costSlots = Math.floor(
    (config.limits.maxCostMicrosPerDay - dailyUsage.micros) /
      config.limits.reservedCostMicrosPerQuery,
  );
  const slots = Math.max(
    0,
    Math.min(
      1,
      config.limits.maxQueriesPerRun,
      config.limits.maxQueriesPerDay - dailyUsage.queries,
      costSlots,
    ),
  );
  if (!slots || dailyUsage.results >= config.limits.maxResultsPerDay) return 0;
  const due = state.due(now, 1000);
  const priorRuns = store.sqlite
    .query<{ total: number; adjacent: number }, [number]>(
      "SELECT count(*) AS total,coalesce(sum(kind='adjacent'),0) AS adjacent FROM discovery_query_state WHERE last_run_at>=?",
    )
    .get(dayStart)!;
  const selected = allocateQuerySlots(
    due,
    slots,
    config.adjacentPercent,
    priorRuns,
  );
  let dispatched = 0;
  for (const query of selected) {
    const runId = crypto.randomUUID();
    try {
      const outcome = await runDiscovery(
        store,
        provider,
        query.query,
        {
          ...config.limits,
          maxQueriesPerDay: config.limits.maxQueriesPerDay,
          maxQueriesPerRun: 1,
        },
        clock,
        {
          runId,
          beforeDispatch: (id) =>
            state.markAttempt(query.key, id, clock(), config.intervalMs),
          allowResult: (result) =>
            !query.negative.some((term) =>
              `${result.title} ${result.snippet ?? ""}`
                .toLocaleLowerCase("en-US")
                .includes(term.toLocaleLowerCase("en-US")),
            ),
        },
      );
      if (outcome.pages > 0) dispatched++;
    } catch {
      // Discovery is an optional stage. Persisted subscription polling remains independent.
      if (
        !store.sqlite
          .query("SELECT 1 FROM discovery_runs WHERE id=?")
          .get(runId)
      )
        state.markAttempt(query.key, runId, clock(), config.intervalMs);
    }
  }
  return dispatched;
}
