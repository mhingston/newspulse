import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import corpusJson from "./fixtures/evaluation-corpus-v1.json";
import historyJson from "./fixtures/interest-adaptation-history-v1.json";
import { corpusSchema, type EvaluationCorpus } from "../src/evaluation";
import {
  adaptationHistorySchema,
  ADAPTATION_ARMS,
  evaluateInterestAdaptation,
  FLAT_USEFUL_STEP,
  latestFeedbackFor,
  type AdaptationHistory,
  type InterestAdaptationReport,
} from "../src/interest-adaptation-evaluation";

const corpus: EvaluationCorpus = corpusSchema.parse(corpusJson);
const history: AdaptationHistory = adaptationHistorySchema.parse(historyJson);

test("adaptation replay is deterministic and matches the checked-in baseline", () => {
  const first = evaluateInterestAdaptation(corpus, history);
  expect(evaluateInterestAdaptation(corpus, history)).toEqual(first);
  expect(first.config).toMatchObject({
    k: 5,
    criteriaVersion: "deterministic-v3",
    groupingVersion: "specific-development-v1",
    profiles: [{ id: "synthetic-robotics", version: 1 }],
  });
  expect(first.usage).toEqual({
    providerCalls: 0,
    cost: null,
    costPerUsefulDiscovery: {
      value: null,
      usefulDiscoveries: 4,
      unknownLabels: 1,
    },
  });
  expect(first.latencyMs).toBeNull();
});

test("checked-in baseline matches a fresh deterministic replay", async () => {
  const baseline = await Bun.file(
    "docs/baselines/interest-adaptation-v1.json",
  ).json();
  expect(evaluateInterestAdaptation(corpus, history)).toEqual(baseline);
});

test("recorded evidence: every candidate reduces discovery and diversity, none is adopted", () => {
  const report = evaluateInterestAdaptation(corpus, history);
  expect(report.adoption.adoptedArm).toBeNull();
  for (const arm of ADAPTATION_ARMS) {
    if (arm === "baseline") continue;
    const comparison = report.comparison.perArm[arm]!;
    // Known relevant developments drop from the top k in every candidate:
    // recency weighting and boost semantics promote recent duplicate material
    // over a distinct relevant development, with no precision gain.
    expect(comparison.precisionAtK.delta).toBe(0);
    expect(comparison.usefulDiscoveries.delta).toBe(-0.25);
    expect(comparison.developmentDiversity.delta).toBeLessThan(0);
    // False topic drift does not rise, but the lack of improvement is itself
    // the recorded reason the baseline is kept.
    expect(comparison.topicDrift.delta).toBe(0);
    expect(report.adoption.perArm[arm].adopted).toBe(false);
    expect(report.adoption.perArm[arm].reason).toContain("regressed");
  }
});

test("negative and no-feedback histories cannot erase an explicit interest match", () => {
  // A history where every recorded judgment is not_useful and several items
  // have no feedback at all.
  const harsh = {
    ...history,
    version: 2,
    events: corpus.items
      .filter((item) => item.relevance !== "irrelevant")
      .map((item, index) => ({
        itemId: item.id,
        useful: false,
        at: history.events[0]!.at + index,
        source: "mcp" as const,
      })),
  };
  const report = evaluateInterestAdaptation(corpus, harsh);
  // Every item the explicit interest matches stays eligible in every arm;
  // feedback may adjust relevance, it can never make a matched item
  // ineligible or widen eligibility away.
  const eligibleSets = report.arms.map((arm) => ({
    arm: arm.arm,
    eligible: [...arm.ranking, ...arm.excluded]
      .filter((row) => row.eligible)
      .map((row) => row.id)
      .sort(),
  }));
  for (const { eligible } of eligibleSets) {
    expect(eligible).toBeTruthy();
    // Fashion matches nothing and stays excluded everywhere.
    expect(eligible).not.toContain("fashion");
    for (const id of [
      "atlas-release",
      "atlas-duplicate",
      "orion-release",
      "atlas-recall",
      "old-robotics",
      "discussion",
      "advertisement",
      "unknown-label",
    ]) {
      expect(eligible).toContain(id);
    }
  }
  expect(eligibleSets[0]!.eligible).toEqual(eligibleSets[1]!.eligible);
});

