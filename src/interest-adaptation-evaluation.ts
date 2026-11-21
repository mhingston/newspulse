import { createHash } from "node:crypto";
import { z } from "zod";
import {
  corpusSchema,
  measureRanking,
  type EvaluationCorpus,
} from "./evaluation";
import { planStories, STORY_RULE_VERSION } from "./story-grouping";
import {
  compareScores,
  scoreItem,
  SCORING_CRITERIA_VERSION,
  type ScoreResult,
} from "./scoring";

/**
 * Interest-adaptation evaluation (issue #25): compares the recorded
 * explicit-feedback baseline (`deterministic-v5`, one flat bounded adjustment
 * from the latest explicit judgment per item) against bounded, explainable,
 * richer adaptation strategies — recency-weighted feedback, an expiring
 * feedback-driven temporary boost, and adjacent-term widening derived from
 * explicitly useful items — offline, over the same labeled corpus, replay
 * instant and top-k budget as the recorded #8 baseline.
 *
 * Every arm runs the production `scoreItem` unchanged and records what it
 * changed. Adaptation acts only as a bounded post-score relevance adjustment
 * (bounded by the flat baseline step) or as interest terms added on top of
 * the explicit terms, so it can widen what an interest matches but can never
 * erase, override or make ineligible an item an explicit interest already
 * matches. Feedback recorded after the replay instant never leaks into the
 * comparison, a missing judgment is represented by the absence of events
 * (never an inferred negative), and no arm learns from unread or missing
 * clicks: both are simply no recorded event.
 */

export const ADAPTATION_EVALUATION_VERSION =
  "interest-adaptation-evaluation-v1";

/** One day in milliseconds; limits are configured in days. */
const DAY_MS = 86_400_000;

/** The flat bounded steps the shipped baseline applies. */
export const FLAT_USEFUL_STEP = 10;
export const FLAT_NOT_USEFUL_STEP = 25;

const feedbackEventSchema = z.strictObject({
  itemId: z.string().min(1).max(200),
  useful: z.boolean(),
  at: z.number().int().safe(),
  source: z.enum(["mcp", "email"]),
});

export const adaptationHistorySchema = z
  .strictObject({
    version: z.number().int().positive().safe(),
    corpusId: z.string().min(1),
    /** Top-k budget; identical for every arm of the comparison. */
    k: z.number().int().min(1).max(100).safe(),
    /** Recorded explicit judgments only; absence of events is not positive. */
    events: z.array(feedbackEventSchema).max(1000),
    limits: z.strictObject({
      /** Recency weighting: influence decays linearly to zero at this age. */
      recencyHorizonDays: z.number().int().min(1).max(3650).safe(),
      /** Expiring boost: useful judgments inside this window count. */
      boostWindowDays: z.number().int().min(1).max(3650).safe(),
      /** Expiring boost: distinct items with useful latest judgments needed. */
      boostThreshold: z.number().int().min(1).max(1000).safe(),
      /** Expiring boost: boosts expire this long after the last useful event. */
      boostExpiryDays: z.number().int().min(1).max(3650).safe(),
      /** Expiring boost: relevance granted while live, in addition to the
       * flat judgment adjustment; bounded by the flat useful step. */
      boostStep: z.number().int().min(0).max(FLAT_USEFUL_STEP).safe(),
      /** Widening: derived adjacent terms per interest, at most. */
      maxAdjacentTerms: z.number().int().min(0).max(10).safe(),
      /** Widening: a derived term needs support from this many useful items. */
      adjacentTermMinSupport: z.number().int().min(1).max(100).safe(),
    }),
  })
  .superRefine((history, context) => {
    if (history.events.some((event) => event.at < 0))
      context.addIssue({
        code: "custom",
        message: "Feedback timestamps must not be negative",
      });
  });
export type AdaptationHistory = z.infer<typeof adaptationHistorySchema>;
export type AdaptationLimits = AdaptationHistory["limits"];

export const ADAPTATION_ARMS = [
  "baseline",
  "recency-weighted-feedback",
  "expiring-feedback-boost",
  "adjacent-term-widening",
] as const;
export type AdaptationArm = (typeof ADAPTATION_ARMS)[number];

