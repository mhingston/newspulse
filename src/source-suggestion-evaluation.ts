import { createHash } from "node:crypto";
import { z } from "zod";
import { Store } from "./db/store";
import {
  SOURCE_SUGGESTION_ALGORITHM_VERSION,
  generateSourceSuggestions,
  type SuggestionRun,
} from "./source-suggestions";

/**
 * Offline evaluation of source-suggestion quality versus the item-level
 * discovery baseline (issue #33). The corpus is a synthetic regression
 * fixture: it exercises the shipped aggregation pipeline over a throwaway
 * database populated from recorded-provenance shapes, never contacts a
 * provider, and reports unknown values as unknown, never zero.
 */
export const SOURCE_RECOMMENDATION_EVALUATION_VERSION =
  "source-recommendation-evaluation-v1";

const itemSchema = z.strictObject({
  id: z.string().min(1).max(200),
  url: z.string().min(1).max(8192),
  title: z.string().min(1).max(1000),
  publishedAt: z.number().int().safe(),
  ingestedAt: z.number().int().safe().optional(),
  relevance: z.enum(["relevant", "irrelevant", "borderline"]).nullable(),
  development: z.string().min(1).max(200).nullable().optional(),
  unavailable: z.boolean().optional(),
  feedback: z.enum(["useful", "not_useful"]).optional(),
  feedbackAt: z.number().int().safe().optional(),
  feedHtml: z.string().max(20_000).optional(),
  discovered: z.boolean().optional(),
  repeatedResults: z.number().int().min(1).max(50).optional(),
  subscribed: z.boolean().optional(),
});

export const sourceRecommendationCorpusSchema = z
  .strictObject({
    version: z.number().int().positive(),
    id: z.string().min(1),
    asOf: z.number().int().safe(),
    windowDays: z.number().int().min(1).max(365).optional(),
    subscription: z.strictObject({
      url: z.string().min(1).max(8192),
      title: z.string().min(1).max(1000),
    }),
    recordedDiscoveryCostMicros: z.number().int().min(0).safe().default(0),
    domainLabels: z
      .array(
        z.strictObject({
          host: z.string().min(1).max(253),
          label: z.enum(["subscribed", "suggest", "avoid"]),
        }),
      )
      .min(1),
    items: z.array(itemSchema).min(1).max(500),
  })
  .superRefine((corpus, context) => {
    if (
      new Set(corpus.items.map((item) => item.id)).size !== corpus.items.length
    )
      context.addIssue({ code: "custom", message: "Item IDs must be unique" });
  });

export type SourceRecommendationCorpus = z.infer<
  typeof sourceRecommendationCorpusSchema
>;

export interface SourceRecommendationReport {
  generator: string;
  algorithmVersion: string;
  corpus: {
    id: string;
    version: number;
    asOf: number;
    items: number;
    hash: string;
  };
  config: {
    windowDays: number;
    minItems: number;
    minUseful: number;
    proposeThreshold: number;
    suggestionLimit: number;
  };
  baseline: {
    subscribedDomains: string[];
    relevantItems: number;
    distinctDomainsOfRelevantItems: number;
    developmentsCovered: string[];
  };
  metrics: {
    proposedSuggestions: number;
    labeledProposals: number;
    unknownLabelProposals: number;
    suggestionPrecision: {
      numerator: number;
      denominator: number;
      value: number | null;
    };
    falsePositives: { domain: string; label: string }[];
    developmentRecall: {
      baseline: {
        numerator: number;
        denominator: number;
        value: number | null;
      };
      withSuggestions: {
        numerator: number;
        denominator: number;
        value: number | null;
      };
      lift: { numerator: number; denominator: number; value: number | null };
      newlyCovered: string[];
      stillUncovered: string[];
    };
    novelty: {
      newlyCoveredDevelopments: number;
      totalDevelopments: number;
      value: number | null;
    };
    diversity: {
      baselineDistinctDomains: number;
      withSuggestionsDistinctDomains: number;
    };
  };
  cost: {
    /** Deterministic generation reads recorded rows only; no provider calls. */
    suggestionCostMicros: number;
    recordedDiscoveryCostMicros: number;
    realWorldCost: "unknown";
  };
  decisions: {
    gate: string[];
    evidence: string;
  };
  limitations: string[];
  run: SuggestionRun;
}

