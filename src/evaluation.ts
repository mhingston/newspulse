import { createHash } from "node:crypto";
import { z } from "zod";
import { interestSchema } from "./profiles";
import { compareScores, scoreItem, SCORING_CRITERIA_VERSION } from "./scoring";
import { planStories, STORY_RULE_VERSION } from "./story-grouping";

const itemSchema = z.strictObject({
  id: z.string().min(1).max(200),
  title: z.string().max(1000),
  text: z.string().max(100000),
  publishedAt: z.number().int().safe().nullable(),
  relevance: z.enum(["relevant", "irrelevant", "borderline"]).nullable(),
  development: z.string().min(1).nullable(),
  important: z.boolean().nullable(),
  outsideSubscription: z.boolean().nullable(),
  analysis: z
    .strictObject({
      classification: z.string().optional(),
      provider: z.string().min(1),
      model: z.string().min(1),
      promptVersion: z.string().min(1),
      claims: z.array(
        z.strictObject({ statement: z.string(), citation: z.string() }),
      ),
      uncertainty: z.array(z.string()),
    })
    .nullable(),
});
export const corpusSchema = z
  .strictObject({
    version: z.number().int().positive().safe(),
    id: z.string().min(1),
    asOf: z.number().int().safe(),
    profiles: z.array(interestSchema).max(100),
    items: z.array(itemSchema).min(1).max(500),
  })
  .superRefine((corpus, context) => {
    if (
      new Set(corpus.items.map((item) => item.id)).size !== corpus.items.length
    )
      context.addIssue({ code: "custom", message: "Item IDs must be unique" });
  });
export type EvaluationCorpus = z.infer<typeof corpusSchema>;
export interface RankedItem {
  id: string;
  groupId: string;
  eligible?: boolean;
}
function ratio(numerator: number, denominator: number, unknown = 0) {
  return {
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
    unknown,
  };
}

/** Measure only explicit labels; borderline and absent judgments remain unknown. */
export function measureRanking(
  corpus: EvaluationCorpus,
  ranking: RankedItem[],
  k: number,
) {
  if (!Number.isSafeInteger(k) || k < 1 || k > 10000)
    throw new Error("k must be an integer from 1 to 10000");
  const byId = new Map(corpus.items.map((item) => [item.id, item]));
  if (
    new Set(ranking.map((row) => row.id)).size !== ranking.length ||
    ranking.some((row) => !byId.has(row.id))
  )
    throw new Error("Invalid ranking IDs");
  const selected = ranking.filter((row) => row.eligible !== false).slice(0, k);
  const labels = selected.map((row) => byId.get(row.id)!);
  const judged = labels.filter(
    (item) => item.relevance === "relevant" || item.relevance === "irrelevant",
  );
  const outside = labels.filter((item) => item.outsideSubscription === true);
  const outsideJudged = outside.filter(
    (item) => item.relevance === "relevant" || item.relevance === "irrelevant",
  );
  const unknownOutside = labels.filter(
    (item) => item.outsideSubscription === null,
  ).length;
  const labeledDevelopments = labels.filter(
    (item) => item.development !== null,
  );
  const uniqueDevelopments = new Set(
    labeledDevelopments.map((item) => item.development),
  );
  const important = new Set(
    corpus.items
      .filter((item) => item.important === true && item.development !== null)
      .map((item) => item.development!),
  );
  const found = new Set(
    labels
      .filter((item) => item.development !== null)
      .map((item) => item.development!),
  );
  let predictedPairs = 0,
    truePairs = 0,
    actualPairs = 0,
    unknownPairs = 0,
    unknownActualPairs = 0;
  for (let i = 0; i < ranking.length; i++)
    for (let j = i + 1; j < ranking.length; j++) {
      const a = byId.get(ranking[i]!.id)!,
        b = byId.get(ranking[j]!.id)!;
      const predicted = ranking[i]!.groupId === ranking[j]!.groupId;
      if (a.development === null || b.development === null) {
        unknownActualPairs++;
        if (predicted) unknownPairs++;
        continue;
      }
      const actual = a.development === b.development;
      if (predicted) predictedPairs++;
      if (actual) actualPairs++;
      if (predicted && actual) truePairs++;
    }
  return {
    precisionAtK: ratio(
      judged.filter((item) => item.relevance === "relevant").length,
      judged.length,
      labels.length - judged.length,
    ),
    duplicateRate: ratio(
      labeledDevelopments.length - uniqueDevelopments.size,
      labeledDevelopments.length,
      labels.length - labeledDevelopments.length,
    ),
    usefulDiscoveries: ratio(
      new Set(
        labels
          .filter(
            (item) =>
              item.relevance === "relevant" && item.development !== null,
          )
          .map((item) => item.development),
      ).size,
      labels.filter(
        (item) =>
          item.relevance === "irrelevant" ||
          (item.relevance === "relevant" && item.development !== null),
      ).length,
      labels.filter(
        (item) =>
          item.relevance === null ||
          item.relevance === "borderline" ||
          (item.relevance === "relevant" && item.development === null),
      ).length,
    ),
    outsideSubscriptionRelevance: ratio(
      outsideJudged.filter((item) => item.relevance === "relevant").length,
      outsideJudged.length,
      outside.length - outsideJudged.length + unknownOutside,
    ),
    importantRecall: ratio(
      [...important].filter((id) => found.has(id)).length,
      important.size,
      corpus.items.filter(
        (item) =>
          item.important === null ||
          (item.important && item.development === null),
      ).length,
    ),
    groupPairPrecision: ratio(truePairs, predictedPairs, unknownPairs),
    groupPairRecall: ratio(truePairs, actualPairs, unknownActualPairs),
    missedImportantDevelopments: [...important]
      .filter((id) => !found.has(id))
      .sort(),
  };
}

