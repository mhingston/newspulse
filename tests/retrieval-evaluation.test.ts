import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { parseFeed } from "../src/adapters/rss";
import {
  buildQueryMatch,
  searchTerms,
  SEARCH_MATCH_VERSION,
} from "../src/search-matching";
import corpusJson from "./fixtures/retrieval-gap-corpus-v1.json";
import queriesJson from "./fixtures/retrieval-gap-queries-v1.json";
import {
  MATCH_STRATEGIES,
  evaluateRetrievalGaps,
  retrievalCorpusSchema,
  retrievalQueriesSchema,
  type RetrievalSolver,
  type FilterModes,
} from "../src/retrieval-evaluation";
import {
  createRetrievalFtsDatabase,
  measureIndexFootprint,
} from "../src/retrieval-fts";

const corpus = retrievalCorpusSchema.parse(corpusJson);
const queries = retrievalQueriesSchema.parse(queriesJson);

function runReport(): ReturnType<typeof evaluateRetrievalGaps> {
  const fts = createRetrievalFtsDatabase(corpus);
  try {
    return evaluateRetrievalGaps(
      corpus,
      queries,
      (strategyId): RetrievalSolver =>
        (match, filters, k) =>
          fts.search(match, filters, k),
      null,
    );
  } finally {
    fts.db.close();
  }
}

const byCandidate = (
  report: ReturnType<typeof evaluateRetrievalGaps>,
  strategyId: string,
  filters: "none" | "recorded" = "none",
) =>
  report.candidates.find(
    (candidate) =>
      candidate.strategyId === strategyId && candidate.filters === filters,
  )!;

const queryOf = (
  candidate: ReturnType<typeof evaluateRetrievalGaps>["candidates"][number],
  queryId: string,
) => candidate.perQuery.find((row) => row.queryId === queryId)!;

test("recorded fixtures carry known positives and production-shaped negatives", () => {
  const byId = new Map(corpus.items.map((item) => [item.id, item]));
  for (const query of queries.queries) {
    expect(query.relevantIds.length).toBeGreaterThan(0);
    for (const id of query.relevantIds) expect(byId.has(id)).toBe(true);
  }
  // Known negatives: every corpus item not labeling a query as relevant can
  // be retrieved by an expanded strategy, so precision is not vacuous.
  const negative = byId.get("fashion-drop")!;
  expect(negative.unavailable).toBe(false);
});

test("retrieval replay is fully deterministic", () => {
  expect(runReport()).toEqual(runReport());
});

test("the unchanged baseline shows measured gaps, not anecdotes", () => {
  const report = runReport();
  const baseline = byCandidate(report, "and-quoted", "none");
  // 5 of 13 labeled positives reached at k=5.
  expect(baseline.recallAtK).toEqual({
    numerator: 5,
    denominator: 13,
    value: 5 / 13,
    unknown: 0,
  });
  expect(baseline.precisionAtK).toEqual({
    numerator: 5,
    denominator: 8,
    value: 5 / 8,
    unknown: 4,
  });
  expect(baseline.zeroResultQueryIds).toEqual([
    "q-vocab-llm",
    "q-vocab-quant",
    "q-vocab-sbom",
    "q-unavailable-litigation",
  ]);
  expect(baseline.fullRecallQueryIds).toEqual([
    "q-direct-robotics",
    "q-atlas-window",
  ]);
  // Historical and connection lookups each lose one of two positives.
  expect(queryOf(baseline, "q-history-atlas").relevantRetrieved).toBe(1);
  expect(queryOf(baseline, "q-connect-scaling").relevantRetrieved).toBe(1);
});

test("vocabulary mismatch is measurable and expansion candidates behave differently", () => {
  const report = runReport();
  for (const queryId of ["q-vocab-llm", "q-vocab-quant", "q-vocab-sbom"]) {
    expect(
      queryOf(byCandidate(report, "and-quoted"), queryId).retrievedCount,
    ).toBe(0);
    expect(
      queryOf(byCandidate(report, "or-prefix"), queryId).recallAtK.value,
    ).toBe(1);
  }
  expect(
    queryOf(byCandidate(report, "and-group-synonyms"), "q-vocab-sbom").recallAtK
      .value,
  ).toBe(1);
  expect(
    queryOf(byCandidate(report, "and-group-synonyms"), "q-vocab-llm").recallAtK
      .value,
  ).toBe(0.5);
});

