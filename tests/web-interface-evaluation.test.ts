import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import corpusJson from "./fixtures/web-interface-corpus-v1.json";
import {
  ADOPTION_THRESHOLD,
  WEB_INTERFACE_EVALUATION_VERSION,
  evaluateWebInterface,
  webInterfaceCorpusSchema,
  type WebInterfaceEvaluationReport,
} from "../src/web-interface-evaluation";

const corpus = webInterfaceCorpusSchema.parse(corpusJson);

async function reported(): Promise<WebInterfaceEvaluationReport> {
  return evaluateWebInterface(corpusJson);
}

async function task(
  reportPromise: Promise<WebInterfaceEvaluationReport>,
  id: string,
): Promise<WebInterfaceEvaluationReport["tasks"][number]> {
  const report = await reportPromise;
  const row = report.tasks.find((t) => t.taskId === id);
  expect(row).toBeDefined();
  return row!;
}

test("the web-interface replay is deterministic and matches the recorded baseline", async () => {
  const first = await reported();
  expect(await evaluateWebInterface(corpusJson)).toEqual(first);
  const baseline = await Bun.file(
    "docs/baselines/web-interface-v1.json",
  ).json();
  expect(first).toEqual(baseline);
});

test("the corpus validates its task data before opening a store", async () => {
  // A corpus whose interest change is not a valid interest profile, or whose
  // discovery queries collide, is a schema error, never a mid-replay crash.
  const invalid = {
    ...corpusJson,
    discovery: {
      ...corpus.discovery,
      triggerQuery: corpus.discovery.seedQuery,
    },
  };
  expect(() => webInterfaceCorpusSchema.parse(invalid)).toThrow();
  const badInterest = {
    ...corpusJson,
    interestUpdate: {
      ...(corpus.interestUpdate as Record<string, unknown>),
      priority: 9,
    },
  };
  expect(() => webInterfaceCorpusSchema.parse(badInterest)).toThrow();
});

test("the recorded decision is a justified non-adoption under the fixed threshold", async () => {
  const report = await reported();
  expect(report.evaluationVersion).toBe(WEB_INTERFACE_EVALUATION_VERSION);
  expect(report.adoption.adopt).toBe(false);
  expect(report.adoption.threshold).toBe(ADOPTION_THRESHOLD);
  // Every concrete task step is performable through a shipped surface, and
  // no step exists that only a browser session could perform.
  expect(report.gates.taskStepsWithoutShippedSurface).toBe(0);
  expect(report.gates.taskStepsCompleted).toBe(
    report.tasks.reduce((n, t) => n + t.steps.length, 0),
  );
  expect(report.gates.uncoveredSteps).toEqual([]);
  expect(report.gates.uiOnlySteps).toEqual([]);
  expect(report.gates.uiTransportOrEmailSideEffects).toBe(0);
  expect(report.gates.duplicateTransportSurface).toBe(true);
  // The shipped mutation security contract held during the replay.
  expect(report.gates.previewConfirmTokenSingleUseAndPayloadBound).toBe(true);
  expect(report.gates.discoveryLedgerRefinementRecordedFromItemFeedback).toBe(
    true,
  );
  expect(report.gates.frozenEditionImmutableUnderFeedback).toBe(true);
  // Both recorded discovery runs consumed the fixture day's budget.
  expect(report.gates.triggerBudgetConsumedOnFixtureDay).toBe(true);
  // The only provider interaction was the recorded fake; nothing else egressed.
  expect(report.gates.recordedProviderRequests).toBe(2);
});

test("the corpus requires both seed discovery results and their trigger record before opening a store", async () => {
  // The feedback task reads the second recorded seed result; a corpus with
  // fewer is rejected at the schema instead of crashing mid-replay.
  const oneResult = {
    ...corpusJson,
    discovery: {
      ...corpus.discovery,
      results: corpus.discovery.results.slice(0, 1),
    },
  };
  expect(() => webInterfaceCorpusSchema.parse(oneResult)).toThrow();
  const noTriggerResults = {
    ...corpusJson,
    discovery: { ...corpus.discovery, triggerResults: [] },
  };
  expect(() => webInterfaceCorpusSchema.parse(noTriggerResults)).toThrow();
});

test("every step's declared MCP tool exists in the registered tool contract", async () => {
  const report = await reported();
  for (const task of report.tasks)
    for (const step of task.steps) {
      if (step.mcpTool)
        expect(report.sourceSurface.mcpTools).toContain(step.mcpTool);
      if (step.cliVerb === null)
        expect(step.surfaces).not.toContain("cli-verb");
    }
});

