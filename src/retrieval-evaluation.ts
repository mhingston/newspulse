import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SEARCH_MATCH_VERSION,
  QUERY_SYNONYMS,
  SYNONYM_VERSION,
  searchTerms,
} from "./search-matching";

/**
 * Retrieval-gap evaluation (issue #29): replay recorded realistic queries
 * against an offline FTS5 index of the labeled retrieval corpus and compare
 * low-complexity query-side candidates. This module owns labels, strategies
 * and metrics only; the FTS5 executor is injected so no runtime database API
 * leaks into domain logic.
 */

const sourceKinds = [
  "rss",
  "github",
  "hackernews",
  "inbound",
  "manual",
  "discovery",
] as const;

const retrievalItemSchema = z.strictObject({
  id: z.string().min(1).max(200),
  title: z.string().max(1000),
  text: z.string().max(100000),
  sourceKind: z.enum(sourceKinds),
  publishedAt: z.number().int().safe().nullable(),
  unavailable: z.boolean(),
});

export const retrievalCorpusSchema = z
  .strictObject({
    version: z.number().int().positive().safe(),
    id: z.string().min(1),
    asOf: z.number().int().safe(),
    items: z.array(retrievalItemSchema).min(1).max(500),
  })
  .superRefine((corpus, context) => {
    if (
      new Set(corpus.items.map((item) => item.id)).size !== corpus.items.length
    )
      context.addIssue({ code: "custom", message: "Item IDs must be unique" });
  });
export type RetrievalCorpus = z.infer<typeof retrievalCorpusSchema>;

export const retrievalFiltersSchema = z
  .strictObject({
    from: z.number().int().safe().optional(),
    to: z.number().int().safe().optional(),
    sourceKind: z.enum(sourceKinds).optional(),
  })
  .refine(
    (filters) =>
      filters.from === undefined ||
      filters.to === undefined ||
      filters.from <= filters.to,
    { message: "from must not exceed to" },
  );
export type RetrievalQueryFilters = z.infer<typeof retrievalFiltersSchema>;

export const scenarioNames = [
  "control",
  "vocabulary-mismatch",
  "paper-connection",
  "historical-development",
  "unavailable-content",
  "metadata-filter",
] as const;

