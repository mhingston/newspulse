import type { Store } from "./db/store";
import {
  normalizeDiscoveryQuery,
  type PlannedQuery,
} from "./discovery-planner";
import { ProfileStore, type Interest } from "./profiles";
import { assertDiscoveryRestoreElapsed } from "./discovery-restore-guard";
import { runDiscovery, type DiscoveryRunOptions } from "./discovery-service";
import {
  HackerNewsSearchProvider,
  type HackerNewsFetcher,
} from "./adapters/hackernews";
import type { SearchProvider, SearchResult } from "./search-provider";
import { restorePauseMessage } from "./scheduled-discovery";
import type { HnDiscoveryConfig } from "./hn-discovery-config";

const maxQueryChars = 256;
const discussionUrl =
  /^https:\/\/news\.ycombinator\.com\/item\?id=([1-9]\d{0,9})$/;
const discussionInText = /news\.ycombinator\.com\/item\?id=([1-9]\d{0,9})/g;

/**
 * Deterministic HN search queries from active interests. Each interest
 * contributes at most one query bounded by the search API's query limit.
 */
export function planHnQueries(interests: Interest[]): PlannedQuery[] {
  const bounded = [...interests]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, 1000);
  const selected = new Map<string, PlannedQuery>();
  for (const interest of bounded) {
    const terms = [...new Set([...interest.entities, ...interest.keywords])]
      .map((term) => term.trim().replace(/"/g, ""))
      .filter(Boolean)
      .slice(0, 4);
    if (!terms.length) continue;
    const query = terms.join(" ").slice(0, maxQueryChars);
    if (!query) continue;
    const key = normalizeDiscoveryQuery(query);
    const candidate: PlannedQuery = {
      key,
      query,
      kind: "interest",
      interestId: interest.id,
      interestVersion: interest.version,
      interestLineage: [{ id: interest.id, version: interest.version }],
      priority: interest.priority * 100,
      negative: [...new Set(interest.negative)],
    };
    const prior = selected.get(key);
    if (!prior) selected.set(key, candidate);
    else
      selected.set(key, {
        ...candidate,
        priority: Math.max(prior.priority, candidate.priority),
        negative: [...new Set([...prior.negative, ...candidate.negative])],
        interestLineage: [
          ...new Map(
            [...prior.interestLineage, ...candidate.interestLineage].map(
              (entry) => [`${entry.id}@${entry.version}`, entry] as const,
            ),
          ).values(),
        ],
      });
  }
  return [...selected.values()];
}

/** Stable cadence identity; the query text is stable but lineage is explicit. */
function hnScheduleKey(query: PlannedQuery): string {
  const lineage = query.interestLineage
    .map((entry) => `${entry.id}@${entry.version}`)
    .sort()
    .join(",");
  return `hackernews:${lineage || normalizeDiscoveryQuery(query.query)}`;
}

/** Followed HN discussions are not reported again as new discoveries. */
function followedDiscussionIds(store: Store): Set<string> {
  const ids = new Set<string>();
  for (const source of store.sources()) {
    const match = discussionUrl.exec(source.url);
    if (match) ids.add(match[1]!);
  }
  return ids;
}

function allowHnResult(query: PlannedQuery, followed: Set<string>) {
  return (result: SearchResult): boolean => {
    const text = `${result.title} ${result.snippet ?? ""}`.toLocaleLowerCase(
      "en-US",
    );
    if (
      query.negative.some((term) =>
        text.includes(term.toLocaleLowerCase("en-US")),
      )
    )
      return false;
    // The result may surface the linked article, with the discussion URL only
    // in the snippet; either way a followed discussion is not new.
    const ids = [
      ...`${result.url} ${result.snippet ?? ""}`.matchAll(discussionInText),
    ].map((match) => match[1]!);
    const direct = discussionUrl.exec(result.url);
    if (direct) ids.push(direct[1]!);
    return !ids.some((id) => followed.has(id));
  };
}

/**
 * One budgeted HN search per scheduler tick, sharing the existing daily
 * discovery ledger so explicit queries, scheduled news queries, repository
 * discovery and HN discovery split the same durable budget and pacing.
 */
export async function runScheduledHnDiscovery(
  store: Store,
  config: HnDiscoveryConfig,
  now = Date.now(),
  provider?: SearchProvider,
  clock: () => number = Date.now,
): Promise<number> {
  const searchProvider = provider ?? new HackerNewsSearchProvider();
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
      "SELECT max(coalesce(finished_at,started_at)) AS at FROM discovery_pages WHERE budget_day>=?",
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
  const planned = planHnQueries(
    new ProfileStore(store.sqlite).activeInterests(clock()),
  );
  const due: PlannedQuery[] = [];
  for (const query of planned) {
    if (due.length >= slots) break;
    const last = store.sqlite
      .query<{ at: number | null }, [string]>(
        "SELECT max(r.started_at) AS at FROM discovery_runs r WHERE r.schedule_key=? AND EXISTS(SELECT 1 FROM discovery_pages p WHERE p.run_id=r.id)",
      )
      .get(hnScheduleKey(query))!.at;
    if (last === null || last <= now - config.intervalMs) due.push(query);
  }
  if (!due.length) return 0;
  const followed = followedDiscussionIds(store);
  const query = due[0]!;
  const runId = crypto.randomUUID();
  let dispatched = 0;
  try {
    const options: DiscoveryRunOptions = {
      runId,
      queryKind: query.kind,
      scheduleKey: hnScheduleKey(query),
      interestLineage: query.interestLineage,
      allowResult: allowHnResult(query, followed),
    };
    const outcome = await runDiscovery(
      store,
      searchProvider,
      query.query,
      {
        ...config.limits,
        maxQueriesPerRun: 1,
      },
      clock,
      options,
    );
    if (outcome.pages > 0) dispatched++;
  } catch {
    // Discovery is optional; persisted subscription polling remains
    // independent and the durable run records the failure for diagnostics.
  }
  return dispatched;
}

/** Defer restore gating until the optional HN stage is actually invoked. */
export function createHnDiscoveryTick(
  dbPath: string,
  store: Store,
  config: HnDiscoveryConfig,
  fetcher?: HackerNewsFetcher,
): () => Promise<void> {
  return async () => {
    try {
      assertDiscoveryRestoreElapsed(dbPath);
    } catch (error) {
      if (error instanceof Error && error.message === restorePauseMessage)
        return;
      throw error;
    }
    await runScheduledHnDiscovery(
      store,
      config,
      Date.now(),
      new HackerNewsSearchProvider(fetcher),
    );
  };
}
