import { createHash } from "node:crypto";
import { z } from "zod";
import { Store } from "./db/store";
import {
  SOURCE_SUGGESTION_ALGORITHM_VERSION,
  refreshSourceSuggestions,
  type SuggestionRun,
} from "./source-suggestions";

/**
 * Offline evaluation of source-suggestion usefulness versus the item-level
 * discovery baseline (issue #33). The corpus is a synthetic regression
 * fixture: recorded provenance (subscriptions plus prior discoveries) forms
 * the baseline arm; labeled held-out subsequent items from candidate
 * publishers measure incremental coverage. The shipped aggregation pipeline
 * runs unchanged over a throwaway database — no provider calls — and
 * unknown values are reported as unknown, never zero.
 */
export const SOURCE_RECOMMENDATION_EVALUATION_VERSION =
  "source-recommendation-evaluation-v2";

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
  /** Feed links recorded by extraction job results (captured at fetch time). */
  extractionFeedLinks: z.array(z.string().min(1).max(8192)).max(20).optional(),
  discovered: z.boolean().optional(),
  repeatedResults: z.number().int().min(1).max(50).optional(),
  subscribed: z.boolean().optional(),
  /**
   * A held-out subsequent item: only reachable through the suggested source,
   * not part of recorded provenance, so never in the baseline arm.
   */
  heldout: z.boolean().optional(),
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