export const INTEREST_ADAPTATION_ARMS: Record<AdaptationArm, string> = {
  baseline: `${SCORING_CRITERIA_VERSION}: flat +10/-25 adjustment from the latest explicit judgment`,
  "recency-weighted-feedback":
    "candidate: the judgment adjustment decays linearly with age to zero at the horizon, never exceeding the flat step",
  "expiring-feedback-boost":
    "candidate: when the configured count of distinct items holds useful latest judgments inside the window, matching items gain a temporary bounded boost that expires a fixed time after the last useful judgment",
  "adjacent-term-widening":
    "candidate: terms supported by explicitly useful items that already matched the interest widen the interest's keywords; original terms are never removed",
};

export interface AdaptationChange {
  itemId?: string;
  interestId: string;
  terms: string[];
  /** Temporary-boost expiry; null where the change carries no clock. */
  expiry: number | null;
  /** Remaining decay weight or supporting-item count; null where not applicable. */
  remaining: number | null;
  adjustment: number;
}

export interface AdaptationSummary {
  /** Explainable, versioned changes per arm; empty for baseline. */
  widenedTerms: AdaptationChange[];
  temporaryBoosts: AdaptationChange[];
  reweightedFeedback: AdaptationChange[];
  /** The exact terms the arm added to each interest; empty for baseline. */
  addedInterestTerms: { interestId: string; terms: string[] }[];
}

export interface Ratio {
  numerator: number;
  denominator: number;
  value: number | null;
  unknown: number;
}

export interface AdaptationMetrics {
  precisionAtK: Ratio;
  duplicateRate: Ratio;
  usefulDiscoveries: Ratio;
  outsideSubscriptionRelevance: Ratio;
  importantRecall: Ratio;
  groupPairPrecision: Ratio;
  groupPairRecall: Ratio;
  /** False topic drift: selected labeled-irrelevant items lacking a useful judgment. */
  topicDrift: Ratio;
  /** Distinct labeled developments covered by the top k over all in the corpus. */
  developmentDiversity: Ratio;
}

export interface AdaptedRankingRow {
  id: string;
  groupId: string;
  eligible: boolean;
  total: number;
  criteriaVersion: string;
}

export interface ArmReport {
  arm: AdaptationArm;
  description: string;
  metrics: AdaptationMetrics;
  ranking: AdaptedRankingRow[];
  excluded: AdaptedRankingRow[];
  changes: AdaptationSummary;
  missedImportantDevelopments: string[];
}

export interface RatioDelta {
  baseline: Ratio;
  current: Ratio;
  delta: number | null;
  unknown: boolean;
}

export interface AdaptationMetricComparison {
  precisionAtK: RatioDelta;
  importantRecall: RatioDelta;
  usefulDiscoveries: RatioDelta;
  outsideSubscriptionRelevance: RatioDelta;
  developmentDiversity: RatioDelta;
  topicDrift: RatioDelta;
}

/** Adoption gates, fixed in code before the result is observed and recorded. */
export interface AdoptionDecision {
  evaluatedVersion: string;
  threshold: {
    statement: string;
    required: string[];
  };
  perArm: Record<
    AdaptationArm,
    {
      metrics: AdaptationMetricComparison | null;
      adopted: boolean;
      reason: string;
    }
  >;
  adoptedArm: AdaptationArm | null;
  summary: string;
}

export interface InterestAdaptationReport {
  evaluation: { id: string; version: string };
  corpus: {
    id: string;
    version: number;
    asOf: number;
    items: number;
    hash: string;
  };
  history: { id: string; version: number; events: number; hash: string };
  config: {
    k: number;
    asOf: number;
    criteriaVersion: string;
    groupingVersion: string;
    arms: AdaptationArm[];
    limits: AdaptationLimits;
    profiles: { id: string; version: number }[];
  };
  arms: ArmReport[];
  comparison: {
    baselineArm: "baseline";
    perArm: Record<AdaptationArm, AdaptationMetricComparison | null>;
  };
  adoption: AdoptionDecision;
  usage: {
    providerCalls: 0;
    cost: null;
    costPerUsefulDiscovery: {
      value: null;
      usefulDiscoveries: number;
      unknownLabels: number;
    };
  };
  latencyMs: null;
  latencyReason: string;
}

