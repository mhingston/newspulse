import { expect, test } from "bun:test";
import {
  evaluateSourceRecommendations,
  type SourceRecommendationReport,
} from "../src/source-suggestion-evaluation";
import corpusJson from "./fixtures/source-recommendation-corpus-v1.json";
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
  const baselineCore = { ...baseline, run: undefined } as unknown as Record<
    string,
    unknown
  >;
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

test("metrics measure suggestion quality against the item-level baseline, with unknowns explicit", () => {
  const report = evaluateSourceRecommendations(corpus);
  expect(report.metrics.suggestionPrecision.value).toBeCloseTo(2 / 3);
  expect(report.metrics.falsePositives.map((f) => f.domain)).toEqual([
    "mixed-review.example",
  ]);
  expect(report.metrics.developmentRecall.baseline.value).toBeCloseTo(0.25);
  expect(report.metrics.developmentRecall.withSuggestions.value).toBe(1);
  expect(report.metrics.developmentRecall.lift.value).toBeCloseTo(0.75);
  expect(report.metrics.novelty.value).toBeCloseTo(0.75);
  expect(
    report.metrics.diversity.withSuggestionsDistinctDomains,
  ).toBeGreaterThan(report.metrics.diversity.baselineDistinctDomains);
  // Suggestion generation spends nothing beyond recorded discovery.
  expect(report.cost.suggestionCostMicros).toBe(0);
  expect(report.cost.realWorldCost).toBe("unknown");
  expect(report.decisions.gate).toContain("suggestionLift>0:true");
  expect(report.decisions.evidence).toContain("supports adopting");
});

test("changed evidence changes the measured outcome (quality-shift regression coverage)", () => {
  // Drop all useful feedback outside the window only: removing the recent
  // negative feedback must keep the quality-declining source disqualified.
  const mutated = {
    ...corpus,
    items: corpus.items.map((item: Record<string, unknown>) =>
      item.id === "fq-a" || item.id === "fq-b"
        ? { ...item, feedback: undefined, feedbackAt: undefined }
        : item,
    ),
  };
  const report = evaluateSourceRecommendations(mutated);
  const skipped = new Map(report.run.skipped.map((s) => [s.domain, s.reason]));
  // Without stale useful feedback the domain fails the recency requirement
  // rather than the quality-decline reason.
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