test("each #31 scope task is answered by the shipped surface and no step needs a browser", async () => {
  const report = await reported();
  const ids = report.tasks.map((t) => t.taskId);
  // The issue's four required scope areas, one task each, plus the
  // budgeted-discovery dispatch that precedes understanding a discovery.
  expect(ids).toEqual([
    "understand-discovery-explanation",
    "run-budgeted-discovery",
    "configure-interests",
    "give-explicit-feedback",
    "review-developments-history",
  ]);
  for (const task of report.tasks) {
    expect(task.mcpClientCannotPerform).toEqual([]);
    expect(task.steps.every((step) => step.performed && step.ok)).toBe(true);
  }
  expect(
    task(reported(), "understand-discovery-explanation").then((t) => t.verdict),
  ).resolves.toBe("discovery_explanation_answered_by_mcp_reads");
  expect(
    task(reported(), "run-budgeted-discovery").then((t) => t.verdict),
  ).resolves.toBe("budgeted_discovery_dispatched_by_preview_confirm");
  expect(
    task(reported(), "configure-interests").then((t) => t.verdict),
  ).resolves.toBe("interest_configuration_by_versioned_preview_confirm");
  expect(
    task(reported(), "give-explicit-feedback").then((t) => t.verdict),
  ).resolves.toBe("explicit_feedback_recorded_with_discovery_linkage");
  expect(
    task(reported(), "review-developments-history").then((t) => t.verdict),
  ).resolves.toBe("developments_and_history_covered_by_mcp_reads");
});

test("tasks marked covered by both transports record CLI verbs too", async () => {
  const report = await reported();
  const both = report.tasks.filter((t) => t.coveredBy === "both");
  expect(both.map((t) => t.taskId)).toEqual([
    "configure-interests",
    "give-explicit-feedback",
  ]);
  for (const task of both)
    for (const step of task.steps) expect(step.cliVerb).not.toBeNull();
});

test("discovery-result provenance and frozen-edition history are MCP-only steps", async () => {
  // These steps were recorded CLI-covered in an earlier recording; review
  // corrected the measurement: the CLI discovery-runs/search verbs expose
  // neither origin provenance nor frozen editions (digest-preview drafts
  // from current state), so both steps and their tasks are MCP-only.
  const report = await reported();
  const dispatch = report.tasks.find(
    (t) => t.taskId === "run-budgeted-discovery",
  )!;
  const reviewStep = dispatch.steps.find(
    (s) => s.stepId === "see-what-was-found",
  )!;
  expect(reviewStep.cliVerb).toBeNull();
  expect(reviewStep.surfaces).toEqual(["mcp-tool"]);
  expect(dispatch.coveredBy).toBe("mcp-tool");
  const history = report.tasks.find(
    (t) => t.taskId === "review-developments-history",
  )!;
  const frozenStep = history.steps.find(
    (s) => s.stepId === "read-the-frozen-edition",
  )!;
  expect(frozenStep.cliVerb).toBeNull();
  expect(frozenStep.surfaces).toEqual(["mcp-tool"]);
  expect(history.coveredBy).toBe("mcp-tool");
});

test("payload binding is verified with a changed document on a fresh token, not just a consumed one", async () => {
  const report = await reported();
  // The single-use replay alone would hold even if payload hashing were
  // broken (used tokens reject before any hash comparison), so the recorded
  // gate additionally requires the equal/changed probes to pass.
  const interests = report.tasks.find(
    (t) => t.taskId === "configure-interests",
  )!;
  const singleUse = interests.steps.find(
    (s) => s.stepId === "token-is-single-use",
  )!;
  expect(singleUse.ok).toBe(true);
  const bound = interests.steps.find(
    (s) => s.stepId === "token-is-payload-bound",
  )!;
  expect(bound.ok).toBe(true);
  expect(bound.observed).toContain("payload_changed");
  expect(bound.observed).toContain("no profile write");
  expect(bound.observed).toContain("stayed at 2");
  expect(report.gates.previewConfirmTokenSingleUseAndPayloadBound).toBe(true);
});

test("the shipped ranking explanation exposes criteria versions and exclusions", async () => {
  const t = await task(reported(), "understand-discovery-explanation");
  const read = t.steps.find((s) => s.stepId === "read-analysis-provenance");
  expect(read!.ok).toBe(true);
  expect(read!.observed).toContain("latest_score present (true)");
  const explain = t.steps.find((s) => s.stepId === "explain-the-ranking");
  expect(explain!.observed).toContain("criteria version");
});

