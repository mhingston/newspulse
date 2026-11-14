import { expect, test } from "bun:test";
import {
  evaluateSourceRecommendations,
  type SourceRecommendationReport,
} from "../src/source-suggestion-evaluation";
import corpusJson from "./fixtures/source-recommendation-corpus-v2.json";
import baselineJson from "../docs/baselines/source-recommendations-v1.json";

const corpus = corpusJson;

test("the recorded baseline replay is reproduced exactly, offline", () => {
  const fresh: SourceRecommendationReport =
    evaluateSourceRecommendations(corpus);
  const baseline = baselineJson as unknown as SourceRecommendationReport;
  const freshCore = { ...fresh, run: undefined } as unknown as Record<
    string,
    unknown
  >;
  const baselineCore = {
    ...baseline,
    run: undefined,
  } as unknown as Record<string, unknown>;
  // Metrics, cost and decision evidence must match the recorded baseline
  // byte-for-byte; the embedded run is compared separately.
  expect(JSON.stringify(freshCore)).toBe(JSON.stringify(baselineCore));
  expect(fresh.run.suggestions.map((s) => s.id)).toEqual(
    baseline.run.suggestions.map((s) => s.id),
  );
  expect(fresh.run.skipped).toEqual(
    baseline.run.skipped as unknown as typeof fresh.run.skipped,
  );
});

test("the baseline arm includes recorded discoveries; the lift is genuinely incremental", () => {
  const report = evaluateSourceRecommendations(corpus);
  // Baseline: labeled developments already available through subscriptions
  // or recorded item-level discoveries (8 of 11).
  expect(report.metrics.developmentRecall.baseline.value).toBeCloseTo(8 / 11);
  expect(report.baseline.developmentsCovered).toContain("agent eval harness");
  expect(report.baseline.developmentsCovered).toContain("build tooling");
  // With suggestions only the held-out subsequent coverage is added.
  expect(report.metrics.developmentRecall.withSuggestions.value).toBeCloseTo(
    10 / 11,
  );
  expect(report.metrics.developmentRecall.lift.value).toBeCloseTo(2 / 11);
  expect(report.metrics.developmentRecall.newlyCovered).toEqual([
    "coverage-guided fuzzing",
    "flaky-test triage",
  ]);
  // The false-positive publisher's gossip development stays uncovered and
  // the irrelevant held-out item on it is not credited as useful coverage.
  expect(report.metrics.developmentRecall.stillUncovered).toEqual([
    "celebrity gossip",
  ]);
  expect(report.metrics.novelty).toEqual({
    newlyCoveredDevelopments: 2,
    totalDevelopments: 11,
    value: 2 / 11,
  });
});

test("metrics measure suggestion quality, with unknowns explicit and FPs recorded", () => {
  const report = evaluateSourceRecommendations(corpus);
  expect(report.metrics.suggestionPrecision.value).toBeCloseTo(2 / 3);
  expect(report.metrics.falsePositives.map((f) => f.domain)).toEqual([
    "mixed-review.example",
  ]);
  expect(
    report.metrics.diversity.withSuggestionsDistinctDomains,
  ).toBeGreaterThanOrEqual(report.metrics.diversity.baselineDistinctDomains);
  // Suggestion generation spends nothing beyond recorded discovery.
  expect(report.cost.suggestionCostMicros).toBe(0);
  expect(report.cost.realWorldCost).toBe("unknown");
  expect(report.decisions.gate).toContain("suggestionLift>0:true");
  expect(report.decisions.evidence).toContain("supports adopting");
});

test("changed evidence changes the measured outcome (quality-shift regression coverage)", () => {
  // Remove the stale useful feedback only: the quality-declining source must
  // stay disqualified, now failing the recency requirement.
  const mutated = {
    ...corpus,
    items: corpus.items.map((item: Record<string, unknown>) =>
      item.id === "fq-a" || item.id === "fq-b"
        ? { ...item, feedback: undefined, feedbackAt: undefined }
        : item,
    ),
  };
  const report = evaluateSourceRecommendations(mutated);
  const skipped = new Map(
    report.run.skipped.map((s) => [s.domain as string, s.reason]),
  );
  expect(skipped.get("fading-quarterly.example")).toContain("window");
  expect(
    report.run.suggestions.some((s) => s.domain === "fading-quarterly.example"),
  ).toBe(false);
});

test("empty discovered provenance reports zero proposals with null precision", () => {
  const empty = {
    ...corpus,
    items: corpus.items.filter(
      (item: Record<string, unknown>) => item.subscribed === true,
    ),
  };
  const report = evaluateSourceRecommendations(empty);
  expect(report.metrics.proposedSuggestions).toBe(0);
  expect(report.metrics.suggestionPrecision.value).toBeNull();
  expect(report.metrics.developmentRecall.lift.value).toBe(0);
});
