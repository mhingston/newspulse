import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import corpusJson from "./fixtures/evaluation-corpus-v1.json";
import {
  corpusSchema,
  compareEvaluations,
  evaluateCorpus,
  measureRanking,
} from "../src/evaluation";

const corpus = corpusSchema.parse(corpusJson);

test("synthetic replay is deterministic and keeps unknown evidence explicit", () => {
  const first = evaluateCorpus(corpus, { k: 5 });
  expect(evaluateCorpus(corpus, { k: 5 })).toEqual(first);
  expect(first.config).toMatchObject({
    criteriaVersion: "deterministic-v2",
    groupingVersion: "specific-development-v1",
    profiles: [{ id: "synthetic-robotics", version: 1 }],
    models: [],
  });
  expect(first.metrics.precisionAtK).toEqual({
    numerator: 4,
    denominator: 4,
    value: 1,
    unknown: 1,
  });
  expect(first.metrics.duplicateRate).toMatchObject({
    numerator: 1,
    denominator: 5,
  });
  expect(first.metrics.importantRecall).toMatchObject({
    numerator: 3,
    denominator: 3,
    unknown: 1,
  });
  expect(first.usage).toMatchObject({
    providerCalls: 0,
    cost: null,
    costPerUsefulDiscovery: {
      value: null,
      usefulDiscoveries: 3,
      unknownLabels: 1,
    },
  });
  expect(first.latencyMs).toBeNull();
  expect(first.missedImportantDevelopments).toEqual([]);
});

test("degraded ranking and grouping measurably regress the labeled corpus", () => {
  const baseline = evaluateCorpus(corpus, { k: 5 });
  const irrelevantFirst = [
    ...baseline.ranking,
    ...baseline.excluded.map((row) => ({ ...row, eligible: true })),
  ].sort((a, b) => Number(a.id !== "fashion") - Number(b.id !== "fashion"));
  const worseRanking = measureRanking(corpus, irrelevantFirst, 5);
  expect(worseRanking.precisionAtK.value!).toBeLessThan(
    baseline.metrics.precisionAtK.value!,
  );
  const mergedGroups = baseline.ranking.map((row) => ({
    ...row,
    groupId: "one-group",
  }));
  const worseGrouping = measureRanking(corpus, mergedGroups, 5);
  expect(worseGrouping.groupPairPrecision.value!).toBeLessThan(
    baseline.metrics.groupPairPrecision.value!,
  );
  const splitGroups = baseline.ranking.map((row) => ({
    ...row,
    groupId: row.id,
  }));
  expect(
    measureRanking(corpus, splitGroups, 5).groupPairRecall.value!,
  ).toBeLessThan(baseline.metrics.groupPairRecall.value!);
});

test("missing judgments and empty denominators never appear as zero quality", () => {
  const unjudged = measureRanking(
    corpus,
    [{ id: "unknown-label", groupId: "unknown" }],
    1,
  );
  expect(unjudged.precisionAtK).toEqual({
    numerator: 0,
    denominator: 0,
    value: null,
    unknown: 1,
  });
  expect(unjudged.outsideSubscriptionRelevance.value).toBeNull();
  expect(unjudged.importantRecall.unknown).toBe(1);
  expect(unjudged.missedImportantDevelopments).toEqual([
    "atlas-2-recall",
    "atlas-2-release",
    "orion-3-release",
  ]);
  expect(() =>
    measureRanking(corpus, [{ id: "missing", groupId: "x" }], 1),
  ).toThrow();
  expect(() => evaluateCorpus(corpus, { k: 0 })).toThrow();
});

