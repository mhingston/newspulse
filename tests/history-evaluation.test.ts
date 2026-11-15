import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHistoryComparisonDatabase,
  evaluateHistoryComparisons,
  type HistoryComparisonReport,
} from "../src/history-evaluation";
import { historyComparisonCorpusSchema } from "../src/history-evaluation";

/**
 * Issue #26: the recorded history-comparison replay is deterministic. A fresh
 * run reproduces docs/baselines/history-comparisons-v1.json exactly, uses no
 * database, no network and no provider, and the adoption decision is
 * reproducible from the checked-in fixture.
 */

const corpusPath = "tests/fixtures/history-comparison-corpus-v1.json";
const baselinePath = "docs/baselines/history-comparisons-v1.json";
const corpusInput: unknown = JSON.parse(readFileSync(corpusPath, "utf8"));
const baseline: HistoryComparisonReport = JSON.parse(
  readFileSync(baselinePath, "utf8"),
);

test("a fresh replay reproduces the recorded baseline exactly", () => {
  const report = evaluateHistoryComparisons(corpusInput);
  expect(JSON.parse(JSON.stringify(report))).toEqual(
    JSON.parse(JSON.stringify(baseline)),
  );
});

test("the recorded baseline distinguishes baseline capability from gaps and meets the adoption gates", () => {
  const report = baseline;
  // Baseline: windowed keyword reads present hits, but corrections to
  // already-ingested items are invisible and no surface classifies changes.
  expect(report.arms.baseline.metrics.updateRecall).toEqual({
    numerator: 0,
    denominator: 2,
    value: 0,
  });
  expect(report.arms.baseline.metrics.presentedWithoutEvidence).toBe(2);
  expect(report.arms.baseline.metrics.expiredUpdatesRetrievable.value).toBe(0);
  // No invented chronology in either arm: the shipped reads preserve a
  // missing report date as null, and the replay preserves it with them
  // (PR 79 review finding 8) instead of attributing a fallback to the baseline.
  expect(report.arms.baseline.metrics.inventedChronology).toEqual([]);
  // Adopted: the recorded evidence read closes every measured gap.
  expect(report.arms.adopted.metrics.updateRecall.value).toBe(1);
  expect(report.arms.adopted.metrics.updateFalsePositives).toEqual([]);
  expect(report.arms.adopted.metrics.inventedChronology).toEqual([]);
  expect(report.arms.adopted.metrics.expiredUpdatesRetrievable.value).toBe(1);
  expect(report.arms.adopted.metrics.coverageRecall).toEqual(
    report.arms.baseline.metrics.coverageRecall,
  );
  expect(report.adoption.adopted).toBe(true);
  expect(report.usage.providerCalls).toBe(0);
  expect(report.usage.cost).toBeNull();
});

test("the replay records unknown report dates as unknown, never re-dated from ingestion", () => {
  const report = baseline;
  const methods = report.arms.adopted.perQuery.find(
    (query) => query.queryId === "q-atlas-methods",
  )!;
  expect(methods.events).toHaveLength(1);
  expect(methods.events[0]!.reportedAt).toBeNull();
  expect(methods.events[0]!.eventAt).toBeNull();
});

test("expired content still resolves its recorded change event with citations", () => {
  const report = baseline;
  const recall = report.arms.adopted.perQuery.find(
    (query) => query.queryId === "q-atlas-recall",
  )!;
  expect(recall.events).toHaveLength(1);
  expect(recall.events[0]!.classifiedAs).toBe("claimed_update");
  expect(recall.events[0]!.detailAvailable).toBe(false);
  expect(recall.events[0]!.reportedAt).toBe(1794780000000);
});

test("multi-week grouping places repeat coverage and rejects the broad-topic decoy", () => {
  const { store, resolve } = createHistoryComparisonDatabase(
    historyComparisonCorpusSchema.parse(corpusInput),
  );
  try {
    const atlas = resolve("atlas-2");
    const group = store.getStoryGroup(
      store.getItem(atlas)!.story.current!.group_id,
    )!;
    // The correction, its verbatim re-publication and the week-one anchor
    // share one development; the weekly industry digest does not.
    const memberIds = group.members
      .filter((member) => member.ended_at === null)
      .map((member) => member.item_id);
    expect(memberIds).toContain(atlas);
    expect(memberIds).toContain(resolve("atlas-wire"));
    expect(memberIds).not.toContain(resolve("industry-note"));
    // The undated item is its own development with an explicit null date.
    const methodsGroup = store.getItem(resolve("atlas-methods"))!.story.current!
      .group_id;
    expect(methodsGroup).not.toBe(group.id);
    expect(store.getItem(resolve("atlas-methods"))!.published_at).toBeNull();
  } finally {
    store.close();
  }
});

test("CLI replay uses neither database nor configured provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-histcmp-"));
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
        "evaluate-history-comparisons",
        corpusPath,
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
    const report = JSON.parse(stdout) as HistoryComparisonReport;
    expect(report.usage.providerCalls).toBe(0);
    expect(existsSync(db)).toBe(false);
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