function tokenize(text: string): string[] {
  return text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Small deterministic function-word stoplist so derived adjacent terms are
 * content terms rather than tokenization artifacts. Deliberately minimal:
 * anything more is vocabulary design, not adaptation.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "for",
  "nor",
  "so",
  "yet",
  "of",
  "on",
  "in",
  "to",
  "by",
  "as",
  "at",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "its",
  "his",
  "her",
  "their",
  "our",
  "that",
  "this",
  "these",
  "those",
  "with",
  "from",
  "have",
  "has",
  "had",
  "not",
  "are",
  "can",
  "will",
  "may",
  "who",
  "which",
]);

/** Latest recorded judgment for an item, newest by time then recorded order. */
export function latestFeedbackFor(
  events: { itemId: string; useful: boolean; at: number }[],
  itemId: string,
): { useful: boolean; at: number } | null {
  let latest: { useful: boolean; at: number; order: number } | null = null;
  for (const [order, event] of events.entries()) {
    if (event.itemId !== itemId) continue;
    if (
      !latest ||
      event.at > latest.at ||
      (event.at === latest.at && order > latest.order)
    )
      latest = { useful: event.useful, at: event.at, order };
  }
  return latest;
}

function unfeedbackedRelevance(prepared: {
  input: Parameters<typeof scoreItem>[0];
}): number {
  return scoreItem({ ...prepared.input, feedback: null }).components.relevance;
}

function applyAdjustment(
  score: ScoreResult,
  baseRelevance: number,
  adjustment: number,
  reason: string,
): ScoreResult {
  const components = {
    ...score.components,
    relevance: Math.max(0, Math.min(100, baseRelevance + adjustment)),
  };
  const keys = Object.keys(score.weights) as (keyof typeof score.weights)[];
  const total = Math.round(
    keys.reduce((sum, k) => sum + components[k] * score.weights[k], 0) /
      keys.reduce((sum, k) => sum + score.weights[k], 0),
  );
  return { ...score, components, total, reasons: [...score.reasons, reason] };
}

interface PreparedScoring {
  itemId: string;
  corpusItem: EvaluationCorpus["items"][number];
  tokens: string[];
  input: Parameters<typeof scoreItem>[0];
  /** Interest ids the production scorer matched, from its own reasons. */
  matchedInterestIds(score: ScoreResult): string[];
}

function prepare(corpus: EvaluationCorpus): Map<string, PreparedScoring> {
  const active = corpus.profiles.filter(
    (p) => p.lifetime === "persistent" || p.expiresAt! > corpus.asOf,
  );
  const prepared = new Map<string, PreparedScoring>();
  for (const item of corpus.items) {
    const tokens = tokenize(`${item.title}\n${item.text}`);
    prepared.set(item.id, {
      itemId: item.id,
      corpusItem: item,
      tokens,
      input: {
        itemId: item.id,
        title: item.title,
        text: item.text,
        publishedAt: item.publishedAt,
        now: corpus.asOf,
        interests: active,
        analysis: item.analysis,
        history: null,
      },
      matchedInterestIds: (score: ScoreResult) => {
        const ids: string[] = [];
        for (const reason of score.reasons) {
          const match = /^interest:([^@]+)@/.exec(reason);
          if (match) ids.push(match[1]!);
        }
        return ids;
      },
    });
  }
  return prepared;
}

/** Re-score every corpus item with widened interests; additions only. */
function rescoreWidened(
  corpus: EvaluationCorpus,
  prepared: Map<string, PreparedScoring>,
  active: EvaluationCorpus["profiles"],
  added: { interestId: string; terms: string[] }[],
  events: { itemId: string; useful: boolean; at: number }[],
): Map<string, ScoreResult> {
  const additions = new Map(added.map((row) => [row.interestId, row.terms]));
  const widened = active.map((profile) => {
    if (profile.kind !== "interest") return profile;
    const terms = additions.get(profile.id);
    return terms?.length
      ? { ...profile, keywords: [...profile.keywords, ...terms] }
      : profile;
  });
  const scores = new Map<string, ScoreResult>();
  for (const item of corpus.items) {
    scores.set(
      item.id,
      scoreItem({
        ...prepared.get(item.id)!.input,
        interests: widened,
        feedback: latestFeedbackFor(events, item.id),
      }),
    );
  }
  return scores;
}