test("comparison gates fail closed on unknowns and show item changes", () => {
  const baseline = evaluateCorpus(corpus, { k: 5 });
  const insufficient = compareEvaluations(baseline, baseline, [
    { metric: "precisionAtK", min: 1 },
  ]);
  expect(insufficient.checks[0]).toMatchObject({
    value: 1,
    unknown: 1,
    passed: false,
  });
  expect(insufficient.passed).toBe(false);
  expect(compareEvaluations(baseline, baseline).passed).toBeNull();
  const changed = structuredClone(baseline);
  const moved = changed.ranking.shift()!;
  changed.ranking.push({ ...moved, groupId: "changed-group" });
  const comparison = compareEvaluations(baseline, changed);
  expect(comparison.metrics.precisionAtK).toEqual({
    baseline: baseline.metrics.precisionAtK,
    current: changed.metrics.precisionAtK,
    delta: 0,
  });
  expect(comparison.itemChanges).toContainEqual({
    id: moved.id,
    baseline: { rank: 1, groupId: moved.groupId, eligible: true },
    current: {
      rank: changed.ranking.length,
      groupId: "changed-group",
      eligible: true,
    },
  });
  const excluded = structuredClone(baseline);
  const item = excluded.ranking.shift()!;
  excluded.excluded.push({ ...item, eligible: false });
  expect(compareEvaluations(baseline, excluded).itemChanges).toContainEqual({
    id: item.id,
    baseline: { rank: 1, groupId: item.groupId, eligible: true },
    current: { rank: null, groupId: item.groupId, eligible: false },
  });
  expect(() =>
    compareEvaluations(baseline, {
      ...changed,
      corpus: { ...changed.corpus, hash: "different" },
    }),
  ).toThrow();
});

test("recorded analyses require and expose provider and model provenance", () => {
  const withAnalysis = structuredClone(corpus);
  withAnalysis.items[0]!.analysis = {
    provider: "recorded",
    model: "synthetic-model",
    promptVersion: "test-v1",
    claims: [],
    uncertainty: [],
  };
  expect(evaluateCorpus(withAnalysis, { k: 5 }).config.models).toEqual([
    {
      provider: "recorded",
      model: "synthetic-model",
      promptVersion: "test-v1",
    },
  ]);
  const missingVersion = structuredClone(withAnalysis) as unknown as {
    items: { analysis: unknown }[];
  };
  missingVersion.items[0]!.analysis = { claims: [], uncertainty: [] };
  expect(() => evaluateCorpus(missingVersion, { k: 5 })).toThrow();
});

test("new corpus versions replay separately and limits bound work", () => {
  const first = evaluateCorpus(corpus, { k: 5 });
  const revised = structuredClone(corpus);
  revised.version = 2;
  revised.items[0]!.relevance = "irrelevant";
  const next = evaluateCorpus(revised, { k: 5 });
  expect(next.corpus.version).toBe(2);
  expect(next.corpus.hash).not.toBe(first.corpus.hash);
  expect(() => compareEvaluations(first, next)).toThrow();
  expect(() =>
    evaluateCorpus(
      {
        ...corpus,
        items: Array.from({ length: 501 }, (_, index) => ({
          ...corpus.items[0]!,
          id: `item-${index}`,
        })),
      },
      { k: 5 },
    ),
  ).toThrow();
});

test("optional timing stays on stderr and preserves deterministic JSON", async () => {
  const command = [
    process.execPath,
    "src/cli.ts",
    "evaluate",
    "tests/fixtures/evaluation-corpus-v1.json",
    "5",
  ];
  const plain = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const timed = Bun.spawn([...command, "--timing"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [plainOutput, timedOutput, timing, plainExit, timedExit] =
    await Promise.all([
      new Response(plain.stdout).text(),
      new Response(timed.stdout).text(),
      new Response(timed.stderr).text(),
      plain.exited,
      timed.exited,
    ]);
  expect([plainExit, timedExit]).toEqual([0, 0]);
  expect(timedOutput).toBe(plainOutput);
  expect(JSON.parse(timing)).toMatchObject({
    scope: "offline in-process replay",
    deterministic: false,
  });
});

test("CLI replay uses neither database nor configured provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-eval-"));
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
        "evaluate",
        "tests/fixtures/evaluation-corpus-v1.json",
        "5",
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
    expect(JSON.parse(stdout).usage.providerCalls).toBe(0);
    expect(existsSync(db)).toBe(false);
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checked-in baseline matches a fresh deterministic replay", async () => {
  const baseline = await Bun.file(
    "docs/baselines/synthetic-robotics-scoring-v2.json",
  ).json();
  expect(evaluateCorpus(corpus, { k: 5 })).toEqual(baseline);
});
