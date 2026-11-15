import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  evaluateAlerts,
  type AlertEvaluationReport,
} from "../src/alert-evaluation";

/**
 * Issue #27: the recorded event-alert replay is deterministic. A fresh run
 * reproduces docs/baselines/alert-evaluation-v1.json exactly, makes no
 * provider calls, and the adoption decision is reproducible from the
 * checked-in fixture. The digest baseline and metrics below restate the
 * replay contract so a fixture or threshold change cannot pass silently.
 */

const corpusPath = "tests/fixtures/alert-evaluation-corpus-v1.json";
const baselinePath = "docs/baselines/alert-evaluation-v1.json";
const corpusInput: unknown = JSON.parse(readFileSync(corpusPath, "utf8"));
const baseline: AlertEvaluationReport = JSON.parse(
  readFileSync(baselinePath, "utf8"),
);

test("a fresh replay reproduces the recorded baseline exactly", () => {
  expect(evaluateAlerts(corpusInput)).toEqual(baseline);
});

test("the recorded baseline shows the measured cadence gap the alerts close", () => {
  const report = baseline;
  // Baseline capability: the shipped daily digest only delivers at the
  // scheduled edition, so two of the labeled time-sensitive developments
  // miss their recorded usefulness horizon.
  expect(report.baseline.metrics.timeSensitiveWithinHorizon).toEqual({
    numerator: 1,
    denominator: 3,
    value: 1 / 3,
  });
  expect(report.baseline.metrics.missedTimeSensitive).toEqual([
    "incident-1",
    "quake",
  ]);
  // The baseline sends no alerts by construction.
  expect(report.baseline.metrics.alertVolume.value).toBeNull();
});

test("the adopted candidate meets every gate fixed in code before the replay", () => {
  const report = baseline;
  // Gaps closed: every labeled alert-worthy event is delivered within its
  // horizon, nothing labeled repeat coverage or slow news alerted, alert
  // volume stays within the labeled alert-worthy event count, and the
  // replay makes zero provider calls.
  expect(report.candidate.metrics.timeSensitiveWithinHorizon.value).toBe(1);
  expect(report.candidate.metrics.missedTimeSensitive).toEqual([]);
  expect(report.candidate.metrics.falseAlerts).toEqual([]);
  expect(report.candidate.metrics.alertVolume).toBe(4);
  expect(report.candidate.metrics.suppressionVolume).toBe(6);
  expect(report.usage.providerCalls).toBe(0);
  expect(report.usage.cost).toBeNull();
  // The quiet-hours alert is scheduled after the window, never suppressed.
  const dst = report.candidate.perEvent.find(
    (event) => event.itemId === "dst-1",
  )!;
  expect(dst.candidate.quietUntil).toBe(dst.candidate.deliveredAt);
  // Suppressions record why each silent candidate stayed silent, once each.
  // The corpus labels 6 candidate evaluations that stay silent, one reason
  // each: quake seed + evergreen below priority; atlas not interest-eligible;
  // repeat-1 repeat coverage; two non-alertable change kinds.
  expect(report.candidate.suppressionCounts).toEqual({
    below_priority_threshold: 2,
    not_interest_eligible: 1,
    repeat_coverage: 1,
    not_alertable_kind: 2,
  });
  // Adopted with a recorded reproducible reason.
  expect(report.adoption.adopted).toBe(true);
  expect(report.adoption.threshold).toContain("measured cadence gap");
});

test("replaying twice in one process yields identical reports", () => {
  const first = JSON.stringify(evaluateAlerts(corpusInput));
  const second = JSON.stringify(evaluateAlerts(corpusInput));
  expect(second).toBe(first);
});
