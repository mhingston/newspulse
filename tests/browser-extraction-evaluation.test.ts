import { expect, test } from "bun:test";
import corpusJson from "./fixtures/browser-extraction-corpus-v1.json";
import {
  ADOPTION_THRESHOLD,
  BROWSER_EXTRACTION_EVALUATION_VERSION,
  RecordedBrowserAdapter,
  browserExtractionCorpusSchema,
  browserRecordSchema,
  evaluateBrowserExtraction,
  type BrowserExtractionEvaluationReport,
} from "../src/browser-extraction-evaluation";

async function reported(): Promise<BrowserExtractionEvaluationReport> {
  return evaluateBrowserExtraction(corpusJson);
}

const parsedCorpus = browserExtractionCorpusSchema.parse(corpusJson);

function record(
  report: BrowserExtractionEvaluationReport,
  id: string,
): BrowserExtractionEvaluationReport["records"][number] {
  const row = report.records.find((r) => r.id === id);
  expect(row).toBeDefined();
  return row!;
}

/** A minimally-modified copy of the first fixture record for adapter tests. */
function recordWith(
  browser: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Parameters<RecordedBrowserAdapter["render"]>[1] {
  return browserRecordSchema.parse({
    ...(corpusJson as { records: Record<string, unknown>[] }).records[0]!,
    id: "adapter-probe",
    url: "https://press.example.org/adapter-probe",
    ...overrides,
    browser,
  });
}

test("the replay is deterministic and matches the recorded baseline byte for byte", async () => {
  const first = await reported();
  expect(await evaluateBrowserExtraction(corpusJson)).toEqual(first);
  const baseline = await Bun.file(
    "docs/baselines/browser-extraction-v1.json",
  ).json();
  expect(first).toEqual(baseline);
});

test("the corpus validates browser arms and Reddit identity before any store is opened", () => {
  // Two arms (render plus refusal) or none are schema errors, never a
  // mid-replay crash.
  const base = structuredClone(parsedCorpus.records[0]!);
  const bothArms = structuredClone(base);
  bothArms.browser = {
    ...base.browser,
    refusalBasis: "conflicting arm",
  };
  expect(() =>
    browserExtractionCorpusSchema.parse({
      ...corpusJson,
      records: [bothArms],
    }),
  ).toThrow("exactly one browser arm");
  // A Reddit discussion must never carry a recorded browser render: the
  // blocked response stays unavailable at the corpus schema itself.
  const redditRendered = structuredClone(
    parsedCorpus.records.find((r) => r.id === "reddit-blocked-discussion")!,
  );
  redditRendered.browser = {
    renderedBody: "<html><body><p>rendered post body</p></body></html>",
    declaredRenderMs: 10,
    declaredMemoryMb: 10,
  };
  expect(() =>
    browserExtractionCorpusSchema.parse({
      ...corpusJson,
      records: [redditRendered],
    }),
  ).toThrow("blocked response stays unavailable");
  // A permission-denied record must carry the refusal arm: a renderedBody
  // (or crash arm) behind permitted:false is rejected before the replay.
  const deniedRender = structuredClone(parsedCorpus.records[0]!);
  deniedRender.permitted = false;
  expect(() =>
    browserExtractionCorpusSchema.parse({
      ...corpusJson,
      records: [deniedRender],
    }),
  ).toThrow("browser arm is refusalBasis");
  const deniedCrash = structuredClone(parsedCorpus.records[0]!);
  deniedCrash.permitted = false;
  deniedCrash.browser = {
    crash: true,
    declaredRenderMs: 0,
    declaredMemoryMb: 0,
  };
  expect(() =>
    browserExtractionCorpusSchema.parse({
      ...corpusJson,
      records: [deniedCrash],
    }),
  ).toThrow("browser arm is refusalBasis");
});

test("the recorded decision is a justified non-adoption under the fixed threshold", async () => {
  const report = await reported();
  expect(report.evaluationVersion).toBe(BROWSER_EXTRACTION_EVALUATION_VERSION);
  expect(report.adoption).toEqual({
    adopt: false,
    threshold: ADOPTION_THRESHOLD,
  });
  // The only genuinely HTTP-inaccessible, permitted and affordable record is
  // the capability probe behind no observed deployment loss (issue #3's
  // extraction already lifts the distributions this pipeline consumes; the
  // #17 submission path covers the permitted Reddit use cases).
  expect(report.gates.recordsQualifyingOnAccessPermittedAffordability).toEqual([
    "js-only-app-report",
    "js-shell-loading-placeholder",
  ]);
  expect(report.gates.qualifyingLiftRecords).toEqual([]);
  expect(report.gates.observedDeploymentGapRecords).toEqual([
    "reddit-blocked-discussion",
  ]);
  expect(report.gates.recordsWithinBudgets).toEqual([
    "js-only-app-report",
    "js-shell-loading-placeholder",
  ]);
  expect(report.gates.recordsHttpInaccessible).toEqual([
    "js-only-app-report",
    "reddit-blocked-discussion",
    "captcha-interstitial-page",
    "js-shell-loading-placeholder",
  ]);
  expect(report.gates.partialHttpCoverageRecords).toEqual([
    "js-shell-loading-placeholder",
  ]);
  expect(report.gates.httpBaselineExtracted).toBe(2);
  expect(report.gates.httpBaselineUnavailable).toBe(3);
  expect(report.gates.browserArmAttempts).toBe(4);
  expect(report.gates.browserRendersPerformed).toBe(2);
  expect(report.gates.browserRefusals).toBe(2);
  expect(report.gates.browserUnavailableOutcomes).toBe(0);
  // The daily-budget gate is derived from the adapter's daily-budget state,
  // not a constant; with ten daily renders, two are used and none refused.
  expect(report.gates.dailyRenderBudgetExhausted).toBe(false);
  expect(report.gates.dailyRendersUsed).toBe(2);
  // The decision is derived from the gates, never a literal.
  expect(report.adoption.adopt).toBe(
    report.gates.qualifyingLiftRecords.length > 0,
  );
  expect(report.adoption.adopt).toBe(false);
  // Every non-qualifying record carries its recorded rejection reason.
  expect(Object.keys(report.gates.recordedRejectionReasons).sort()).toEqual([
    "captcha-interstitial-page",
    "js-only-app-report",
    "js-shell-loading-placeholder",
    "reddit-blocked-discussion",
    "static-press-article",
  ]);
  // No new trust boundary or browser dependency entered the core; the costs
  // adoption would have paid are recorded, not paid.
  expect(report.gates.coreIngestionBrowserDependentRequirements).toBe(0);
  expect(report.gates.newTrustBoundariesAdoptionWouldCreate.length).toBe(3);
  expect(report.gates.liveBrowserUsedInReplay).toBe(false);
});

test("a blocked Reddit response stays unavailable and no circumvention attempt is recorded", async () => {
  const report = await reported();
  const blocked = record(report, "reddit-blocked-discussion");
  expect(blocked.http.status).toBe("unavailable");
  expect(blocked.http.reason).toBe("HTTP 403");
  expect(blocked.http.textChars).toBe(0);
  // The browser arm refused on the recorded permission basis: no render is
  // measured, recorded or attempted, and no text was produced.
  expect(blocked.browser.outcome).toBe("refused");
  expect(blocked.browser.textChars).toBeNull();
  expect(blocked.browser.renderedMs).toBeNull();
  expect(blocked.browser.memoryMb).toBeNull();
  expect(blocked.browser.provenance).toBeNull();
  expect(blocked.browser.reason).toContain("anti-abuse");
  expect(blocked.browser.reason).toContain("circumvent");
  expect(blocked.browserLift).toBe(0);
  expect(report.gates.blockedRedditResponseStaysUnavailable).toBe(true);
  expect(report.gates.circumventionAttempts).toBe(0);
  // The submission path preserved provenance and merged identity by post ID.
  expect(report.gates.redditSubmissionProvenancePreserved).toBe(true);
  expect(blocked.canonicalUrl).toBe("https://www.reddit.com/comments/1hxyq2z");
  // The anti-abuse interstitial never produced browser text either.
  const interstitial = record(report, "captcha-interstitial-page");
  expect(interstitial.browser.outcome).toBe("refused");
  expect(interstitial.browser.textChars).toBeNull();
  expect(interstitial.browser.provenance).toBeNull();
});

test("the replay performs no live work: it completes with poisoned fetch, no browser launch and no egress", async () => {
  const poisoned = () => {
    throw new Error(
      "network egress attempted during browser-extraction evaluation",
    );
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = poisoned as unknown as typeof fetch;
  try {
    const report = await reported();
    expect(report.gates.liveBrowserUsedInReplay).toBe(false);
    expect(report.gates.liveProviderOrNetworkEgress).toBe(0);
    expect(report.gates.liveMeasurement.status).toBe("recorded-out-of-band");
    expect(report.gates.coreIngestionBrowserDependentRequirements).toBe(0);
    expect(report.gates.browserArmAttempts).toBe(4);
    expect(report.gates.browserRendersPerformed).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the simulated browser arm records rendered text sandboxed, secret-free and provenance-preserving", async () => {
  const report = await reported();
  const renderedRecord = record(report, "js-only-app-report");
  expect(renderedRecord.browser.outcome).toBe("rendered");
  expect(renderedRecord.browser.sandboxed).toBe(true);
  expect(renderedRecord.browser.secretFree).toBe(true);
  expect(renderedRecord.browser.textChars).toBe(
    renderedRecord.browserLift + renderedRecord.http.textChars,
  );
  expect(renderedRecord.browser.renderedMs).toBe(4200);
  expect(renderedRecord.browser.memoryMb).toBe(512);
  expect(renderedRecord.browser.provenance).toContain(
    "browser-simulated recorded render",
  );
  expect(renderedRecord.browser.provenance).toContain(
    "separable from http-method extraction",
  );
  // The HTTP baseline outcome stays recorded as its own http-method arm and
  // is never merged with the browser render.
  expect(renderedRecord.http.method).toBe("http");
  expect(renderedRecord.http.reason).toBe("Page unavailable");
  expect(renderedRecord.http.textChars).toBe(0);
  expect(renderedRecord.affordabilityReason).toContain(
    "Rendered within the recorded budgets",
  );
});

test("the simulated adapter refuses private destinations before any render", async () => {
  const adapter = new RecordedBrowserAdapter({
    perRenderTimeoutMs: 1000,
    perRenderMemoryMb: 128,
    maxConcurrentRenders: 1,
    maxRendersPerDay: 2,
  });
  const result = await adapter.render(
    "http://10.1.2.3/a",
    recordWith({
      renderedBody: "<html><body><p>x</p></body></html>",
      declaredRenderMs: 1,
      declaredMemoryMb: 1,
    }),
  );
  expect(result.kind).toBe("refused");
  expect((result as { reason: string }).reason).toContain(
    "Destination validation refused the render",
  );
  expect(adapter.destinationRefusals).toBe(1);
  expect(adapter.rendersUsed).toBe(0);
});

test("the simulated adapter refuses restricted renders before budgets and isolates crashes", async () => {
  const adapter = new RecordedBrowserAdapter({
    perRenderTimeoutMs: 1000,
    perRenderMemoryMb: 128,
    maxConcurrentRenders: 1,
    maxRendersPerDay: 2,
  });
  const restricted = recordWith({
    refusalBasis: "Refused: anti-abuse control; rendering would circumvent it",
    declaredRenderMs: 0,
    declaredMemoryMb: 0,
  });
  const refused = await adapter.render(
    "https://press.example.org/adapter-probe",
    restricted,
  );
  expect(refused).toEqual({
    kind: "refused",
    reason: "Refused: anti-abuse control; rendering would circumvent it",
  });
  expect(adapter.permissionRefusals).toBe(1);
  expect(adapter.rendersUsed).toBe(0);

  const crashing = recordWith({
    crash: true,
    declaredRenderMs: 0,
    declaredMemoryMb: 0,
  });
  await expect(
    adapter.render("https://press.example.org/adapter-probe", crashing),
  ).resolves.toMatchObject({ kind: "unavailable" });
  expect(adapter.crashesIsolated).toBe(1);
  expect(adapter.rendersUsed).toBe(0);
});

test("the simulated adapter enforces per-render timeout, memory, daily and concurrency budgets", async () => {
  const adapter = new RecordedBrowserAdapter({
    perRenderTimeoutMs: 1000,
    perRenderMemoryMb: 128,
    maxConcurrentRenders: 1,
    maxRendersPerDay: 2,
  });
  const slow = recordWith({
    renderedBody: "<html><body><p>x</p></body></html>",
    declaredRenderMs: 1500,
    declaredMemoryMb: 64,
  });
  const timeoutResult = await adapter.render(
    "https://press.example.org/adapter-probe",
    slow,
  );
  expect(timeoutResult.kind).toBe("refused");
  expect((timeoutResult as { reason: string }).reason).toContain(
    "timeout budget exceeded",
  );
  const heavy = recordWith({
    renderedBody: "<html><body><p>x</p></body></html>",
    declaredRenderMs: 500,
    declaredMemoryMb: 256,
  });
  const memoryResult = await adapter.render(
    "https://press.example.org/adapter-probe",
    heavy,
  );
  expect(memoryResult.kind).toBe("refused");
  expect((memoryResult as { reason: string }).reason).toContain(
    "memory budget exceeded",
  );
  // Two daily renders fit; the third is refused on the daily budget, and
  // rejected attempts do not consume render budget.
  const small = recordWith({
    renderedBody: "<html><body><p>x</p></body></html>",
    declaredRenderMs: 500,
    declaredMemoryMb: 64,
  });
  expect(
    (await adapter.render("https://press.example.org/d1", small)).kind,
  ).toBe("rendered");
  expect(
    (await adapter.render("https://press.example.org/d2", small)).kind,
  ).toBe("rendered");
  const dailyResult = await adapter.render(
    "https://press.example.org/d3",
    small,
  );
  expect(dailyResult.kind).toBe("refused");
  expect((dailyResult as { reason: string }).reason).toContain(
    "Daily render budget exhausted",
  );
  expect(adapter.rendersUsed).toBe(2);
  // Overlapping renders expose the concurrency budget: the second active
  // render is refused instead of silently doubling the boundary.
  const concurrent = new RecordedBrowserAdapter({
    perRenderTimeoutMs: 1000,
    perRenderMemoryMb: 128,
    maxConcurrentRenders: 1,
    maxRendersPerDay: 10,
  });
  const [firstRender, secondRender] = await Promise.all([
    concurrent.render("https://press.example.org/c1", small),
    concurrent.render("https://press.example.org/c2", small),
  ]);
  expect([firstRender.kind, secondRender.kind].sort()).toEqual([
    "refused",
    "rendered",
  ]);
  expect(concurrent.concurrencyViolations).toBe(1);
});

test("the CLI verb records the same deterministic report offline, with timing on stderr", () => {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "src/cli.ts",
      "evaluate-browser-extraction",
      "tests/fixtures/browser-extraction-corpus-v1.json",
      "--timing",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(proc.exitCode).toBe(0);
  const report = JSON.parse(
    proc.stdout.toString(),
  ) as BrowserExtractionEvaluationReport;
  expect(report.adoption.adopt).toBe(false);
  expect(report.gates.qualifyingLiftRecords).toEqual([]);
  const timing = JSON.parse(proc.stderr.toString()) as { scope: string };
  expect(timing.scope).toBe("offline in-process replay");
});

test("a readable JavaScript shell that only holds a loading placeholder records partial HTTP coverage and consults the browser arm", async () => {
  const report = await reported();
  const shell = record(report, "js-shell-loading-placeholder");
  // The shipped extractor "succeeds" on the placeholder body; the recorded
  // completeness markers show the report content is missing from it, so the
  // HTTP arm never claims complete coverage and zero lift.
  expect(shell.http.status).toBe("extracted");
  expect(shell.http.coverage).toBe("partial");
  expect(shell.http.textChars).toBe(17);
  expect(shell.http.textChars).toBeGreaterThan(0);
  // The recorded completeness markers are what the placeholder body lacks,
  // and the report records them via the corpus schema.
  expect(expectedMarkersOf("js-shell-loading-placeholder")).toEqual([
    "gait-controller calibration",
    "teardown photos",
  ]);
  // The browser arm was consulted and recovers the missing report content.
  expect(shell.browser.attempted).toBe(true);
  expect(shell.browser.outcome).toBe("rendered");
  expect(shell.browser.textChars).toBe(236);
  expect(shell.browserLift).toBe(219);
  expect(shell.httpInaccessible).toBe(true);
  // The completed report still stays a capability probe: no observed
  // deployment record demonstrates the pipeline losing this content.
  expect(shell.qualifying).toBe(false);
  expect(shell.rejectionReason).toContain("capability probe");
  expect(report.gates.partialHttpCoverageRecords).toEqual([
    "js-shell-loading-placeholder",
  ]);
});

function expectedMarkersOf(id: string): string[] {
  const found = parsedCorpus.records.find((r) => r.id === id);
  expect(found).toBeDefined();
  return found!.expectedHttpContent ?? [];
}

test("a transient 429/503 HTTP attempt is recorded through the shipped failProcessing lifecycle and rejects the replay instead of counting as terminal coverage", async () => {
  const transient = structuredClone(parsedCorpus.records[0]!);
  transient.id = "transient-503-record";
  transient.url = "https://press.example.org/reports/transient-503";
  transient.http = {
    ...transient.http,
    status: 503,
    body: "<html><body><p>Service temporarily unavailable</p></body></html>",
  };
  const corpusWithTransient = browserExtractionCorpusSchema.parse({
    ...corpusJson,
    records: [...parsedCorpus.records, transient],
  });
  // The shipped handler throws for 429/503; the shipped worker records that
  // via failProcessing (retryable), and the replay — which models no
  // retries — refuses to emit a decision rather than calling the attempt
  // terminal unavailability or reaching for the browser arm.
  expect(evaluateBrowserExtraction(corpusWithTransient)).rejects.toThrow(
    "remains retryable",
  );
  const rateLimited = structuredClone(transient);
  rateLimited.id = "rate-limited-record";
  rateLimited.url = "https://press.example.org/reports/rate-limited";
  rateLimited.http = {
    ...rateLimited.http,
    status: 429,
  };
  expect(
    evaluateBrowserExtraction(
      browserExtractionCorpusSchema.parse({
        ...corpusJson,
        records: [...parsedCorpus.records, rateLimited],
      }),
    ),
  ).rejects.toThrow("remains retryable");
});

test("an exhausted daily render allowance drives the dailyRenderBudgetExhausted gate and refuses the second permitted render", async () => {
  const constrained = browserExtractionCorpusSchema.parse({
    ...corpusJson,
    budgets: { ...parsedCorpus.budgets, maxRendersPerDay: 1 },
  });
  const report = await evaluateBrowserExtraction(constrained);
  // The first permitted render consumes the allowance; the second is
  // refused; the gate reflects the exhausted state instead of a constant.
  expect(report.gates.dailyRendersUsed).toBe(1);
  expect(report.gates.dailyRenderBudgetExhausted).toBe(true);
  expect(report.gates.browserRendersPerformed).toBe(1);
  const shell = record(report, "js-shell-loading-placeholder");
  expect(shell.browser.outcome).toBe("refused");
  expect(shell.browser.reason).toContain("Daily render budget exhausted");
  // Budget-limited coverage is recorded honestly; the decision stays
  // derived from the qualifying gates, which remain empty.
  expect(report.gates.qualifyingLiftRecords).toEqual([]);
  expect(report.adoption.adopt).toBe(false);
});

test("the recorded decision is derived from the qualifying gates: observed grounding plus recorded lift would flip it to adoption evidence", async () => {
  // The revisit path documented in D22: recording an observed deployment
  // limitation in a new corpus version changes the gates, and the decision
  // follows them instead of a literal.
  const grounded = browserExtractionCorpusSchema.parse({
    ...corpusJson,
    records: parsedCorpus.records.map((r) =>
      r.id === "js-only-app-report"
        ? { ...r, grounding: "deployment-recorded" }
        : r,
    ),
  });
  const report = await evaluateBrowserExtraction(grounded);
  expect(report.gates.qualifyingLiftRecords).toEqual(["js-only-app-report"]);
  expect(report.gates.observedDeploymentGapRecords).toEqual([
    "js-only-app-report",
    "reddit-blocked-discussion",
  ]);
  expect(report.adoption.adopt).toBe(true);
  expect(report.adoption.threshold).toBe(ADOPTION_THRESHOLD);
});

test("the adapter records daily-budget rejections in its own state for the gate", async () => {
  const adapter = new RecordedBrowserAdapter({
    perRenderTimeoutMs: 1000,
    perRenderMemoryMb: 128,
    maxConcurrentRenders: 1,
    maxRendersPerDay: 1,
  });
  const small = recordWith({
    renderedBody: "<html><body><p>x</p></body></html>",
    declaredRenderMs: 500,
    declaredMemoryMb: 64,
  });
  expect(
    (await adapter.render("https://press.example.org/e1", small)).kind,
  ).toBe("rendered");
  expect(
    (await adapter.render("https://press.example.org/e2", small)).kind,
  ).toBe("refused");
  expect(adapter.dailyBudgetRejections).toBe(1);
  expect(adapter.rendersUsed).toBe(1);
});