/**
 * Derive per-interest adjacent terms from explicitly useful items that
 * already matched that interest under the baseline. Deterministic,
 * support-ranked, capped; original terms are never touched.
 */
export function deriveAdjacentTerms(
  prepared: Map<string, PreparedScoring>,
  baselineScores: Map<string, ScoreResult>,
  events: AdaptationHistory["events"],
  active: EvaluationCorpus["profiles"],
  limits: AdaptationLimits,
): { interestId: string; terms: string[] }[] {
  const usefulIds = new Set(
    [...new Set(events.map((event) => event.itemId))].filter(
      (id) => latestFeedbackFor(events, id)?.useful === true,
    ),
  );
  const derived: { interestId: string; terms: string[] }[] = [];
  for (const profile of active) {
    if (profile.kind !== "interest") continue;
    const own = new Set(
      [
        ...profile.entities,
        ...profile.keywords,
        ...profile.positive,
        ...profile.negative,
      ].map((term) => term.toLocaleLowerCase("en")),
    );
    const support = new Map<string, Set<string>>();
    for (const id of usefulIds) {
      const entry = prepared.get(id);
      const score = baselineScores.get(id);
      if (!entry || !score) continue;
      if (!entry.matchedInterestIds(score).includes(profile.id)) continue;
      for (const token of entry.tokens) {
        if (token.length < 3 || own.has(token) || STOPWORDS.has(token))
          continue;
        const set = support.get(token) ?? new Set<string>();
        set.add(id);
        support.set(token, set);
      }
    }
    const terms = [...support.entries()]
      .filter(([, ids]) => ids.size >= limits.adjacentTermMinSupport)
      .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], "en"))
      .slice(0, limits.maxAdjacentTerms)
      .map(([token]) => token);
    if (terms.length) derived.push({ interestId: profile.id, terms });
  }
  return derived;
}

function ratio(numerator: number, denominator: number, unknown: number): Ratio {
  return {
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
    unknown,
  };
}

/** Extra issue-#25 axes, measured against the same corpus labels. */
export function measureDriftAndDiversity(
  corpus: EvaluationCorpus,
  fullRanking: RankedRow[],
  k: number,
  events: { itemId: string; useful: boolean; at: number }[],
): { topicDrift: Ratio; developmentDiversity: Ratio } {
  const byId = new Map(corpus.items.map((item) => [item.id, item]));
  const selected = fullRanking
    .filter((row) => row.eligible)
    .slice(0, k)
    .map((row) => byId.get(row.id)!)
    .filter((item) => item !== undefined);
  const irrelevantTotal = corpus.items.filter(
    (item) => item.relevance === "irrelevant",
  );
  const drifted = selected.filter(
    (item) =>
      item.relevance === "irrelevant" &&
      latestFeedbackFor(events, item.id)?.useful !== true,
  );
  const allDevelopments = new Set(
    corpus.items
      .filter((item) => item.development !== null)
      .map((item) => item.development!),
  );
  const selectedDevelopments = new Set(
    selected
      .filter((item) => item.development !== null)
      .map((item) => item.development!),
  );
  return {
    topicDrift: ratio(
      drifted.length,
      irrelevantTotal.length,
      corpus.items.filter(
        (item) => item.relevance === null || item.relevance === "borderline",
      ).length,
    ),
    developmentDiversity: ratio(
      selectedDevelopments.size,
      allDevelopments.size,
      selected.filter((item) => item.development === null).length,
    ),
  };
}

interface RankedRow {
  id: string;
  groupId: string;
  eligible?: boolean;
}