test("reweighting and boosting never touch items without recorded events, and significance never inverts an explicit judgment", () => {
  const report = evaluateInterestAdaptation(corpus, history);
  const recency = report.arms.find(
    (arm) => arm.arm === "recency-weighted-feedback",
  )!;
  const eventIds = new Set(history.events.map((event) => event.itemId));
  for (const change of recency.changes.reweightedFeedback) {
    expect(change.itemId).toBeDefined();
    expect(change.itemId && eventIds.has(change.itemId)).toBe(true);
    // Bounded by the flat deterministic-v3 step in both directions.
    expect(Math.abs(change.adjustment)).toBeLessThanOrEqual(25);
  }
  for (const id of ["orion-release", "discussion", "unknown-label"]) {
    expect(latestFeedbackFor(history.events, id)).toBeNull();
  }
  const boost = report.arms.find(
    (arm) => arm.arm === "expiring-feedback-boost",
  )!;
  // The boost adds on top of the flat judgment adjustment, so the explicit
  // not_useful penalty on atlas-duplicate is still fully applied: it gains
  // only the bounded temporary step (relevance 60 -> 65, total 58 -> 60),
  // never a reversal of the explicit judgment.
  const boostRow = boost.ranking.find((row) => row.id === "atlas-duplicate")!;
  const baselineRow = report.arms[0]!.ranking.find(
    (row) => row.id === "atlas-duplicate",
  )!;
  expect(baselineRow.total).toBe(58);
  expect(boostRow.total).toBe(60);
});

test("overlapping interests cannot exceed the cumulative per-item boost bound", () => {
  // Three clones of the same interest, all qualified by the same useful
  // judgments and all matching the same items. An uncapped per-interest
  // boost would stack three steps onto one item and reverse an explicit
  // not_useful penalty's net effect.
  const clones = [2, 3, 4].map((version) => ({
    ...corpus.profiles[0]!,
    id: `synthetic-robotics-clone-${version}`,
    version,
  }));
  const multi: EvaluationCorpus = {
    ...corpus,
    profiles: [...corpus.profiles, ...clones],
  };
  expect(multi.profiles).toHaveLength(4);
  const report = evaluateInterestAdaptation(multi, history);
  const boost = report.arms.find(
    (arm) => arm.arm === "expiring-feedback-boost",
  )!;
  const baseline = report.arms.find((arm) => arm.arm === "baseline")!;
  // Every boost-qualified interest records its temporary boost: the original
  // plus three clones.
  expect(boost.changes.temporaryBoosts).toHaveLength(4);
  for (const baselineRow of baseline.ranking) {
    const boostRow = boost.ranking.find((row) => row.id === baselineRow.id)!;
    expect(boostRow.total).toBeGreaterThanOrEqual(baselineRow.total);
    // The cumulative per-item boost is capped at the flat useful step,
    // relative to the baseline arm's adjusted score.
    expect(boostRow.total).toBeLessThanOrEqual(
      baselineRow.total + FLAT_USEFUL_STEP,
    );
  }
  // The explicitly not_useful duplicate stays below its no-feedback standing
  // even with every clone boost live: the explicit penalty is never
  // reversed by stacking overlapping interest boosts.
  const boostRow = boost.ranking.find((row) => row.id === "atlas-duplicate")!;
  expect(boost.ranking.find((row) => row.id === "atlas-release")).toBeDefined();
  const noFeedbackTotal = baselineRowNoFeedbackTotal("atlas-duplicate");
  expect(boostRow.total).toBeLessThan(noFeedbackTotal);
});

// The baseline arm's recorded total for an item with no feedback feedback
// history, used as the standing an explicitly not_useful item must never be
// boosted above.
function baselineRowNoFeedbackTotal(id: string): number {
  const noFeedback: AdaptationHistory = {
    ...history,
    version: 99,
    events: history.events.filter((event) => event.itemId !== id),
  };
  const report = evaluateInterestAdaptation(corpus, noFeedback, {
    arms: ["baseline"],
  });
  return report.arms[0]!.ranking.find((row) => row.id === id)!.total;
}

test("expiring boosts expire by clock: an expired window restores baseline behavior", () => {
  const expired = {
    ...history,
    version: 2,
    limits: { ...history.limits, boostExpiryDays: 1 },
  };
  const report = evaluateInterestAdaptation(corpus, expired);
  const boost = report.arms.find(
    (arm) => arm.arm === "expiring-feedback-boost",
  )!;
  expect(boost.changes.temporaryBoosts).toEqual([]);
  const baseline = report.arms.find((arm) => arm.arm === "baseline")!;
  expect(boost.ranking.map((row) => [row.id, row.total])).toEqual(
    baseline.ranking.map((row) => [row.id, row.total]),
  );
  // Outside the boost window, useful judgments do not count towards the
  // temporary-interest threshold either.
  const narrow = {
    ...history,
    version: 3,
    limits: { ...history.limits, boostWindowDays: 1 },
  };
  const narrowReport = evaluateInterestAdaptation(corpus, narrow);
  expect(
    narrowReport.arms.find((arm) => arm.arm === "expiring-feedback-boost")!
      .changes.temporaryBoosts,
  ).toEqual([]);
  // With no boost, the boost arm is the baseline arm exactly.
  expect(narrowReport.arms[2]!.ranking).toEqual(narrowReport.arms[0]!.ranking);
});