test("OR expansion buys recall for precision; AND grouping is precision-preserving", () => {
  const report = runReport();
  const baseline = byCandidate(report, "and-quoted");
  for (const strategyId of ["or-quoted", "or-prefix"]) {
    const candidate = byCandidate(report, strategyId);
    expect(candidate.recallAtK.value!).toBeGreaterThan(
      baseline.recallAtK.value!,
    );
    expect(candidate.precisionAtK.value!).toBeLessThan(
      baseline.precisionAtK.value!,
    );
  }
  const grouped = byCandidate(report, "and-prefix-group-synonyms");
  expect(grouped.recallAtK.value!).toBeGreaterThan(baseline.recallAtK.value!);
  expect(grouped.precisionAtK.value!).toBeGreaterThan(
    baseline.precisionAtK.value!,
  );
});

test("prefix morphology connects the historical development without synonyms", () => {
  const report = runReport();
  const history = queryOf(byCandidate(report, "and-prefix"), "q-history-atlas");
  expect(history.relevantRetrieved).toBe(2);
  expect(history.recallAtK.value).toBe(1);
  expect(
    queryOf(byCandidate(report, "and-quoted"), "q-history-atlas").recallAtK
      .value,
  ).toBe(0.5);
});

test("recorded metadata filters improve precision without schema or index changes", () => {
  const report = runReport();
  // Without filters the paper query also matches blog results.
  const withoutFilters = queryOf(
    byCandidate(report, "and-quoted", "none"),
    "q-papers-protocols",
  );
  expect(withoutFilters.precisionAtK.value).toBe(0.5);
  const withFilters = queryOf(
    byCandidate(report, "and-quoted", "recorded"),
    "q-papers-protocols",
  );
  expect(withFilters.retrievedCount).toBe(1);
  expect(withFilters.precisionAtK.value).toBe(1);
  const filteredReports = report.candidates.filter(
    (candidate) => candidate.filters === "recorded",
  );
  for (const candidate of filteredReports) {
    expect(candidate.precisionAtK.value!).toBeGreaterThan(
      byCandidate(report, candidate.strategyId, "none").precisionAtK.value!,
    );
    expect(candidate.recallAtK).toEqual(
      byCandidate(report, candidate.strategyId, "none").recallAtK,
    );
  }
});

test("unavailable content is a categorical keyword-retrieval gap", () => {
  const report = runReport();
  for (const candidate of report.candidates) {
    const row = queryOf(candidate, "q-unavailable-litigation");
    expect(row.retrievedCount).toBe(0);
    expect(row.recallAtK.value).toBe(0);
    expect(row.precisionAtK).toEqual({
      numerator: 0,
      denominator: 0,
      value: null,
      unknown: 1,
    });
  }
  expect(report.unavailableContentGaps.queryIds).toEqual([
    "q-unavailable-litigation",
  ]);
});

