import type { Store } from "./db/store";
import { DiscoveryPlannerStore } from "./db/discovery-planner-store";
import { ProfileStore } from "./profiles";
import { allocateQuerySlots, planDiscoveryQueries } from "./discovery-planner";
import { discoveryConfig } from "./discovery-config";
import { GdeltSearchProvider } from "./adapters/gdelt";
import { runDiscovery } from "./discovery-service";
import type { SearchProvider } from "./search-provider";
import { assertDiscoveryRestoreElapsed } from "./discovery-restore-guard";

export interface ScheduledDiscoveryConfig {
  limits: ReturnType<typeof discoveryConfig>;
  intervalMs: number;
  adjacentPercent: number;
}

const scheduleSyncTimes = new WeakMap<Store, number>();
const scheduleSyncIntervalMs = 60_000;
const restorePauseMessage =
  "Discovery is blocked until the next UTC day after restore";

/** Defer restore gating until the optional discovery stage is actually invoked. */
export function createScheduledDiscoveryTick(
  dbPath: string,
  store: Store,
  config: ScheduledDiscoveryConfig,
): () => Promise<void> {
  return async () => {
    try {
      assertDiscoveryRestoreElapsed(dbPath);
    } catch (error) {
      if (error instanceof Error && error.message === restorePauseMessage)
        return;
      throw error;
    }
    await runScheduledDiscovery(store, config);
  };
}

export async function runScheduledDiscovery(
  store: Store,
  config: ScheduledDiscoveryConfig,
  now = Date.now(),
  provider: SearchProvider = new GdeltSearchProvider(),
  clock: () => number = Date.now,
): Promise<number> {
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
  const state = new DiscoveryPlannerStore(store.sqlite);
  const lastSync = scheduleSyncTimes.get(store);
  if (
    lastSync === undefined ||
    now < lastSync ||
    now - lastSync >= scheduleSyncIntervalMs
  ) {
    const profiles = new ProfileStore(store.sqlite).activeInterests(now);
    const planned = planDiscoveryQueries(profiles);
    state.sync(planned, now, config.intervalMs);
    scheduleSyncTimes.set(store, now);
  }
  const due = state.due(now, 1000);
  const priorRuns = store.sqlite
    .query<{ total: number; adjacent: number }, [number]>(
      "SELECT count(*) AS total,coalesce(sum(r.query_kind='adjacent'),0) AS adjacent FROM discovery_runs r JOIN discovery_pages p ON p.run_id=r.id WHERE p.started_at>=?",
    )
    .get(dayStart)!;
  const selected = allocateQuerySlots(
    due,
    slots,
    config.adjacentPercent,
    priorRuns,
  );
  const validated =
    selected.length === 0
      ? []
      : (() => {
          const currentPlan = planDiscoveryQueries(
            new ProfileStore(store.sqlite).activeInterests(clock()),
          );
          const currentQueries = new Map(
            currentPlan.map((query) => [query.key, query]),
          );
          const staleSelection = selected.some((query) => {
            const current = currentQueries.get(query.key);
            return (
              !current ||
              current.query !== query.query ||
              current.kind !== query.kind ||
              current.interestId !== query.interestId ||
              current.interestVersion !== query.interestVersion ||
              current.priority !== query.priority ||
              JSON.stringify(current.negative) !==
                JSON.stringify(query.negative) ||
              JSON.stringify(current.interestLineage) !==
                JSON.stringify(query.interestLineage)
            );
          });
          if (staleSelection) {
            state.sync(currentPlan, now, config.intervalMs);
            scheduleSyncTimes.set(store, now);
            return [];
          }
          return selected.flatMap((query) => {
            const current = currentQueries.get(query.key);
            return current
              ? [
                  {
                    ...current,
                    nextDueAt: query.nextDueAt,
                    utility: query.utility,
                  },
                ]
              : [];
          });
        })();
  let dispatched = 0;
  for (const query of validated) {
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
          queryKind: query.kind,
          scheduleKey: query.key,
          interestLineage: query.interestLineage,
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
