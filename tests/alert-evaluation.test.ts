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

test("the recorded baseline shows the measured cadence gap", () => {
  const report = baseline;
  // Baseline capability: the shipped daily digest only delivers at the
  // scheduled edition. Measured per labeled event observation (every
  // recorded changed-facts update of an alert_update item included): only
  // the dst-1 event (12h horizon) makes the next edition in time.
  expect(report.baseline.metrics.timeSensitiveWithinHorizon).toEqual({
    numerator: 1,
    denominator: 4,
    value: 0.25,
  });
  expect(report.baseline.metrics.missedTimeSensitive).toEqual([
    "incident-1",
    "quake#1",
    "quake#2",
  ]);
  // The baseline sends no alerts by construction.
  expect(report.baseline.metrics.alertVolume.value).toBeNull();
});

test("every labeled update is evaluated and classified individually", () => {
  const report = baseline;
  const quakeUpdates = report.candidate.perEvent.filter((outcome) =>
    outcome.eventLabel.startsWith("quake#"),
  );
  // Both recorded changed-facts updates of the quake development are
  // measured, not only the first.
  expect(quakeUpdates.map((outcome) => outcome.eventLabel)).toEqual([
    "quake#1",
    "quake#2",
  ]);
  expect(quakeUpdates.every((outcome) => outcome.alertworthyEvent)).toBe(true);
  // quake#1 delivered in 0.5h; quake#2 (observed inside quiet hours) was
  // scheduled for the quiet end, 7.5h after its observation — beyond the
  // recorded 6h horizon and therefore a recorded miss.
  expect(quakeUpdates[0]!.candidate.latencyHours).toBe(0.5);
  expect(quakeUpdates[0]!.candidate.missed).toBe(false);
  expect(quakeUpdates[1]!.candidate.latencyHours).toBe(7.5);
  expect(quakeUpdates[1]!.candidate.missed).toBe(true);
  expect(quakeUpdates[1]!.candidate.quietUntil).toBe(
    quakeUpdates[1]!.candidate.deliveredAt,
  );
});

test("the corrected evaluation records non-adoption under the fixed threshold", () => {
  const report = baseline;
  // 3 of 4 labeled alert-worthy event observations delivered in horizon.
  expect(report.candidate.metrics.timeSensitiveWithinHorizon).toEqual({
    numerator: 3,
    denominator: 4,
    value: 0.75,
  });
  expect(report.candidate.metrics.missedTimeSensitive).toEqual(["quake#2"]);
  // No false positives on labeled repeat coverage or slow news, and alert
  // volume stayed within the labeled alert-worthy event count.
  expect(report.candidate.metrics.falseAlerts).toEqual([]);
  expect(report.candidate.metrics.alertVolume).toBe(4);
  expect(report.candidate.metrics.suppressionVolume).toBe(6);
  // The corpus labels 6 candidate evaluations that stay silent, one reason
  // each: quake seed + evergreen below priority; atlas not interest-eligible;
  // repeat-1 repeat coverage; two non-alertable change kinds.
  expect(report.candidate.suppressionCounts).toEqual({
    below_priority_threshold: 2,
    not_interest_eligible: 1,
    repeat_coverage: 1,
    not_alertable_kind: 2,
  });
  // The replay reads recorded evidence only.
  expect(report.usage.providerCalls).toBe(0);
  expect(report.usage.cost).toBeNull();
  // The code-fixed threshold is honestly not met at the recorded settings.
  expect(report.adoption.adopted).toBe(false);
  expect(report.adoption.threshold).toContain("measured cadence gap");
  expect(report.adoption.reason).toBe(
    "the alert candidate still missed quake#2",
  );
});

test("replaying twice in one process yields identical reports", () => {
  const first = JSON.stringify(evaluateAlerts(corpusInput));
  const second = JSON.stringify(evaluateAlerts(corpusInput));
  expect(second).toBe(first);
});