test("the discovery refinement ledger was written by the MCP feedback path", async () => {
  const t = await task(reported(), "give-explicit-feedback");
  const refine = t.steps.find(
    (s) => s.stepId === "refine-the-discovery-ledger",
  );
  expect(refine!.ok).toBe(true);
  expect(refine!.observed).toContain("discovery-result refinement row");
});

test("explicit not-useful edition feedback leaves frozen edition bytes identical", async () => {
  const t = await task(reported(), "review-developments-history");
  const step = t.steps.find((s) => s.stepId === "edition-survives-feedback");
  expect(step!.ok).toBe(true);
  expect(step!.observed).toContain("frozen edition bytes stayed identical");
});

test("web-interface evaluation performs no network calls: every task runs with poisoned egress", async () => {
  // Poison outbound fetch for the duration of the whole replay: ingest and
  // discovery use the recorded fake provider, and the MCP surface runs over
  // an in-memory transport pair, so a successful run proves no hidden egress.
  const poisoned = () => {
    throw new Error("network egress attempted during web-interface evaluation");
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = poisoned as unknown as typeof fetch;
  try {
    const report = await evaluateWebInterface(corpusJson);
    expect(report.gates.uiTransportOrEmailSideEffects).toBe(0);
    expect(report.gates.recordedProviderRequests).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the CLI verbs recorded for the both-covered tasks run offline end to end", () => {
  // Concrete evidence that the `cli-verb` halves of the coveredBy:"both"
  // tasks really exist in the shipped CLI: one preview/confirm round trip
  // per mutation family on a throwaway database, no network.
  const dir = mkdtempSync(join(tmpdir(), "web-interface-cli-"));
  const db = join(dir, "cli.sqlite");
  const env = { ...process.env, DB_PATH: db };
  const cli = (args: string[], extraEnv: Record<string, string> = {}) => {
    const proc = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
      env: { ...env, ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: proc.exitCode,
      out: proc.stdout.toString(),
      err: proc.stderr.toString(),
    };
  };
  try {
    mkdirSync(dir, { recursive: true });
    expect(cli(["init"]).code).toBe(0);
    // Interest preview/confirm (configure-interests task).
    const preview = cli([
      "interest-preview",
      JSON.stringify(corpus.interestUpdate),
    ]);
    expect(preview.code).toBe(0);
    const previewed = JSON.parse(preview.out) as {
      confirm_token?: string;
      interest?: { version?: number };
    };
    expect(previewed.confirm_token).toBeTruthy();
    const confirm = cli(["interest-confirm", previewed.confirm_token!]);
    expect(confirm.code).toBe(0);
    // A consumed (single-use) token must be rejected.
    const replay = cli(["interest-confirm", previewed.confirm_token!]);
    expect(replay.code).toBe(1);
    expect(replay.err).toContain("already used");
    // Feedback preview/confirm (give-explicit-feedback task): the item first
    // exists through the idempotent manual submission path.
    const submit = cli([
      "ingest-url",
      "https://journal.example/manual-web-interface",
      "manual",
      "web-interface-cli-1",
    ]);
    expect(submit.code).toBe(0);
    const submission = JSON.parse(submit.out) as { itemId?: string };
    const itemId = submission.itemId;
    expect(typeof itemId).toBe("string");
    const fbPreview = cli(["feedback-preview", itemId!, "useful"]);
    expect(fbPreview.code).toBe(0);
    const fb = JSON.parse(fbPreview.out) as { confirm_token?: string };
    expect(fb.confirm_token).toBeTruthy();
    expect(cli(["feedback-confirm", fb.confirm_token!]).code).toBe(0);
    // Discovery trigger preview: the recorded CLI verbs on the dispatch
    // steps exist and preview the bounded budget without contacting any
    // provider (the task's provenance review is MCP-only); the budget
    // settings are required configuration, so the spawn supplies them
    // explicitly.
    const trigger = cli(["discovery-trigger-preview", "humanoid robotics"], {
      DISCOVERY_DAILY_MICROS: "3000",
      DISCOVERY_RUN_MICROS: "1000",
      DISCOVERY_QUERY_MICROS: "100",
    });
    expect(trigger.code).toBe(0);
    expect(JSON.parse(trigger.out)).toHaveProperty("confirm_token");
    // The `search` verb is recorded on item-lookup steps; frozen edition and
    // discovery-provenance reads are MCP-only and assert nothing here.
    expect(cli(["search", "anything"]).code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