export function evaluateCorpus(input: unknown, options: { k: number }) {
  const corpus = corpusSchema.parse(input);
  const plan = planStories(
    corpus.items.map((item) => ({
      id: item.id,
      identity: item.id,
      url: null,
      title: item.title,
      text: item.text,
      publishedAt: item.publishedAt,
      ingestedAt: corpus.asOf,
    })),
  );
  const groups = new Map(
    plan.groups.flatMap((group) =>
      group.members.map((member) => [member.itemId, group.id] as const),
    ),
  );
  const scored = corpus.items
    .map((item) => ({
      itemId: item.id,
      score: scoreItem({
        itemId: item.id,
        title: item.title,
        text: item.text,
        publishedAt: item.publishedAt,
        now: corpus.asOf,
        interests: corpus.profiles.filter(
          (p) => p.lifetime === "persistent" || p.expiresAt! > corpus.asOf,
        ),
        analysis: item.analysis,
        history: null,
      }),
    }))
    .sort(compareScores);
  const allRanking = scored.map((row) => ({
    id: row.itemId,
    score: row.score,
    groupId: groups.get(row.itemId)!,
    eligible: row.score.eligible,
  }));
  const measured = measureRanking(corpus, allRanking, options.k);
  const ranking = allRanking.filter((row) => row.eligible);
  const excluded = allRanking.filter((row) => !row.eligible);
  const { missedImportantDevelopments, ...metrics } = measured;
  return {
    corpus: {
      id: corpus.id,
      version: corpus.version,
      hash: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
    },
    config: {
      k: options.k,
      asOf: corpus.asOf,
      criteriaVersion: SCORING_CRITERIA_VERSION,
      groupingVersion: STORY_RULE_VERSION,
      profiles: corpus.profiles.map(({ id, version }) => ({ id, version })),
      models: [
        ...new Set(
          corpus.items.flatMap((item) =>
            item.analysis
              ? [
                  JSON.stringify({
                    provider: item.analysis.provider,
                    model: item.analysis.model,
                    promptVersion: item.analysis.promptVersion,
                  }),
                ]
              : [],
          ),
        ),
      ]
        .sort()
        .map(
          (value) =>
            JSON.parse(value) as {
              provider: string;
              model: string;
              promptVersion: string;
            },
        ),
    },
    ranking,
    excluded,
    metrics,
    missedImportantDevelopments,
    usage: {
      providerCalls: 0,
      cost: null,
      costPerUsefulDiscovery: {
        value: null,
        usefulDiscoveries: metrics.usefulDiscoveries.numerator,
        unknownLabels: metrics.usefulDiscoveries.unknown,
      },
    },
    latencyMs: null,
    latencyReason:
      "No timing observation recorded; elapsed time is environment-dependent and excluded from deterministic replay.",
  };
}