function rankArm(
  corpus: EvaluationCorpus,
  k: number,
  scores: Map<string, ScoreResult>,
): {
  ranking: AdaptedRankingRow[];
  excluded: AdaptedRankingRow[];
  full: RankedRow[];
} {
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
  const all: AdaptedRankingRow[] = corpus.items
    .map((item) => ({ itemId: item.id, score: scores.get(item.id)! }))
    .sort(compareScores)
    .map((row) => ({
      id: row.itemId,
      groupId: groups.get(row.itemId) ?? row.itemId,
      eligible: row.score.eligible,
      total: row.score.total,
      criteriaVersion: row.score.criteriaVersion,
    }));
  return {
    ranking: all.filter((row) => row.eligible),
    excluded: all.filter((row) => !row.eligible),
    full: all.map(({ id, groupId, eligible }) => ({ id, groupId, eligible })),
  };
}

function deltaFor(before: Ratio, after: Ratio): RatioDelta {
  return {
    baseline: before,
    current: after,
    delta:
      before.value === null || after.value === null
        ? null
        : after.value - before.value,
    unknown:
      before.unknown > 0 ||
      after.unknown > 0 ||
      before.value === null ||
      after.value === null,
  };
}

function compareArm(
  base: ArmReport,
  arm: ArmReport,
): AdaptationMetricComparison {
  return {
    precisionAtK: deltaFor(base.metrics.precisionAtK, arm.metrics.precisionAtK),
    importantRecall: deltaFor(
      base.metrics.importantRecall,
      arm.metrics.importantRecall,
    ),
    usefulDiscoveries: deltaFor(
      base.metrics.usefulDiscoveries,
      arm.metrics.usefulDiscoveries,
    ),
    outsideSubscriptionRelevance: deltaFor(
      base.metrics.outsideSubscriptionRelevance,
      arm.metrics.outsideSubscriptionRelevance,
    ),
    developmentDiversity: deltaFor(
      base.metrics.developmentDiversity,
      arm.metrics.developmentDiversity,
    ),
    topicDrift: deltaFor(base.metrics.topicDrift, arm.metrics.topicDrift),
  };
}

/** Adoption axes and the drift bound, fixed before the replay is observed. */
const ADOPTED_AXES = [
  "precisionAtK",
  "importantRecall",
  "usefulDiscoveries",
  "outsideSubscriptionRelevance",
  "developmentDiversity",
] as const satisfies readonly (keyof AdaptationMetricComparison)[];

function decideAdoption(
  arms: ArmReport[],
  comparisons: Record<AdaptationArm, AdaptationMetricComparison | null>,
): AdoptionDecision {
  const baseline = arms.find((arm) => arm.arm === "baseline");
  if (!baseline) throw new Error("The baseline arm is required");
  const empty = { metrics: null, adopted: false, reason: "not evaluated" };
  const perArm: AdoptionDecision["perArm"] = {
    baseline: {
      metrics: null,
      adopted: true,
      reason: `Recorded baseline: shipped ${SCORING_CRITERIA_VERSION} scoring unchanged.`,
    },
    "recency-weighted-feedback": { ...empty },
    "expiring-feedback-boost": { ...empty },
    "adjacent-term-widening": { ...empty },
  };
  for (const arm of arms) {
    if (arm.arm === "baseline") continue;
    const comparison = comparisons[arm.arm];
    if (!comparison) continue;
    const unknown =
      ADOPTED_AXES.some((axis) => comparison[axis].unknown) ||
      comparison.topicDrift.unknown;
    const regressions: (keyof AdaptationMetricComparison)[] =
      ADOPTED_AXES.filter(
        (axis) => !comparison[axis].unknown && comparison[axis].delta! < 0,
      );
    if (!comparison.topicDrift.unknown && comparison.topicDrift.delta! > 0)
      regressions.push("topicDrift");
    const strictImprovements = ADOPTED_AXES.filter(
      (axis) => comparison[axis].delta! > 0,
    );
    const arms_reason: string[] = [];
    if (unknown)
      arms_reason.push(
        "one or more gated metric axes are unknown on this corpus",
      );
    if (regressions.length)
      arms_reason.push(`regressed: ${regressions.join(", ")}`);
    if (!strictImprovements.length)
      arms_reason.push("no gated axis measurably improved over the baseline");
    if (unknown || regressions.length || !strictImprovements.length) {
      perArm[arm.arm] = {
        metrics: comparison,
        adopted: false,
        reason: arms_reason.join("; "),
      };
      continue;
    }
    perArm[arm.arm] = {
      metrics: comparison,
      adopted: true,
      reason: `met the adoption threshold: ${strictImprovements.join(", ")} improved with no regressions and no drift increase`,
    };
  }
  const adoptedArm =
    (Object.entries(perArm) as [AdaptationArm, { adopted: boolean }][])
      .filter(([arm]) => arm !== "baseline")
      .find(([, state]) => state.adopted)?.[0] ?? null;
  return {
    evaluatedVersion: ADAPTATION_EVALUATION_VERSION,
    threshold: {
      statement:
        "Adopt a candidate only when, on the same labeled corpus, replay instant, profiles and top-k budget: precision@k, important-development recall, useful discoveries, outside-subscription relevance and development diversity are all not lower than the baseline, topic drift is not higher, at least one gated axis strictly improves, and no gated axis is unknown. Otherwise retain the shipped baseline and record the observed result.",
      required: [...ADOPTED_AXES, "topicDrift"],
    },
    perArm,
    adoptedArm,
    summary: adoptedArm
      ? `Adopted ${adoptedArm} behind a named scoring version and explicit setting with reversible state.`
      : "No candidate met the threshold on this corpus; the shipped baseline is retained and the observed result is recorded for revisit.",
  };
}