/** Populate a throwaway database with the corpus's recorded provenance shape. */
export function createSourceSuggestionDatabase(
  corpus: SourceRecommendationCorpus,
  /** Optional on-disk path; defaults to a throwaway in-memory database. */
  path: string = ":memory:",
): Store {
  const store = new Store(path);
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
    const insertExtracted = db.query(
      "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,attempts,available_at,queued_at,created_at,result) VALUES(?,?,'extract',1,'done','extracted',0,?,?,?,?)",
    );

    db.query(
      "INSERT INTO discovery_runs(id,query,provider,provider_version,subscription_snapshot,status,started_at,query_kind) VALUES('run-fixture','fixture','none','0','{\"sources\":[],\"highWater\":0}','completed',?, 'manual')",
    ).run(corpus.asOf);
    db.query(
      "INSERT INTO discovery_pages(id,run_id,budget_day,reserved_results,reserved_cost_micros,actual_cost_micros,status,started_at,finished_at) VALUES('page-fixture','run-fixture',?,1,0,0,'completed',?,?)",
    ).run(Math.floor(corpus.asOf / 86_400_000), corpus.asOf, corpus.asOf);

    for (const item of corpus.items) {
      const ingestedAt = item.ingestedAt ?? item.publishedAt;
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
      if (item.extractionFeedLinks)
        insertExtracted.run(
          `job-${item.id}`,
          item.id,
          item.publishedAt,
          item.publishedAt,
          item.publishedAt,
          JSON.stringify({
            status: "extracted",
            text: "",
            method: "http",
            feedLinks: item.extractionFeedLinks,
          }),
        );
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

export interface SourceRecommendationReport {
  generator: string;
  algorithmVersion: string;
  corpus: {
    id: string;
    version: number;
    asOf: number;
    items: number;
    heldoutItems: number;
    hash: string;
  };
  config: {
    windowDays: number;
    minItems: number;
    minUseful: number;
    proposeThreshold: number;
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
    falsePositives: { domain: string; label: string; reason?: string }[];
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

export function evaluateSourceRecommendations(
  corpusInput: unknown,
  options: {
    minItems?: number;
    minUseful?: number;
    proposeThreshold?: number;
  } = {},
): SourceRecommendationReport {
  const corpus = sourceRecommendationCorpusSchema.parse(corpusInput);
  const windowDays = corpus.windowDays ?? 60;
  const store = createSourceSuggestionDatabase(corpus);
  try {
    // The replay runs the shipped refresh path (persistence, suppression and
    // eligibility reconciliation included) against the throwaway database.
    const run = refreshSourceSuggestions(store, {
      now: corpus.asOf,
      windowDays,
      minItems: options.minItems ?? 3,
      minUseful: options.minUseful ?? 1,
      proposeThreshold: options.proposeThreshold ?? 30,
      limit: corpus.items.length,
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
  },
): SourceRecommendationReport {
  const labels = new Map(corpus.domainLabels.map((l) => [l.host, l.label]));
  const currentProposals = run.suggestions.map((s) => s.domain);
  const proposedDomains = new Set(
    [
      ...currentProposals,
      ...run.suppressed.map((s) => s.suggestion.domain),
    ].map((domain) => domain),
  );
  const domainDuplicates = new Map<string, { reason: string }>();
  for (const skip of run.skipped) {
    if (labels.has(skip.domain))
      domainDuplicates.set(skip.domain, { reason: skip.reason });
  }

  const labeledProposals = currentProposals.filter((d) => labels.has(d));
  const unknownLabelProposals =
    currentProposals.length - labeledProposals.length;
  const truePositives = labeledProposals.filter(
    (d) => labels.get(d) === "suggest",
  );
  const falsePositives = currentProposals
    .filter((d) => labels.has(d) && labels.get(d) !== "suggest")
    .map((d) => ({
      domain: d,
      label: labels.get(d)!,
      ...(domainDuplicates.get(d) ?? {}),
    }));

  // The baseline arm is item-level discovery alone: every labeled relevant
  // development already available through subscriptions or recorded
  // discoveries. Suggestions are measured on the incremental development
  // coverage they add through labeled held-out subsequent items.
  const recorded = corpus.items.filter((item) => !item.heldout);
  const heldout = corpus.items.filter((item) => item.heldout);
  const allDevelopments = [
    ...new Set(
      corpus.items
        .filter((i) => i.development)
        .map((item) => item.development!),
    ),
  ].sort();
  const baselineRelevant = new Set(
    recorded
      .filter((item) => item.relevance === "relevant")
      .map((item) => item.id),
  );
  const baselineDevelopments = new Set(
    recorded
      .filter((item) => item.relevance === "relevant" && item.development)
      .map((item) => item.development!),
  );

  const newCoveredItems = new Set<string>();
  const newCoveredDomains = new Set<string>();
  for (const item of heldout) {
    const host = new URL(item.url).hostname.replace(/^www\./, "");
    if (!proposedDomains.has(host)) continue;
    newCoveredDomains.add(host);
    if (item.relevance === "relevant") newCoveredItems.add(item.id);
  }
  const newDevelopments = new Set(
    corpus.items
      .filter((item) => newCoveredItems.has(item.id) && item.development)
      .map((item) => item.development!),
  );
  const withSuggestionsDevelopments = new Set([
    ...baselineDevelopments,
    ...newDevelopments,
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
    `falsePositives<proposedSuggestions:${(falsePositiveCount < currentProposals.length).toString()}`,
  );
  const adopted = lift > 0 && falsePositiveCount < currentProposals.length;

  const withSuggestionItems = new Set([
    ...baselineRelevant,
    ...newCoveredItems,
  ]);
  const report: SourceRecommendationReport = {
    generator: SOURCE_RECOMMENDATION_EVALUATION_VERSION,
    algorithmVersion: SOURCE_SUGGESTION_ALGORITHM_VERSION,
    corpus: {
      id: corpus.id,
      version: corpus.version,
      asOf: corpus.asOf,
      items: corpus.items.length,
      heldoutItems: heldout.length,
      hash: corpusHash(corpus),
    },
    config: {
      windowDays,
      minItems: options.minItems ?? 3,
      minUseful: options.minUseful ?? 1,
      proposeThreshold: options.proposeThreshold ?? 30,
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
      proposedSuggestions: currentProposals.length,
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
        ? `Measured held-out incremental development recall ${baselineRecall.toFixed(3)} -> ${withRecall.toFixed(3)} (lift +${lift.toFixed(3)}) on the labeled fixture, with ${falsePositiveCount} recorded false-positive proposal(s) listed for review; supports adopting the opt-in suggestion slice with explicit accept/dismiss/mute.`
        : "Measured evidence does not support adoption; a justified non-adoption must be recorded.",
    },
    limitations: [
      "The corpus is synthetic and small; metrics are regression evidence, not a real-world quality estimate.",
      "The baseline arm includes all labeled developments already reachable via subscriptions and recorded discoveries; only genuinely incremental held-out coverage counts toward the lift.",
      "Only explicitly labeled domains and items are measured; unknown labels are reported, never treated as negative.",
      "Suggestion generation spends no budget: it reads rows already recorded by existing discovery runs and extraction fetches.",
      "Real-world suggestion usefulness against the live baseline is unknown.",
    ],
    run,
  };
  return report;
}