test("index footprint reports real FTS5 overhead and no vector store", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrieval-footprint-"));
  try {
    const footprint = measureIndexFootprint(corpus, dir);
    expect(footprint.ftsOverheadBytes).toBeGreaterThan(0);
    expect(footprint.ftsBytes).toBe(45056);
    expect(footprint.itemsOnlyBytes).toBe(20480);
    const second = measureIndexFootprint(
      corpus,
      mkdtempSync(join(dir, "again-")),
    );
    expect(second).toEqual(footprint);
    const report = runReport();
    expect(report.config.matchFlavor).toBe("fts5");
    for (const strategyId of report.config.strategyIds)
      expect(
        strategyId.includes("vector") || strategyId.includes("embedding"),
      ).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleted content stops matching while canonical metadata survives; restart persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrieval-restart-"));
  try {
    const path = join(dir, "retrieval.sqlite");
    const before = createRetrievalFtsDatabase(corpus, { path });
    const match = MATCH_STRATEGIES["and-quoted"]!.build(
      queries.queries[0]!.query.match(/[\p{L}\p{N}_]+/gu) ?? [],
    );
    expect(before.search(match, undefined, 5)).toContain(
      "robot-benchmark-suite",
    );
    before.db.close();
    // Restart: reopening the persisted index must reproduce the same results
    // without re-running initialization.
    const reopened = createRetrievalFtsDatabase(
      corpus,
      { path },
      { create: false },
    );
    const fresh = createRetrievalFtsDatabase(corpus);
    expect(reopened.search(match, undefined, 5)).toEqual(
      fresh.search(match, undefined, 5),
    );
    fresh.db.close();
    expect(reopened.countRows()).toBe(corpus.items.length);
    // Deleting the derived index row must not lose canonical metadata...
    reopened.deleteItem("robot-benchmark-suite");
    expect(reopened.search(match, undefined, 5)).not.toContain(
      "robot-benchmark-suite",
    );
    expect(
      reopened.db
        .query(`SELECT id, published_at FROM retrieval_items WHERE id = ?`)
        .get("robot-benchmark-suite"),
    ).toEqual({ id: "robot-benchmark-suite", published_at: 1793960000000 });
    reopened.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filter candidate modes are honored and validated", () => {
  const fts = createRetrievalFtsDatabase(corpus);
  try {
    const modes: FilterModes = ["none"];
    const report = evaluateRetrievalGaps(
      corpus,
      queries,
      (strategyId): RetrievalSolver =>
        (match, filters, k) =>
          fts.search(match, filters, k),
      null,
      { candidateFilterModes: modes },
    );
    expect(
      report.candidates.every((candidate) => candidate.filters === "none"),
    ).toBe(true);
  } finally {
    fts.db.close();
  }
});

test("labels are validated: unknown relevant ids and scenario mismatches fail", () => {
  const fts = createRetrievalFtsDatabase(corpus);
  try {
    expect(() =>
      evaluateRetrievalGaps(
        corpus,
        {
          ...queries,
          queries: [
            {
              id: "bad",
              scenario: "control",
              query: "x",
              relevantIds: ["missing-item"],
            },
          ],
        },
        () => (match, filters, k) => fts.search(match, filters, k),
        null,
      ),
    ).toThrow("unknown relevant id");
    expect(() =>
      evaluateRetrievalGaps(
        corpus,
        {
          ...queries,
          queries: [
            {
              id: "bad-unavailable",
              scenario: "unavailable-content",
              query: "robotics",
              relevantIds: ["robot-benchmark-suite"],
            },
          ],
        },
        () => (match, filters, k) => fts.search(match, filters, k),
        null,
      ),
    ).toThrow("must reference an unavailable item");
  } finally {
    fts.db.close();
  }
});

test("production search adopts the measured match construction, not a drift", () => {
  const sample = searchTerms("SBOM dependency provenance");
  expect(buildQueryMatch(sample)).toBe(
    MATCH_STRATEGIES["and-prefix-group-synonyms"]!.build(sample),
  );
  const store = new Store(":memory:");
  try {
    const source = store.addSource("https://example.com/feed");
    store.enqueueDue(100);
    const job = store.claim(100)!;
    const parsed = parseFeed(
      `<rss version="2.0"><channel><title>Engineering</title><item><guid>llm-1</guid><title>Language model evaluation protocols</title><link>https://example.com/llm-1</link><description><![CDATA[Reproducible evaluation protocols for large language model agents.]]></description></item><item><guid>robot-1</guid><title>Recalls of robot controllers</title><link>https://example.com/robot-1</link><description><![CDATA[Advisories and recalls for robot controllers.]]></description></item></channel></rss>`,
      source.url,
    );
    store.complete(job, { items: parsed }, 101);
    // The recorded vocabulary-mismatch query finds the expanded terminology.
    expect(store.search("LLM evaluation")).toHaveLength(1);
    // Prefix morphology connects recall to recalls without OR-ing away terms.
    expect(store.search("recall")).toHaveLength(1);
    // Required vocabulary is preserved: AND semantics stay exact.
    expect(store.search("LLM nonexistentterm")).toHaveLength(0);
    expect(store.search("evaluation protocols")).toHaveLength(1);
  } finally {
    store.sqlite.close();
  }
});

test("checked-in retrieval baseline matches a fresh deterministic replay", async () => {
  const baseline = await Bun.file(
    "docs/baselines/retrieval-gap-v1.json",
  ).json();
  const dir = mkdtempSync(join(tmpdir(), "retrieval-baseline-"));
  try {
    const fts = createRetrievalFtsDatabase(corpus);
    const report = evaluateRetrievalGaps(
      corpus,
      queries,
      (): RetrievalSolver => (match, filters, k) =>
        fts.search(match, filters, k),
      measureIndexFootprint(corpus, dir),
    );
    fts.db.close();
    expect(report).toEqual(baseline);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI replay is offline, deterministic and emits timing only on stderr", async () => {
  const command = [
    process.execPath,
    "src/cli.ts",
    "evaluate-retrieval",
    "tests/fixtures/retrieval-gap-corpus-v1.json",
    "tests/fixtures/retrieval-gap-queries-v1.json",
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
  const report = JSON.parse(plainOutput);
  expect(report.latencyMs).toBeNull();
  expect(report.usage).toEqual({ providerCalls: 0, cost: null });
  expect(report.index).not.toBeNull();
  expect(JSON.parse(timing)).toMatchObject({
    scope: "offline in-process FTS replay",
    deterministic: false,
  });
});

test("CLI retrieval replay touches neither DB_PATH nor the network", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrieval-eval-"));
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
        "evaluate-retrieval",
        "tests/fixtures/retrieval-gap-corpus-v1.json",
        "tests/fixtures/retrieval-gap-queries-v1.json",
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