/** Populate a throwaway database with the corpus's recorded provenance shape. */
export function createSourceSuggestionDatabase(
  corpus: SourceRecommendationCorpus,
): Store {
  const store = new Store(":memory:");
  const db = store.sqlite;
  db.transaction(() => {
    db.query(
      "INSERT INTO sources(id,kind,url,title,enabled,poll_seconds) VALUES('src-subscribed','rss',?, ?,1,1800)",
    ).run(corpus.subscription.url, corpus.subscription.title);

    const insertItem = db.query(
      "INSERT INTO items(id,identity,url,title,published_at,ingested_at,status) VALUES(?,?,?,?,?,?,'ingested')",
    );
    const insertReview = db.query(
      "INSERT INTO item_sources(item_id,source_id,native_id,url) VALUES(?,?,?,?)",
    );
    const insertResult = db.query(
      "INSERT INTO discovery_results(page_id,item_id,url,title,snippet,published_at,observed_at,origin) VALUES(?,?,?,?,?,?,?,'discovered')",
    );
    const insertFeedback = db.query(
      "INSERT INTO item_feedback(id,item_id,useful,source,created_at) VALUES(?,?,?,'eval-fixture',?)",
    );
    const insertUnavailable = db.query(
      "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,attempts,available_at,queued_at,created_at) VALUES(?,?,'extract',1,'done','unavailable',0,?,?,?)",
    );
    const insertContent = db.query(
      "INSERT INTO content(item_id,text) VALUES(?,?)",
    );

    db.query(
      "INSERT INTO discovery_runs(id,query,provider,provider_version,subscription_snapshot,status,started_at,query_kind) VALUES('run-fixture','fixture','none','0','{\"sources\":[],\"highWater\":0}','completed',?, 'manual')",
    ).run(corpus.asOf);
    db.query(
      "INSERT INTO discovery_pages(id,run_id,budget_day,reserved_results,reserved_cost_micros,actual_cost_micros,status,started_at,finished_at) VALUES('page-fixture','run-fixture',?,1,0,0,'completed',?,?)",
    ).run(Math.floor(corpus.asOf / 86_400_000), corpus.asOf, corpus.asOf);

    for (const item of corpus.items) {
      const ingestedAt = item.ingestedAt ?? item.publishedAt;
      const domainKind = item.subscribed ? "subscribed" : `eval:${item.id}`;
      const sourceId = item.subscribed
        ? "src-subscribed"
        : `manual:eval${item.id.replace(/-/g, "").slice(0, 10)}`;
      if (!item.subscribed) {
        db.query(
          "INSERT OR IGNORE INTO sources(id,kind,url,title,enabled) VALUES(?, 'manual', ?, ?, 0)",
        ).run(sourceId, `eval:${item.id}`, `Fixture holder ${item.id}`);
      }
      insertItem.run(
        item.id,
        `url:${item.url}`,
        item.url,
        item.title,
        item.publishedAt,
        ingestedAt,
      );
      insertReview.run(item.id, sourceId, item.id, item.url);
      if (item.discovered !== false) {
        const repeats = item.repeatedResults ?? 1;
        for (let i = 0; i < repeats; i++)
          insertResult.run(
            "page-fixture",
            item.id,
            item.url,
            item.title,
            "",
            item.publishedAt,
            ingestedAt,
          );
      }
      if (item.feedback)
        insertFeedback.run(
          `fb-${item.id}`,
          item.id,
          item.feedback === "useful" ? 1 : 0,
          item.feedbackAt ?? item.publishedAt,
        );
      if (item.unavailable)
        insertUnavailable.run(
          `job-${item.id}`,
          item.id,
          item.publishedAt,
          item.publishedAt,
          item.publishedAt,
        );
      if (item.feedHtml) insertContent.run(item.id, item.feedHtml);
    }
  })();
  return store;
}