test("widening only adds terms derived from explicitly useful items and never removes explicit terms", () => {
  const report = evaluateInterestAdaptation(corpus, history);
  const widening = report.arms.find(
    (arm) => arm.arm === "adjacent-term-widening",
  )!;
  expect(widening.changes.addedInterestTerms).toEqual([
    { interestId: "synthetic-robotics", terms: ["model", "acme", "atlas"] },
  ]);
  // Fashion can never become eligible: its text shares no supported term.
  expect(widening.excluded.map((row) => row.id)).toContain("fashion");
  expect(latestFeedbackFor(history.events, "fashion")).toBeNull();
  // On this fixture the derived terms widen nothing: every item they match
  // was already matched by the original explicit terms, so the eligibility
  // set is identical to baseline while within-interest ordering changes.
  const baseline = report.arms.find((arm) => arm.arm === "baseline")!;
  const eligibleOf = (arm: (typeof report.arms)[number]) =>
    [...arm.ranking, ...arm.excluded]
      .filter((row) => row.eligible)
      .map((row) => row.id)
      .sort();
  expect(eligibleOf(widening)).toEqual(eligibleOf(baseline));
});

test("disable/reset: running the baseline arm alone reproduces the exact baseline behavior", () => {
  const full = evaluateInterestAdaptation(corpus, history);
  const disabled = evaluateInterestAdaptation(corpus, history, {
    arms: ["baseline"],
  });
  expect(disabled.config.arms).toEqual(["baseline"]);
  expect(disabled.arms).toEqual(
    full.arms.filter((arm) => arm.arm === "baseline"),
  );
  // No persisted adaptation state exists: the disabled run carries the
  // baseline summary only, with the candidate arms' explainable changes gone.
  expect(disabled.arms).toHaveLength(1);
  expect(disabled.arms[0]!.arm).toBe("baseline");
});

test("future feedback and unknown items are rejected instead of leaking into the replay", () => {
  const future = {
    ...history,
    events: [
      ...history.events,
      {
        itemId: "atlas-release",
        useful: true,
        at: corpus.asOf + 1,
        source: "mcp" as const,
      },
    ],
  };
  expect(() => evaluateInterestAdaptation(corpus, future)).toThrow(
    /newer than the replay instant/,
  );
  const unknown = {
    ...history,
    events: [
      ...history.events,
      {
        itemId: "ghost",
        useful: true,
        at: corpus.asOf - 1,
        source: "mcp" as const,
      },
    ],
  };
  expect(() => evaluateInterestAdaptation(corpus, unknown)).toThrow(
    /unknown item id/,
  );
  expect(() =>
    evaluateInterestAdaptation(corpus, { ...history, corpusId: "other" }),
  ).toThrow(/targets corpus/);
  expect(() =>
    evaluateInterestAdaptation(corpus, history, { arms: [] }),
  ).toThrow(/baseline/i);
});

test("baseline arm scores equal the shipped deterministic-v3 scoring with recorded feedback", async () => {
  const { scoreItem } = await import("../src/scoring");
  const report = evaluateInterestAdaptation(corpus, history, {
    arms: ["baseline"],
  });
  const active = corpus.profiles.filter(
    (p) => p.lifetime === "persistent" || p.expiresAt! > corpus.asOf,
  );
  const rows = [...report.arms[0]!.ranking, ...report.arms[0]!.excluded];
  for (const row of rows) {
    const item = corpus.items.find((entry) => entry.id === row.id)!;
    const scored = scoreItem({
      itemId: item.id,
      title: item.title,
      text: item.text,
      publishedAt: item.publishedAt,
      now: corpus.asOf,
      interests: active,
      analysis: item.analysis,
      history: null,
      feedback: latestFeedbackFor(history.events, item.id),
    });
    expect(row.total).toBe(scored.total);
    expect(row.criteriaVersion).toBe(scored.criteriaVersion);
    expect(row.eligible).toBe(scored.eligible);
  }
});

test("CLI replay uses neither database nor configured provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-adapt-"));
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return new Response("unexpected", { status: 500 });
    },
  });
  try {
    const db = join(dir, "must-not-exist.sqlite");
    const proc = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "evaluate-interest-adaptation",
        "tests/fixtures/evaluation-corpus-v1.json",
        "tests/fixtures/interest-adaptation-history-v1.json",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DB_PATH: db,
          ANALYSIS_ENDPOINT: `http://127.0.0.1:${server.port}/`,
          ANALYSIS_KEY: "invalid-test-key",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const report = JSON.parse(stdout) as InterestAdaptationReport;
    expect(report.usage.providerCalls).toBe(0);
    expect(existsSync(db)).toBe(false);
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
