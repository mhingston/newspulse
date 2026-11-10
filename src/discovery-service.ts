import type { Store } from "./db/store";
import { DiscoveryStore } from "./db/discovery-store";
import { canonicalUrl, resolvedUrl } from "./domain";
import { normalizeDiscoveryQuery } from "./discovery-planner";
import type { SearchProvider, SearchResult } from "./search-provider";

export interface DiscoveryLimits {
  maxQueriesPerDay: number;
  maxQueriesPerRun: number;
  maxResultsPerDay: number;
  maxResultsPerRun: number;
  maxCostMicrosPerDay: number;
  maxCostMicrosPerRun: number;
  reservedCostMicrosPerQuery: number;
}
export interface DiscoveryOutcome {
  runId: string;
  status: "complete" | "failed" | "budget_exhausted";
  pages: number;
  results: number;
}
export interface DiscoveryRunOptions {
  runId?: string;
  queryKind?: "manual" | "interest" | "adjacent";
  scheduleKey?: string;
  interestLineage?: Array<{ id: string; version: number }>;
  beforeDispatch?: (runId: string) => void;
  allowResult?: (result: SearchResult) => boolean;
}

/** Execute a bounded, explicit query. Each dispatch is charged before network work. */
export async function runDiscovery(
  store: Store,
  provider: SearchProvider,
  query: string,
  limits: DiscoveryLimits,
  clock: () => number = Date.now,
  options: DiscoveryRunOptions = {},
): Promise<DiscoveryOutcome> {
  query = query.trim();
  if (!query || query.length > 500 || /[\u0000-\u001f\u007f]/.test(query))
    throw new Error("Invalid discovery query");
  if (
    !provider.name ||
    !provider.version ||
    provider.name.length > 100 ||
    provider.version.length > 100
  )
    throw new Error("Invalid discovery provider");
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid discovery budget");
  if (limits.maxQueriesPerRun > 100 || limits.maxResultsPerRun > 10000)
    throw new Error("Discovery run limit exceeds hard ceiling");
  const repository = new DiscoveryStore(store.sqlite);
  const runId = options.runId ?? crypto.randomUUID();
  repository.createRun({
    id: runId,
    query,
    provider: provider.name,
    providerVersion: provider.version,
    now: clock(),
    queryKind: options.queryKind,
    scheduleKey: options.scheduleKey ?? normalizeDiscoveryQuery(query),
    interestLineage: options.interestLineage,
  });
  let notifiedDispatch = false;
  let cursor: string | undefined;
  const cursors = new Set<string>();
  let pages = 0;
  let results = 0;
  let reserved = 0;
  let status: DiscoveryOutcome["status"] = "complete";
  for (
    let index = 0;
    index < limits.maxQueriesPerRun && reserved < limits.maxResultsPerRun;
    index++
  ) {
    const now = clock();
    const pageId = crypto.randomUUID();
    const reservation = repository.reservePage({
      id: pageId,
      runId,
      cursor,
      now,
      reservedResults: Math.min(
        250,
        Math.ceil(
          (limits.maxResultsPerRun - reserved) /
            (limits.maxQueriesPerRun - index),
        ),
      ),
      reservedCostMicros: limits.reservedCostMicrosPerQuery,
      limits: {
        dailyQueries: limits.maxQueriesPerDay,
        dailyResults: limits.maxResultsPerDay,
        dailyCostMicros: limits.maxCostMicrosPerDay,
        runQueries: limits.maxQueriesPerRun,
        runResults: limits.maxResultsPerRun,
        runCostMicros: limits.maxCostMicrosPerRun,
      },
    });
    if (!reservation) {
      status = "budget_exhausted";
      break;
    }
    if (!notifiedDispatch) {
      options.beforeDispatch?.(runId);
      notifiedDispatch = true;
    }
    reserved += reservation;
    pages++;
    let page;
    try {
      page = await provider.search({ query, limit: reservation, cursor });
      if (
        !page ||
        !Array.isArray(page.results) ||
        page.results.length > reservation ||
        typeof page.truncated !== "boolean" ||
        (page.nextCursor !== undefined &&
          (typeof page.nextCursor !== "string" ||
            page.nextCursor.length === 0 ||
            page.nextCursor.length > 1000 ||
            cursors.has(page.nextCursor)))
      )
        throw new Error("Invalid search page");
      const validated = page.results
        .map(validateResult)
        .filter((item) => options.allowResult?.(item) ?? true);
      const finished = clock();
      if (
        !repository.completePage(
          {
            id: pageId,
            now: finished,
            nextCursor: page.nextCursor,
            usage: { results: validated.length, truncated: page.truncated },
            results: validated,
          },
          (observations) =>
            observations.map((result) => {
              const canonical = canonicalUrl(result.url);
              return store.ingestDiscovery(
                {
                  nativeId: canonical,
                  url: canonical,
                  sourceUrl: result.url,
                  title: result.title,
                  text: "",
                  publishedAt: result.publishedAt,
                },
                finished,
                provider.name,
              );
            }),
        )
      )
        throw new Error("Discovery page reservation lost");
      results += validated.length;
    } catch {
      repository.failPage(pageId, clock(), "provider_or_page_error");
      status = "failed";
      break;
    }
    if (page.nextCursor === undefined) break;
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (
      index + 1 === limits.maxQueriesPerRun ||
      reserved >= limits.maxResultsPerRun
    ) {
      status = "budget_exhausted";
      break;
    }
  }
  if (limits.maxQueriesPerRun === 0 || limits.maxResultsPerRun === 0)
    status = "budget_exhausted";
  repository.finishRun(
    runId,
    clock(),
    status === "complete"
      ? undefined
      : status === "failed"
        ? "provider_or_page_error"
        : "budget_exhausted",
  );
  return { runId, status, pages, results };
}

function validateResult(result: SearchResult): SearchResult {
  if (
    !result ||
    typeof result.url !== "string" ||
    result.url.length > 8192 ||
    typeof result.title !== "string" ||
    !result.title.trim() ||
    result.title.length > 1000 ||
    (result.snippet !== undefined &&
      (typeof result.snippet !== "string" || result.snippet.length > 10000))
  )
    throw new Error("Invalid search result");
  for (const value of [result.publishedAt, result.observedAt])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("Invalid search timestamp");
  return {
    ...result,
    url: resolvedUrl(result.url),
    title: result.title.trim(),
  };
}
