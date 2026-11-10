import type { Interest } from "./profiles";

/** Version this whenever a rule, range or weight changes. */
export const SCORING_CRITERIA_VERSION = "deterministic-v3";
export type ScoreComponent =
  | "relevance"
  | "novelty"
  | "substance"
  | "evidence"
  | "practical"
  | "impact"
  | "nonredundancy";
export type Components = Record<ScoreComponent, number>;
export interface ScoringAnalysis {
  classification?: string;
  claims: { statement: string; citation: string }[];
  uncertainty: string[];
}
export interface ScoringInput {
  itemId: string;
  title: string;
  text: string;
  publishedAt: number | null;
  now: number;
  interests: Interest[];
  editorialProfiles?: {
    id: string;
    version: number;
    contentTypes: string[];
    criteria: { dimension: string; weight: number }[];
  }[];
  analysis: ScoringAnalysis | null;
  history: {
    sameDevelopment: boolean;
    meaningfulUpdate: boolean;
    snapshotUnavailable?: boolean;
  } | null;
  observedUpdateAt?: number | null;
  /** The latest *explicit* judgment for this item, if any. Never inferred. */
  feedback?: { useful: boolean; at: number } | null;
}
export interface ScoreResult {
  criteriaVersion: string;
  components: Components;
  weights: Components;
  total: number;
  eligible: boolean;
  reasons: string[];
  uncertainty: string[];
}

export const SCORING_WEIGHTS: Components = {
  relevance: 35,
  novelty: 15,
  substance: 10,
  evidence: 10,
  practical: 10,
  impact: 10,
  nonredundancy: 10,
};

function contains(text: string, phrase: string): boolean {
  const tokens = phrase.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu);
  if (!tokens?.length) return false;
  const haystack = text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? [];
  return haystack.some((_, i) =>
    tokens.every((token, j) => haystack[i + j] === token),
  );
}

