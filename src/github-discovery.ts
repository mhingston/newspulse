import type { Store } from "./db/store";
import {
  normalizeDiscoveryQuery,
  type PlannedQuery,
} from "./discovery-planner";
import { ProfileStore, type Interest } from "./profiles";
import { assertDiscoveryRestoreElapsed } from "./discovery-restore-guard";
import { runDiscovery, type DiscoveryRunOptions } from "./discovery-service";
import { GithubSearchProvider } from "./adapters/github";
import type { SearchProvider, SearchResult } from "./search-provider";
import { restorePauseMessage } from "./scheduled-discovery";
import type { GithubDiscoveryConfig } from "./github-discovery-config";

const maxQueryChars = 256;
const defaultMinStars = 10;
const repositoryUrl =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/i;

/**
 * Deterministic repository-search queries from active interests. Each interest
 * contributes at most one query bounded by GitHub's 256-character limit. The
 * date window and star floor keep the result set reproducible per run; this is
 * an official-API approximation of relevant projects, not a trending feed.
 */
export function planGithubQueries(
  interests: Interest[],
  now: number,
  windowDays = 90,
): PlannedQuery[] {
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 365)
    throw new Error("Invalid GitHub discovery window");
  const since = new Date(Math.max(0, Math.floor(now)) - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const bounded = [...interests]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, 1000);
  const selected = new Map<string, PlannedQuery>();
  for (const interest of bounded) {
    const terms = [...new Set([...interest.entities, ...interest.keywords])]
      .map((term) => term.trim().replace(/"/g, ""))
      .filter(Boolean)
      .slice(0, 3)
      .map((term) => (term.includes(" ") ? `"${term}"` : term));
    if (!terms.length) continue;
    const query = buildGithubQuery(terms, since);
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

function buildGithubQuery(terms: string[], since: string): string | null {
  const base = ` in:description,readme pushed:>${since} stars:>${defaultMinStars}`;
  for (let count = terms.length; count >= 1; count--) {
    const query = `${terms.slice(0, count).join(" ")}${base}`;
    if (query.length <= maxQueryChars) return query;
  }
  // Drop the readme qualifier when a single term is still too long.
  const query = `${terms.slice(0, 1).join(" ")} pushed:>${since}`;
  return query.length <= maxQueryChars ? query : null;
}

/** A search hit for an already followed repository is not a new project. */
function followedRepositoryPaths(store: Store): Set<string> {
  return new Set(
    store
      .sources()
      .filter((source) => source.kind === "github" && !source.removed)
      .map((source) => {
        const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//i.exec(
          source.url,
        );
        return match
          ? `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`
          : source.url.toLowerCase();
      }),
  );
}

function allowGithubResult(query: PlannedQuery, followed: Set<string>) {
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
    const match = repositoryUrl.exec(result.url);
    if (match) {
      const path = `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
      if (
        followed.has(path) ||
        followed.has(`${path}/releases`) ||
        followed.has(`${path}/events`)
      )
        return false;
    }
    return true;
  };
}

/**
 * One budgeted GitHub search per scheduler tick, sharing the existing daily
 * discovery ledger so explicit GDELT queries, scheduled news queries and
 * repository discovery split the same durable budget and pacing.
 */
export async function runScheduledGithubDiscovery(
  store: Store,
  config: GithubDiscoveryConfig,
  now = Date.now(),
  provider: SearchProvider = new GithubSearchProvider(),
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
  const planned = planGithubQueries(
    new ProfileStore(store.sqlite).activeInterests(clock()),
    clock(),
    config.windowDays,
  );
  // Due-ness comes from the durable runs ledger; a restart never repeats an
  // attempt before its interval, and reserved pages block until reconciled.
  const due: PlannedQuery[] = [];
  for (const query of planned) {
    if (due.length >= slots) break;
    const last = store.sqlite
      .query<{ at: number | null }, [string]>(
        "SELECT max(r.started_at) AS at FROM discovery_runs r WHERE r.schedule_key=? AND EXISTS(SELECT 1 FROM discovery_pages p WHERE p.run_id=r.id)",
      )
      .get(query.key)!.at;
    if (last === null || last <= now - config.intervalMs) due.push(query);
  }
  if (!due.length) return 0;
  const followed = followedRepositoryPaths(store);
  const query = due[0]!;
  const runId = crypto.randomUUID();
  let dispatched = 0;
  try {
    const options: DiscoveryRunOptions = {
      runId,
      queryKind: query.kind,
      scheduleKey: query.key,
      interestLineage: query.interestLineage,
      allowResult: allowGithubResult(query, followed),
    };
    const outcome = await runDiscovery(
      store,
      provider,
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
    // Discovery is an optional stage. Persisted subscription polling remains
    // independent; the durable run records the failure for diagnostics.
  }
  return dispatched;
}

/** Defer restore gating until the optional GitHub stage is actually invoked. */
export function createGithubDiscoveryTick(
  dbPath: string,
  store: Store,
  config: GithubDiscoveryConfig,
): () => Promise<void> {
  return async () => {
    try {
      assertDiscoveryRestoreElapsed(dbPath);
    } catch (error) {
      if (error instanceof Error && error.message === restorePauseMessage)
        return;
      throw error;
    }
    await runScheduledGithubDiscovery(store, config);
  };
}