function ratio(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
  };
}

function distinctDomainCount(
  corpus: SourceRecommendationCorpus,
  itemIds: Set<string>,
): number {
  const hosts = new Set<string>();
  for (const item of corpus.items)
    if (itemIds.has(item.id)) hosts.add(new URL(item.url).hostname);
  return hosts.size;
}

function corpusHash(corpus: SourceRecommendationCorpus): string {
  return createHash("sha256").update(JSON.stringify(corpus)).digest("hex");
}

export function evaluateSourceRecommendations(
  corpusInput: unknown,
  options: {
    minItems?: number;
    minUseful?: number;
    proposeThreshold?: number;
    suggestionLimit?: number;
  } = {},
): SourceRecommendationReport {
  const corpus = sourceRecommendationCorpusSchema.parse(corpusInput);
  const windowDays = corpus.windowDays ?? 60;
  const store = createSourceSuggestionDatabase(corpus);
  try {
    const run = generateSourceSuggestions(store, {
      now: corpus.asOf,
      windowDays,
      minItems: options.minItems ?? 3,
      minUseful: options.minUseful ?? 1,
      proposeThreshold: options.proposeThreshold ?? 30,
      limit: options.suggestionLimit ?? 10,
    });
    return summarizeRecommendations(corpus, run, windowDays, options);
  } finally {
    store.close();
  }
}