/** Transparent lexical baseline. It does not assert that claims are true. */
export function scoreItem(input: ScoringInput): ScoreResult {
  const text = `${input.title}\n${input.text}`;
  const uncertainty: string[] = [];
  const reasons: string[] = [];
  const matches = input.interests.map((interest) => {
    const matched = [...interest.entities, ...interest.keywords].filter(
      (term) => contains(text, term),
    );
    const positives = interest.positive.filter((term) => contains(text, term));
    const negatives = interest.negative.filter((term) => contains(text, term));
    return { interest, matched, positives, negatives };
  });
  const best = matches.reduce((maximum, match) => {
    if (!match.matched.length) return maximum;
    return Math.max(
      maximum,
      Math.max(
        0,
        Math.min(
          100,
          35 +
            10 * match.matched.length +
            5 * match.interest.priority +
            5 * match.positives.length -
            15 * match.negatives.length,
        ),
      ),
    );
  }, 0);
  const eligible = best > 0;
  if (!input.interests.length) reasons.push("no_active_interests");
  else if (!eligible) reasons.push("no_interest_match");
  for (const match of matches.filter((m) => m.matched.length)) {
    reasons.push(
      `interest:${match.interest.id}@${match.interest.version}: ${match.matched.join(", ")}`,
    );
    if (match.negatives.length)
      reasons.push(`negative_preferences:${match.negatives.join(", ")}`);
  }
  let novelty = 50;
  if (input.publishedAt === null || input.publishedAt > input.now)
    uncertainty.push("publication_time_unavailable_or_future");
  else {
    const days = (input.now - input.publishedAt) / 86_400_000;
    novelty = days <= 2 ? 100 : days <= 7 ? 75 : days <= 30 ? 40 : 10;
  }
  if (
    (!input.history?.sameDevelopment &&
      input.observedUpdateAt != null &&
      input.observedUpdateAt <= input.now &&
      input.now - input.observedUpdateAt <= 7 * 86_400_000) ||
    input.history?.meaningfulUpdate
  )
    novelty = Math.max(novelty, 80);
  else if (input.history?.sameDevelopment) novelty = Math.min(novelty, 20);
  if (!input.history) uncertainty.push("history_unavailable");
  if (input.history?.snapshotUnavailable)
    uncertainty.push("historical_snapshot_unavailable");
  if (input.history?.sameDevelopment)
    reasons.push(
      input.history.meaningfulUpdate
        ? "previously_accepted_meaningful_update"
        : "previously_accepted_development",
    );
  if (input.observedUpdateAt != null) reasons.push("observed_source_update");
  // Explicit feedback is a bounded adjustment to relevance, not an override:
  // a not-useful judgment cannot make an unmatched item eligible.
  let relevance = best;
  if (input.feedback) {
    relevance = Math.max(
      0,
      Math.min(100, best + (input.feedback.useful ? 10 : -25)),
    );
    reasons.push(
      `explicit_feedback:${input.feedback.useful ? "useful" : "not_useful"}@${input.feedback.at}`,
    );
  }
  if (!input.analysis) uncertainty.push("analysis_unavailable");
  else if (input.analysis.uncertainty.length)
    uncertainty.push("analysis_reports_uncertainty");
  const length = input.text.trim().length;
  const components: Components = {
    relevance,
    novelty,
    substance:
      length >= 2000 ? 100 : length >= 500 ? 70 : length >= 100 ? 40 : 10,
    // Citations show provenance, not verified accuracy or source credibility.
    evidence: input.analysis ? (input.analysis.claims.length ? 60 : 30) : 30,
    practical: /\b(how to|guide|tutorial|implementation|tool|release)\b/i.test(
      text,
    )
      ? 70
      : 30,
    impact: /\b(security|vulnerability|policy|law|health|breakthrough)\b/i.test(
      text,
    )
      ? 70
      : 30,
    nonredundancy:
      input.history?.sameDevelopment && !input.history.meaningfulUpdate
        ? 0
        : input.history
          ? 100
          : 50,
  };
  const weights = { ...SCORING_WEIGHTS };
  // Editorial dimensions are optional multipliers on known components, not
  // free-form executable instructions. Unknown criteria remain visible.
  const editorial =
    input.editorialProfiles?.filter(
      (p) =>
        input.analysis?.classification &&
        p.contentTypes.includes(input.analysis.classification),
    ) ?? [];
  for (const profile of editorial) {
    reasons.push(`editorial:${profile.id}@${profile.version}`);
    for (const criterion of profile.criteria) {
      if (Object.hasOwn(weights, criterion.dimension))
        weights[criterion.dimension as ScoreComponent] += criterion.weight;
      else
        uncertainty.push(`unknown_editorial_dimension:${criterion.dimension}`);
    }
  }
  const keys = Object.keys(weights) as ScoreComponent[];
  const total = Math.round(
    keys.reduce((sum, key) => sum + components[key] * weights[key], 0) /
      keys.reduce((sum, key) => sum + weights[key], 0),
  );
  return {
    criteriaVersion: SCORING_CRITERIA_VERSION,
    components,
    weights,
    total,
    eligible,
    reasons,
    uncertainty,
  };
}

export interface SpecialistJudge {
  version: string;
  model: string;
  judge(input: ScoringInput, signal: AbortSignal): Promise<unknown>;
}

/** Optional advisory judgment; failure never changes the deterministic score. */
export async function scoreWithSpecialist(
  input: ScoringInput,
  judge?: SpecialistJudge,
  timeoutMs = 1000,
): Promise<
  ScoreResult & {
    specialist: { version: string; model: string; assessment: string } | null;
  }
> {
  const score = scoreItem(input);
  if (!judge)
    return {
      ...score,
      uncertainty: [...score.uncertainty, "specialist_unavailable"],
      specialist: null,
    };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      judge.judge(input, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("timeout"));
        }, timeoutMs);
      }),
    ]);
    if (typeof output !== "string" || !output.trim() || output.length > 2000)
      throw new Error("invalid output");
    return {
      ...score,
      specialist: {
        version: judge.version,
        model: judge.model,
        assessment: output,
      },
    };
  } catch {
    return {
      ...score,
      uncertainty: [...score.uncertainty, "specialist_failed"],
      specialist: null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stable ordering is independent of insertion order. */
export function compareScores(
  a: { itemId: string; score: ScoreResult },
  b: { itemId: string; score: ScoreResult },
): number {
  return (
    Number(b.score.eligible) - Number(a.score.eligible) ||
    b.score.total - a.score.total ||
    a.itemId.localeCompare(b.itemId, "en")
  );
}