export type EvaluationReport = ReturnType<typeof evaluateCorpus>;
export type Gate = {
  metric: keyof EvaluationReport["metrics"];
  min?: number;
  max?: number;
};
export function compareEvaluations(
  baseline: EvaluationReport,
  current: EvaluationReport,
  gates: Gate[] = [],
) {
  if (
    baseline.corpus.hash !== current.corpus.hash ||
    baseline.config.k !== current.config.k ||
    baseline.config.asOf !== current.config.asOf ||
    JSON.stringify(baseline.config.profiles) !==
      JSON.stringify(current.config.profiles)
  )
    throw new Error(
      "Comparison requires the same corpus, k, time and profiles",
    );
  const names = Object.keys(
    baseline.metrics,
  ) as (keyof EvaluationReport["metrics"])[];
  const metrics = Object.fromEntries(
    names.map((name) => {
      const before = baseline.metrics[name],
        after = current.metrics[name];
      return [
        name,
        {
          baseline: before,
          current: after,
          delta:
            before.value === null || after.value === null
              ? null
              : after.value - before.value,
        },
      ];
    }),
  );
  const checks = gates.map((gate) => {
    if (
      !names.includes(gate.metric) ||
      (gate.min === undefined && gate.max === undefined) ||
      (gate.min !== undefined &&
        (!Number.isFinite(gate.min) || gate.min < 0 || gate.min > 1)) ||
      (gate.max !== undefined &&
        (!Number.isFinite(gate.max) || gate.max < 0 || gate.max > 1)) ||
      (gate.min !== undefined && gate.max !== undefined && gate.min > gate.max)
    )
      throw new Error("Invalid evaluation gate");
    const value = current.metrics[gate.metric].value;
    return {
      ...gate,
      value,
      unknown: current.metrics[gate.metric].unknown,
      passed:
        value !== null &&
        current.metrics[gate.metric].unknown === 0 &&
        (gate.min === undefined || value >= gate.min) &&
        (gate.max === undefined || value <= gate.max),
    };
  });
  const positions = (report: EvaluationReport) =>
    new Map<
      string,
      { rank: number | null; groupId: string; eligible: boolean }
    >([
      ...report.ranking.map(
        (row, index) =>
          [
            row.id,
            { rank: index + 1, groupId: row.groupId, eligible: true },
          ] as const,
      ),
      ...report.excluded.map(
        (row) =>
          [
            row.id,
            { rank: null, groupId: row.groupId, eligible: false },
          ] as const,
      ),
    ]);
  const before = positions(baseline),
    after = positions(current);
  const itemChanges = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((id) => {
      const previous = before.get(id) ?? null,
        next = after.get(id) ?? null;
      return JSON.stringify(previous) === JSON.stringify(next)
        ? []
        : [{ id, baseline: previous, current: next }];
    });
  return {
    baselineConfig: baseline.config,
    currentConfig: current.config,
    metrics,
    itemChanges,
    checks,
    passed: checks.length ? checks.every((check) => check.passed) : null,
  };
}