export const retrievalQueriesSchema = z
  .strictObject({
    version: z.number().int().positive().safe(),
    corpusId: z.string().min(1),
    k: z.number().int().min(1).max(100).safe(),
    queries: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(200),
          scenario: z.enum(scenarioNames),
          query: z.string().min(1).max(1000),
          relevantIds: z.array(z.string().min(1)).min(1),
          filters: retrievalFiltersSchema.optional(),
          notes: z.string().max(2000).optional(),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((queries, context) => {
    if (
      new Set(queries.queries.map((query) => query.id)).size !==
      queries.queries.length
    )
      context.addIssue({ code: "custom", message: "Query IDs must be unique" });
    if (
      new Set(queries.queries.map((query) => query.query)).size !==
      queries.queries.length
    )
      context.addIssue({ code: "custom", message: "Queries must be unique" });
  });
export type RetrievalQueries = z.infer<typeof retrievalQueriesSchema>;

/** Mirrors the production tokenizer in src/db/store.ts search(). */
export function termsFor(query: string): string[] {
  return searchTerms(query);
}

const quote = (term: string) => '"' + term + '"';
const prefixQuote = (term: string) =>
  term.length >= 3 ? quote(term) + "*" : quote(term);

/** FTS5 default tokenization is case-insensitive; expansion must be too. */
const synonymsFor = (term: string): string[] =>
  QUERY_SYNONYMS[term.toLowerCase()] ?? [];

/** AND across query terms, OR within each term's synonym group. */
function andGroups(terms: string[], render: (term: string) => string): string {
  return terms
    .map((term) => {
      const group = [term, ...synonymsFor(term)].map(render);
      return group.length > 1 ? "(" + group.join(" OR ") + ")" : group[0]!;
    })
    .join(" AND ");
}

function orFlat(terms: string[], render: (term: string) => string): string {
  return terms
    .flatMap((term) => [term, ...synonymsFor(term)].map(render))
    .join(" OR ");
}

export type FilterModes = ReadonlyArray<"none" | "recorded">;

export const MATCH_STRATEGIES: Record<
  string,
  { build(terms: string[]): string }
> = {
  /** Historical baseline behavior: quoted terms joined by AND. */
  "and-quoted": {
    build: (terms) => terms.slice(0, 30).map(quote).join(" AND "),
  },
  "or-quoted": {
    build: (terms) => orFlat(terms, quote),
  },
  "and-prefix": {
    build: (terms) => terms.map(prefixQuote).join(" AND "),
  },
  "or-prefix": {
    build: (terms) => orFlat(terms, prefixQuote),
  },
  "and-group-synonyms": {
    build: (terms) => andGroups(terms, quote),
  },
  "and-prefix-group-synonyms": {
    build: (terms) => andGroups(terms, prefixQuote),
  },
};

export interface RetrievalFilters {
  from?: number;
  to?: number;
  sourceKind?: string;
}

/** Executes one FTS5 match and returns item ids in bm25 order, top k. */
export type RetrievalSolver = (
  match: string,
  filters: RetrievalFilters | undefined,
  k: number,
) => string[];

export interface QueryMetrics {
  queryId: string;
  scenario: string;
  retrievedCount: number;
  relevantRetrieved: number;
  relevantTotal: number;
  recallAtK: {
    numerator: number;
    denominator: number;
    value: number;
    unknown: number;
  };
  precisionAtK: {
    numerator: number;
    denominator: number;
    value: number | null;
    unknown: number;
  };
}

export interface CandidateReport {
  strategyId: string;
  filters: "none" | "recorded";
  perQuery: QueryMetrics[];
  recallAtK: {
    numerator: number;
    denominator: number;
    value: number;
    unknown: number;
  };
  precisionAtK: {
    numerator: number;
    denominator: number;
    value: number | null;
    unknown: number;
  };
  zeroResultQueryIds: string[];
  fullRecallQueryIds: string[];
}

export interface RetrievalIndexFootprint {
  itemsOnlyBytes: number;
  ftsBytes: number;
  ftsOverheadBytes: number;
}

export interface RetrievalGapReport {
  corpus: {
    id: string;
    version: number;
    asOf: number;
    items: number;
    hash: string;
  };
  queries: {
    id: string;
    version: number;
    k: number;
    count: number;
    hash: string;
  };
  config: {
    matchFlavor: "fts5";
    tokenizer: "unicode61-default";
    strategyIds: string[];
    synonymVersion: string;
    synonymTableBytes: number;
  };
  index: RetrievalIndexFootprint | null;
  candidates: CandidateReport[];
  unavailableContentGaps: { queryIds: string[]; explanation: string };
  usage: { providerCalls: 0; cost: null };
  latencyMs: null;
  latencyReason: string;
}

function measureCandidate(
  queries: RetrievalQueries,
  corpus: RetrievalCorpus,
  strategyId: string,
  filtersMode: "none" | "recorded",
  solver: RetrievalSolver,
): CandidateReport {
  const builder = MATCH_STRATEGIES[strategyId]!;
  const perQuery: QueryMetrics[] = [];
  const zeroResult: string[] = [];
  const fullRecall: string[] = [];
  let relevantRetrieved = 0;
  let relevantTotal = 0;
  let precisionNumerator = 0;
  let precisionDenominator = 0;
  for (const query of queries.queries) {
    const filters =
      filtersMode === "recorded" ? (query.filters ?? undefined) : undefined;
    const terms = termsFor(query.query).slice(0, 30);
    const retrieved = terms.length
      ? solver(builder.build(terms), filters, queries.k)
      : [];
    const relevant = new Set(query.relevantIds);
    const hit = retrieved.filter((id) => relevant.has(id)).length;
    const recall = query.relevantIds.length
      ? hit / query.relevantIds.length
      : 0;
    perQuery.push({
      queryId: query.id,
      scenario: query.scenario,
      retrievedCount: retrieved.length,
      relevantRetrieved: hit,
      relevantTotal: query.relevantIds.length,
      recallAtK: {
        numerator: hit,
        denominator: query.relevantIds.length,
        value: recall,
        unknown: 0,
      },
      precisionAtK: {
        numerator: hit,
        denominator: retrieved.length,
        value: retrieved.length ? hit / retrieved.length : null,
        unknown: retrieved.length === 0 ? 1 : 0,
      },
    });
    relevantRetrieved += hit;
    relevantTotal += query.relevantIds.length;
    if (retrieved.length) {
      precisionNumerator += hit;
      precisionDenominator += retrieved.length;
    }
    if (retrieved.length === 0) zeroResult.push(query.id);
    if (hit === query.relevantIds.length && hit > 0) fullRecall.push(query.id);
  }
  return {
    strategyId,
    filters: filtersMode,
    perQuery,
    recallAtK: {
      numerator: relevantRetrieved,
      denominator: relevantTotal,
      value: relevantTotal ? relevantRetrieved / relevantTotal : 0,
      unknown: 0,
    },
    precisionAtK: {
      numerator: precisionNumerator,
      denominator: precisionDenominator,
      value: precisionDenominator
        ? precisionNumerator / precisionDenominator
        : null,
      unknown: perQuery.filter((row) => row.precisionAtK.unknown > 0).length,
    },
    zeroResultQueryIds: zeroResult,
    fullRecallQueryIds: fullRecall,
  };
}

export function evaluateRetrievalGaps(
  corpus: RetrievalCorpus,
  queries: RetrievalQueries,
  solve: (strategyId: string) => RetrievalSolver,
  index: RetrievalIndexFootprint | null,
  options: { candidateFilterModes?: FilterModes } = {},
): RetrievalGapReport {
  if (queries.corpusId !== corpus.id)
    throw new Error(
      `Queries target corpus ${queries.corpusId}, not ${corpus.id}`,
    );
  const byId = new Map(corpus.items.map((item) => [item.id, item]));
  for (const query of queries.queries) {
    for (const id of query.relevantIds) {
      const item = byId.get(id);
      if (!item)
        throw new Error(
          `Query ${query.id} references unknown relevant id ${id}`,
        );
      if (query.scenario === "unavailable-content" && !item.unavailable)
        throw new Error(
          `Unavailable-content query ${query.id} must reference an unavailable item`,
        );
    }
  }
  const filterModes = options.candidateFilterModes ?? ["none", "recorded"];
  const strategyIds = Object.keys(MATCH_STRATEGIES);
  const hasRecordedFilters = queries.queries.some(
    (query) => query.filters !== undefined,
  );
  const candidates = strategyIds
    .flatMap((strategyId) =>
      filterModes.map((mode) =>
        measureCandidate(queries, corpus, strategyId, mode, solve(strategyId)),
      ),
    )
    .filter((report) => report.filters === "none" || hasRecordedFilters);
  return {
    corpus: {
      id: corpus.id,
      version: corpus.version,
      asOf: corpus.asOf,
      items: corpus.items.length,
      hash: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
    },
    queries: {
      id: queries.corpusId,
      version: queries.version,
      k: queries.k,
      count: queries.queries.length,
      hash: createHash("sha256").update(JSON.stringify(queries)).digest("hex"),
    },
    config: {
      matchFlavor: "fts5",
      tokenizer: "unicode61-default",
      strategyIds,
      synonymVersion: SYNONYM_VERSION,
      synonymTableBytes: new TextEncoder().encode(
        JSON.stringify(QUERY_SYNONYMS),
      ).length,
    },
    index,
    candidates,
    unavailableContentGaps: {
      queryIds: queries.queries
        .filter((query) => query.scenario === "unavailable-content")
        .map((query) => query.id),
      explanation:
        "Unavailable content has no indexed text; keyword strategies cannot retrieve it and the gap is recorded rather than hidden.",
    },
    usage: { providerCalls: 0, cost: null },
    latencyMs: null,
    latencyReason:
      "No timing observation recorded; elapsed time is environment-dependent and excluded from deterministic replay.",
  };
}