function summarizeRecommendations(
  corpus: SourceRecommendationCorpus,
  run: SuggestionRun,
  windowDays: number,
  options: {
    minItems?: number;
    minUseful?: number;
    proposeThreshold?: number;
    suggestionLimit?: number;
  },
): SourceRecommendationReport {
  const labels = new Map(corpus.domainLabels.map((l) => [l.host, l.label]));
  const domainDuplicates = new Map<string, { label: string; reason: string }>();
  for (const skip of run.skipped) {
    const host = skip.domain;
    const label = labels.get(host);
    if (label) domainDuplicates.set(host, { label, reason: skip.reason });
  }

  const proposedDomains = run.suggestions.map((s) => s.domain);
  const labeledProposals = proposedDomains.filter((d) => labels.has(d));
  const unknownLabelProposals =
    proposedDomains.length - labeledProposals.length;
  const truePositives = labeledProposals.filter(
    (d) => labels.get(d) === "suggest",
  );
  const falsePositives = proposedDomains
    .filter((d) => labels.get(d) !== undefined && labels.get(d) !== "suggest")
    .map((d) => ({
      domain: d,
      label: labels.get(d)!,
      ...(domainDuplicates.get(d) ?? {}),
    }));

  // Development coverage: the baseline is item-level discovery alone (here,
  // the followed subscription). Suggestions are evaluated as accepted sets.
  const allDevelopments = [
    ...new Set(
      corpus.items
        .filter((item) => item.development)
        .map((item) => item.development!),
    ),
  ].sort();
  const baselineRelevant = new Set(
    corpus.items
      .filter((item) => item.subscribed && item.relevance === "relevant")
      .map((item) => item.id),
  );
  const baselineDevelopments = new Set(
    corpus.items
      .filter((item) => baselineRelevant.has(item.id) && item.development)
      .map((item) => item.development!),
  );
  const withSuggestionItems = new Set(baselineRelevant);
  const suggestedRelevantDomains = new Set<string>();
  for (const item of corpus.items) {
    const host = new URL(item.url).hostname;
    const suggested = run.suggestions.some(
      (s) => s.domain === host.replace(/^www\./, ""),
    );
    if (suggested) {
      suggestedRelevantDomains.add(host.replace(/^www\./, ""));
      if (item.relevance === "relevant") withSuggestionItems.add(item.id);
    }
  }
  const withSuggestionsDevelopments = new Set([
    ...baselineDevelopments,
    ...corpus.items
      .filter((item) => withSuggestionItems.has(item.id) && item.development)
      .map((item) => item.development!),
  ]);
  const newlyCovered = allDevelopments.filter(
    (development) =>
      withSuggestionsDevelopments.has(development) &&
      !baselineDevelopments.has(development),
  );
  const stillUncovered = allDevelopments.filter(
    (development) => !withSuggestionsDevelopments.has(development),
  );

  const baselineRecall = baselineDevelopments.size / allDevelopments.length;
  const withRecall = withSuggestionsDevelopments.size / allDevelopments.length;
  const lift = withRecall - baselineRecall;

  const falsePositiveCount = falsePositives.length;
  const gate: string[] = [];
  gate.push(`suggestionLift>0:${(lift > 0).toString()}`);
  gate.push(
    `falsePositives<proposedSuggestions:${(falsePositiveCount < run.suggestions.length).toString()}`,
  );
  const adopted = lift > 0 && falsePositiveCount < run.suggestions.length;

  const report: SourceRecommendationReport = {
    generator: SOURCE_RECOMMENDATION_EVALUATION_VERSION,
    algorithmVersion: SOURCE_SUGGESTION_ALGORITHM_VERSION,
    corpus: {
      id: corpus.id,
      version: corpus.version,
      asOf: corpus.asOf,
      items: corpus.items.length,
      hash: corpusHash(corpus),
    },
    config: {
      windowDays,
      minItems: options.minItems ?? 3,
      minUseful: options.minUseful ?? 1,
      proposeThreshold: options.proposeThreshold ?? 30,
      suggestionLimit: options.suggestionLimit ?? 10,
    },
    baseline: {
      subscribedDomains: [new URL(corpus.subscription.url).hostname],
      relevantItems: baselineRelevant.size,
      distinctDomainsOfRelevantItems: distinctDomainCount(
        corpus,
        baselineRelevant,
      ),
      developmentsCovered: [...baselineDevelopments].sort(),
    },
    metrics: {
      proposedSuggestions: run.suggestions.length,
      labeledProposals: labeledProposals.length,
      unknownLabelProposals,
      suggestionPrecision: {
        numerator: truePositives.length,
        denominator: labeledProposals.length,
        value: labeledProposals.length
          ? truePositives.length / labeledProposals.length
          : null,
      },
      falsePositives,
      developmentRecall: {
        baseline: ratio(baselineDevelopments.size, allDevelopments.length),
        withSuggestions: ratio(
          withSuggestionsDevelopments.size,
          allDevelopments.length,
        ),
        lift: {
          numerator:
            withSuggestionsDevelopments.size - baselineDevelopments.size,
          denominator: allDevelopments.length,
          value: lift,
        },
        newlyCovered,
        stillUncovered,
      },
      novelty: {
        newlyCoveredDevelopments: newlyCovered.length,
        totalDevelopments: allDevelopments.length,
        value: allDevelopments.length
          ? newlyCovered.length / allDevelopments.length
          : null,
      },
      diversity: {
        baselineDistinctDomains: distinctDomainCount(corpus, baselineRelevant),
        withSuggestionsDistinctDomains: distinctDomainCount(
          corpus,
          withSuggestionItems,
        ),
      },
    },
    cost: {
      suggestionCostMicros: 0,
      recordedDiscoveryCostMicros: corpus.recordedDiscoveryCostMicros,
      realWorldCost: "unknown",
    },
    decisions: {
      gate,
      evidence: adopted
        ? `Measured lift ${withRecall.toFixed(3)} - ${baselineRecall.toFixed(3)} is positive on the labeled fixture, with ${falsePositiveCount} recorded false-positive proposal(s) listed for review; supports adopting the opt-in suggestion slice with explicit accept/dismiss/mute.`
        : "Measured evidence does not support adoption; a justified non-adoption must be recorded.",
    },
    limitations: [
      "The corpus is synthetic and small; metrics are regression evidence, not a real-world quality estimate.",
      "Only explicitly labeled domains and items are measured; unknown labels are reported, never treated as negative.",
      "Suggestion generation spends no budget: it reads rows already recorded by existing discovery runs.",
      "Real-world suggestion usefulness against the live baseline is unknown.",
    ],
    run,
  };
  return report;
}