function armReport(
  corpus: EvaluationCorpus,
  history: AdaptationHistory,
  arm: AdaptationArm,
  scores: Map<string, ScoreResult>,
  changes: AdaptationSummary,
  events: { itemId: string; useful: boolean; at: number }[],
): ArmReport {
  const { ranking, excluded, full } = rankArm(corpus, history.k, scores);
  const measured = measureRanking(corpus, full, history.k);
  const { topicDrift, developmentDiversity } = measureDriftAndDiversity(
    corpus,
    full,
    history.k,
    events,
  );
  const metrics: AdaptationMetrics = {
    precisionAtK: measured.precisionAtK,
    duplicateRate: measured.duplicateRate,
    usefulDiscoveries: measured.usefulDiscoveries,
    outsideSubscriptionRelevance: measured.outsideSubscriptionRelevance,
    importantRecall: measured.importantRecall,
    groupPairPrecision: measured.groupPairPrecision,
    groupPairRecall: measured.groupPairRecall,
    topicDrift,
    developmentDiversity,
  };
  return {
    arm,
    description: INTEREST_ADAPTATION_ARMS[arm],
    metrics,
    ranking,
    excluded,
    changes,
    missedImportantDevelopments: measured.missedImportantDevelopments,
  };
}

export function evaluateInterestAdaptation(
  corpusInput: unknown,
  historyInput: unknown,
  options: { arms?: AdaptationArm[] } = {},
): InterestAdaptationReport {
  const corpus = corpusSchema.parse(corpusInput);
  const history = adaptationHistorySchema.parse(historyInput);
  if (history.corpusId !== corpus.id)
    throw new Error(
      `History targets corpus ${history.corpusId}, not ${corpus.id}`,
    );
  const future = history.events.filter((event) => event.at > corpus.asOf);
  if (future.length)
    throw new Error(
      `${future.length} recorded event(s) are newer than the replay instant and must not leak into the comparison`,
    );
  const known = new Set(corpus.items.map((item) => item.id));
  const unknownIds = [...new Set(history.events.map((e) => e.itemId))].filter(
    (id) => !known.has(id),
  );
  if (unknownIds.length)
    throw new Error(
      `History references unknown item id(s): ${unknownIds.join(", ")}`,
    );
  const arms = options.arms ?? [...ADAPTATION_ARMS];
  if (!arms.includes("baseline"))
    throw new Error("The baseline arm is required for comparison");
  const active = corpus.profiles.filter(
    (p) => p.lifetime === "persistent" || p.expiresAt! > corpus.asOf,
  );
  const prepared = prepare(corpus);
  const events = [...history.events].sort((a, b) => a.at - b.at);
  const limits = history.limits;

  // Baseline: exactly the shipped pass, including its flat
  // bounded adjustment from the latest explicit judgment per item.
  const baselineScores = new Map<string, ScoreResult>();
  for (const [id, entry] of prepared)
    baselineScores.set(
      id,
      scoreItem({ ...entry.input, feedback: latestFeedbackFor(events, id) }),
    );

  // Candidate one: recency-weighted feedback. The adjustment decays linearly
  // with age and never exceeds the flat step in either direction.
  const recencyScores = new Map(baselineScores);
  const reweighted: AdaptationChange[] = [];
  if (arms.includes("recency-weighted-feedback")) {
    const horizon = limits.recencyHorizonDays * DAY_MS;
    for (const [id, entry] of prepared) {
      const judgment = latestFeedbackFor(events, id);
      if (!judgment) continue;
      const age = corpus.asOf - judgment.at;
      const decay = Math.max(0, Math.min(1, 1 - age / horizon));
      const step = judgment.useful ? FLAT_USEFUL_STEP : FLAT_NOT_USEFUL_STEP;
      const sign = judgment.useful ? 1 : -1;
      const adjustment = Math.round(sign * step * decay);
      recencyScores.set(
        id,
        applyAdjustment(
          recencyScores.get(id)!,
          unfeedbackedRelevance(entry),
          adjustment,
          `adaptation:recency-decay:${judgment.useful ? "useful" : "not_useful"}@${judgment.at}:age_days=${Math.floor(age / DAY_MS)}:decay=${decay.toFixed(3)}:adj=${adjustment}`,
        ),
      );
      reweighted.push({
        itemId: id,
        interestId: "",
        terms: [],
        expiry: null,
        remaining: Number(decay.toFixed(3)),
        adjustment,
      });
    }
  }

  // Candidate two: expiring feedback boost. A temporary, bounded,
  // interest-shaped boost that expires by clock after the last useful event.
  const boostScores = new Map(baselineScores);
  const boostByItem = new Map<string, number>();
  const temporaryBoosts: AdaptationChange[] = [];
  if (arms.includes("expiring-feedback-boost")) {
    for (const profile of active) {
      if (profile.kind !== "interest") continue;
      // Temporary-interest semantics: repeated explicit useful judgments on
      // items the interest matched within the window raise the interest's
      // standing, for everything the interest matches, until the expiry.
      const windowStart = corpus.asOf - limits.boostWindowDays * DAY_MS;
      const usefulItems = new Set(
        [...new Set(events.map((event) => event.itemId))].filter((id) => {
          const judgment = latestFeedbackFor(events, id);
          const score = baselineScores.get(id);
          return (
            judgment?.useful === true &&
            judgment.at >= windowStart &&
            score?.eligible === true &&
            prepared.get(id)!.matchedInterestIds(score).includes(profile.id)
          );
        }),
      );
      if (usefulItems.size < limits.boostThreshold) continue;
      const lastUseful = Math.max(
        ...[...usefulItems].map((id) => latestFeedbackFor(events, id)!.at),
      );
      const expiry = lastUseful + limits.boostExpiryDays * DAY_MS;
      if (corpus.asOf >= expiry) continue;
      const step = Math.min(limits.boostStep, FLAT_USEFUL_STEP);
      // Applied to everything the interest matched under the baseline, so
      // the boost is interest-shaped. It adds on top of the flat explicit
      // judgment adjustment — an explicit not_useful penalty stays applied,
      // adaptation never overrides or erases it. An item matching several
      // boosted interests still gains at most FLAT_USEFUL_STEP relative to
      // its baseline score: the cumulative per-item boost is capped so
      // overlapping interests cannot push an explicitly not_useful item
      // above its no-feedback standing or exceed the documented bound.
      const matchedIds = [...baselineScores.entries()]
        .filter(
          ([id, score]) =>
            score.eligible &&
            prepared.get(id)!.matchedInterestIds(score).includes(profile.id),
        )
        .map(([id]) => id);
      for (const id of matchedIds) {
        const applied = boostByItem.get(id) ?? 0;
        const remainingCap = FLAT_USEFUL_STEP - applied;
        if (remainingCap <= 0) continue;
        const appliedStep = Math.min(step, remainingCap);
        const score = boostScores.get(id)!;
        boostScores.set(
          id,
          applyAdjustment(
            score,
            score.components.relevance,
            appliedStep,
            `adaptation:temporary-boost:interest=${profile.id}@${profile.version}:expiry=${expiry}:adj=${appliedStep}:cumulative=${applied + appliedStep}`,
          ),
        );
        boostByItem.set(id, applied + appliedStep);
      }
      temporaryBoosts.push({
        interestId: profile.id,
        terms: [],
        expiry,
        remaining: usefulItems.size,
        adjustment: step,
      });
    }
  }

  // Candidate three: adjacent-term widening from explicitly useful items.
  const wideningScores = new Map(baselineScores);
  const addedInterestTerms: { interestId: string; terms: string[] }[] = [];
  if (arms.includes("adjacent-term-widening")) {
    const derived = deriveAdjacentTerms(
      prepared,
      baselineScores,
      events,
      active,
      limits,
    );
    if (derived.length) {
      addedInterestTerms.push(...derived);
      for (const [id, score] of rescoreWidened(
        corpus,
        prepared,
        active,
        derived,
        events,
      ))
        wideningScores.set(id, score);
    }
  }

  const emptyChanges: AdaptationSummary = {
    widenedTerms: [],
    temporaryBoosts: [],
    reweightedFeedback: [],
    addedInterestTerms: [],
  };
  const changesByArm: Record<AdaptationArm, AdaptationSummary> = {
    baseline: { ...emptyChanges },
    "recency-weighted-feedback": {
      ...emptyChanges,
      reweightedFeedback: reweighted,
    },
    "expiring-feedback-boost": { ...emptyChanges, temporaryBoosts },
    "adjacent-term-widening": { ...emptyChanges, addedInterestTerms },
  };
  const scoresByArm: Record<AdaptationArm, Map<string, ScoreResult>> = {
    baseline: baselineScores,
    "recency-weighted-feedback": recencyScores,
    "expiring-feedback-boost": boostScores,
    "adjacent-term-widening": wideningScores,
  };
  const armReports = arms.map((arm) =>
    armReport(
      corpus,
      history,
      arm,
      scoresByArm[arm],
      changesByArm[arm],
      events,
    ),
  );
  const baselineReport = armReports.find((arm) => arm.arm === "baseline")!;
  const comparisons: Record<AdaptationArm, AdaptationMetricComparison | null> =
    {
      baseline: null,
      "recency-weighted-feedback": null,
      "expiring-feedback-boost": null,
      "adjacent-term-widening": null,
    };
  for (const arm of armReports) {
    if (arm.arm === "baseline") continue;
    comparisons[arm.arm] = compareArm(baselineReport, arm);
  }
  return {
    evaluation: { id: corpus.id, version: ADAPTATION_EVALUATION_VERSION },
    corpus: {
      id: corpus.id,
      version: corpus.version,
      asOf: corpus.asOf,
      items: corpus.items.length,
      hash: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
    },
    history: {
      id: history.corpusId,
      version: history.version,
      events: history.events.length,
      hash: createHash("sha256").update(JSON.stringify(history)).digest("hex"),
    },
    config: {
      k: history.k,
      asOf: corpus.asOf,
      criteriaVersion: SCORING_CRITERIA_VERSION,
      groupingVersion: STORY_RULE_VERSION,
      arms,
      limits,
      profiles: corpus.profiles.map(({ id, version }) => ({ id, version })),
    },
    arms: armReports,
    comparison: { baselineArm: "baseline", perArm: comparisons },
    adoption: decideAdoption(armReports, comparisons),
    usage: {
      providerCalls: 0,
      cost: null,
      costPerUsefulDiscovery: {
        value: null,
        usefulDiscoveries: baselineReport.metrics.usefulDiscoveries.numerator,
        unknownLabels: baselineReport.metrics.usefulDiscoveries.unknown,
      },
    },
    latencyMs: null,
    latencyReason:
      "No timing observation recorded; elapsed time is environment-dependent and excluded from deterministic replay.",
  };
}
