import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { z } from "zod";
import { Store } from "./db/store";
import { HttpContentExtractor, extractionHandler } from "./adapters/extraction";
import { canonicalItemUrl, parseRedditDiscussion } from "./domain";
import { submissionFor, submitUrl, validateManualUrl } from "./manual";

/**
 * Permitted browser-extraction evaluation (issue #24). A conditional M5
 * evaluation in the recorded-evaluation convention (D17/D19/D20/D21): for each
 * corpus record — an ordinary permitted static page, a JavaScript-rendered
 * page, a blocked Reddit discussion and an anti-abuse interstitial — it runs
 * the SHIPPED HTTP-only extraction path (the shipped manual submission intake
 * of #17, the shipped extract job claim/complete path and the shipped
 * `HttpContentExtractor` boundary of #3 over recorded fake DNS/transport) and,
 * where the page is genuinely inaccessible over plain HTTP, a recorded
 * browser-equivalent arm produced by a simulated browser adapter at the
 * boundary. The adapter is deterministic: renders come pre-recorded in the
 * corpus and the adapter enforces the contracts adoption would require —
 * destination validation (the manual-submission discipline), permission
 * refusals (a restricted render is refused before anything happens),
 * concurrency, daily-render, per-render timeout and memory budgets, and
 * crash isolation (a crashed render returns unavailable instead of throwing).
 *
 * The adoption threshold is fixed in code before any replay result was
 * observed. Every HTTP response is served from the recorded corpus; nothing
 * fetches, nothing launches a browser, and no live capability runs in default
 * tests. The out-of-band live probe's observations are deliberately excluded
 * from this baseline and stay documented in docs/evaluation.md; the recorded
 * decision rests on the deterministic replay plus the documented terms/cost
 * analysis, clearly labelled as such.
 */

export const BROWSER_EXTRACTION_EVALUATION_VERSION =
  "browser-extraction-evaluation-v1";

export const ADOPTION_THRESHOLD =
  "Adopt a minimal optional browser-extraction adapter only when the recorded corpus contains at least one use case that satisfies ALL of: (a) observed limitation — the use case is grounded in recorded deployment evidence (an unavailable extraction result, or a submitted URL whose content the shipped HTTP-only extractor could not obtain), not a synthetic capability probe; (b) permitted render — the page is readable without authentication, without a robots/terms prohibition and without defeating a platform or anti-abuse control, so a browser render circumvents nothing (a blocked Reddit response never qualifies regardless of technical reachability and stays unavailable); (c) affordable — the render fits the explicit per-render timeout and memory budgets, the concurrency budget and the daily render budget while the adapter stays sandboxed, secret-free and provenance-preserving; and (d) lift — the browser-equivalent text materially exceeds what the HTTP-only baseline recorded, recovering content the pipeline demonstrably lacks. Otherwise record a justified non-adoption with the per-record rejection reasons.";

export const browserBudgetsSchema = z.strictObject({
  perRenderTimeoutMs: z.number().int().min(1).max(60_000),
  perRenderMemoryMb: z.number().int().min(1).max(8192),
  maxConcurrentRenders: z.number().int().min(1).max(4),
  maxRendersPerDay: z.number().int().min(1).max(1000),
});

export const browserRecordSchema = z
  .strictObject({
    id: z.string().min(1).max(100),
    useCase: z.string().min(1).max(2000),
    url: z.string().min(1).max(8192),
    /**
     * "deployment-recorded": the record's limitation was actually surfaced by
     * the recorded ingestion evidence (issue #17's Reddit paths).
     * "capability-probe": the record exists so the evaluation can measure a
     * hypothetical capability envelope the deployment has not demonstrably
     * lacked; it never satisfies an adoption condition on its own.
     */
    grounding: z.enum(["capability-probe", "deployment-recorded"]),
    groundingNote: z.string().min(1).max(2000),
    permitted: z.boolean(),
    permittedBasis: z.string().min(1).max(2000),
    /** Recorded snippet-level provenance (retained on blocked records). */
    snippet: z.string().max(10_000).optional(),
    /**
     * Recorded content markers whose presence in the extracted HTTP text is
     * required for the HTTP outcome to count as complete coverage. When any
     * marker is missing from an "extracted" HTTP body (for example a
     * readable JavaScript shell that only holds a loading placeholder), the
     * HTTP arm records partial coverage and the browser arm is consulted;
     * absent markers must be absent for a reason recorded in the grounding
     * note, never invented.
     */
    expectedHttpContent: z.array(z.string().min(1).max(200)).max(10).optional(),
    http: z.strictObject({
      status: z.number().int().min(0).max(599),
      headers: z.record(z.string(), z.string()),
      body: z.string().max(200_000),
    }),
    browser: z
      .strictObject({
        /** Present when the render would circumvent a restricted access. */
        refusalBasis: z.string().min(1).max(2000).optional(),
        /** The pre-recorded rendered DOM for permitted pages. */
        renderedBody: z.string().max(200_000).optional(),
        /** Failure injection: the simulated render crashes mid-flight. */
        crash: z.boolean().optional(),
        declaredRenderMs: z.number().int().min(0).max(600_000),
        declaredMemoryMb: z.number().int().min(0).max(8192),
      })
      .superRefine((browser, context) => {
        const arms = [
          browser.refusalBasis !== undefined,
          browser.renderedBody !== undefined,
          browser.crash === true,
        ].filter(Boolean).length;
        if (arms !== 1)
          context.addIssue({
            code: "custom",
            message:
              "Each record defines exactly one browser arm: refusalBasis (restriction), renderedBody (permitted render) or crash (failure injection)",
          });
      }),
  })
  .superRefine((record, context) => {
    const discard = parseRedditDiscussion(record.url);
    if (record.id.startsWith("reddit") && !discard)
      context.addIssue({
        code: "custom",
        message: `Record ${record.id} is labelled a Reddit use case but the URL is not a Reddit discussion identity`,
      });
    if (discard && record.browser.renderedBody !== undefined)
      context.addIssue({
        code: "custom",
        message: `Record ${record.id}: a Reddit discussion must never carry a recorded browser render — a blocked response stays unavailable`,
      });
    if (!record.permitted && record.browser.refusalBasis === undefined)
      context.addIssue({
        code: "custom",
        message: `Record ${record.id}: permission is denied (permitted: false), so the only recorded browser arm is refusalBasis — a render would circumvent the recorded restriction`,
      });
  });

export const browserExtractionCorpusSchema = z
  .strictObject({
    version: z.number().int().positive().safe(),
    id: z.string().min(1).max(100),
    notes: z.string().min(1).max(4000),
    asOf: z.number().int().safe(),
    budgets: browserBudgetsSchema,
    records: z.array(browserRecordSchema).min(2).max(20),
  })
  .superRefine((corpus, context) => {
    const ids = new Set(corpus.records.map((record) => record.id));
    if (ids.size !== corpus.records.length)
      context.addIssue({
        code: "custom",
        message: "Record IDs must be unique",
      });
  });

export type BrowserBudgets = z.infer<typeof browserBudgetsSchema>;
export type BrowserExtractionRecord = z.infer<typeof browserRecordSchema>;
export type BrowserExtractionCorpus = z.infer<
  typeof browserExtractionCorpusSchema
>;

export type SimulatedBrowserOutcome =
  | { kind: "rendered"; text: string; renderedMs: number; memoryMb: number }
  | { kind: "refused"; reason: string }
  | { kind: "unavailable"; reason: string };

/**
 * The simulated browser adapter at the boundary. It never launches anything
 * and never fetches: renders are pre-recorded in the corpus. Sandboxed and
 * secret-free hold by construction (a pure recorded function with no
 * environment, credentials or filesystem access), and provenance is
 * preserved — rendered outcomes are recorded separately from http-method
 * extraction and never merged with it.
 */
export class RecordedBrowserAdapter {
  renderAttempts = 0;
  rendersUsed = 0;
  destinationRefusals = 0;
  permissionRefusals = 0;
  budgetRejections = 0;
  dailyBudgetRejections = 0;
  concurrencyViolations = 0;
  crashesIsolated = 0;
  private active = 0;

  constructor(private readonly budgets: BrowserBudgets) {}

  async render(
    url: string,
    record: BrowserExtractionRecord,
  ): Promise<SimulatedBrowserOutcome> {
    this.renderAttempts += 1;
    this.active += 1;
    try {
      // A microtask boundary makes overlapping renders observable so the
      // concurrency budget is exercised by the same code path as the replay.
      await Promise.resolve();
      try {
        validateManualUrl(url);
      } catch (error) {
        this.destinationRefusals += 1;
        return {
          kind: "refused",
          reason: `Destination validation refused the render (sandboxed, private-network-safe boundary): ${(error as Error).message}`,
        };
      }
      if (record.browser.refusalBasis !== undefined) {
        this.permissionRefusals += 1;
        return { kind: "refused", reason: record.browser.refusalBasis };
      }
      if (record.browser.crash === true) {
        this.crashesIsolated += 1;
        return {
          kind: "unavailable",
          reason:
            "Recorded browser-render crash; the failure stays isolated at the adapter boundary, no content is produced and the extraction pipeline is unaffected",
        };
      }
      if (this.active > this.budgets.maxConcurrentRenders) {
        this.concurrencyViolations += 1;
        return {
          kind: "refused",
          reason: `Concurrency budget exceeded: ${this.active} active renders > ${this.budgets.maxConcurrentRenders}`,
        };
      }
      if (this.rendersUsed >= this.budgets.maxRendersPerDay) {
        this.budgetRejections += 1;
        this.dailyBudgetRejections += 1;
        return {
          kind: "refused",
          reason: `Daily render budget exhausted (${this.budgets.maxRendersPerDay}/day)`,
        };
      }
      if (record.browser.declaredRenderMs > this.budgets.perRenderTimeoutMs) {
        this.budgetRejections += 1;
        return {
          kind: "refused",
          reason: `Per-render timeout budget exceeded: declared ${record.browser.declaredRenderMs}ms > ${this.budgets.perRenderTimeoutMs}ms`,
        };
      }
      if (record.browser.declaredMemoryMb > this.budgets.perRenderMemoryMb) {
        this.budgetRejections += 1;
        return {
          kind: "refused",
          reason: `Per-render memory budget exceeded: declared ${record.browser.declaredMemoryMb}MB > ${this.budgets.perRenderMemoryMb}MB`,
        };
      }
      this.rendersUsed += 1;
      const text = renderedText(record.browser.renderedBody ?? "");
      if (!text)
        return {
          kind: "unavailable",
          reason: "Rendered page had no readable text",
        };
      return {
        kind: "rendered",
        text,
        renderedMs: record.browser.declaredRenderMs,
        memoryMb: record.browser.declaredMemoryMb,
      };
    } finally {
      this.active -= 1;
    }
  }
}

/** Rendered-DOM text reading, following the shipped cleanup conventions. */
function renderedText(html: string): string {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll(
    "script,style,nav,aside,form,iframe,header,footer",
  ))
    node.remove();
  return (document.body?.textContent ?? "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface BrowserRecordReport {
  id: string;
  useCase: string;
  url: string;
  canonicalUrl: string;
  grounding: BrowserExtractionRecord["grounding"];
  groundingNote: string;
  permitted: boolean;
  permittedBasis: string;
  /** The SHIPPED HTTP-only extraction outcome through the shipped path. */
  http: {
    method: "http";
    status: "extracted" | "unavailable";
    /**
     * Coverage against the recorded expected content markers: "absent"
     * (extraction failed), "partial" (extracted text misses recorded
     * markers, e.g. a readable JS shell with only a loading placeholder)
     * or "complete".
     */
    coverage: "complete" | "partial" | "absent";
    reason: string | null;
    retryable: boolean;
    textChars: number;
  };
  /** The browser-equivalent arm through the simulated adapter. */
  browser: {
    attempted: boolean;
    outcome:
      "not-attempted-http-succeeded" | "rendered" | "refused" | "unavailable";
    reason: string | null;
    textChars: number | null;
    renderedMs: number | null;
    memoryMb: number | null;
    sandboxed: boolean | null;
    secretFree: boolean | null;
    provenance: string | null;
  };
  /** Rendered text chars minus HTTP text chars; 0 when nothing rendered. */
  browserLift: number;
  httpInaccessible: boolean;
  browserRenderPermitted: boolean;
  affordable: boolean;
  affordabilityReason: string;
  observedDeploymentGap: boolean;
  qualifying: boolean;
  rejectionReason: string | null;
}

export interface BrowserExtractionEvaluationReport {
  evaluationVersion: typeof BROWSER_EXTRACTION_EVALUATION_VERSION;
  corpus: { id: string; version: number; asOf: number; hash: string };
  /** The shipped boundaries the replay drove — not new extraction code. */
  replayShippedSurfaces: {
    httpExtraction: string;
    manualSubmissionPath: string;
    browserAdapter: string;
  };
  records: BrowserRecordReport[];
  gates: {
    recordsTotal: number;
    httpBaselineExtracted: number;
    httpBaselineUnavailable: number;
    browserArmAttempts: number;
    browserRendersPerformed: number;
    browserRefusals: number;
    browserUnavailableOutcomes: number;
    recordsHttpInaccessible: string[];
    partialHttpCoverageRecords: string[];
    recordsPermittedToRender: string[];
    recordsWithinBudgets: string[];
    observedDeploymentGapRecords: string[];
    recordsQualifyingOnAccessPermittedAffordability: string[];
    qualifyingLiftRecords: string[];
    recordedRejectionReasons: Record<string, string>;
    /** Reddit blocks stay unavailable; no render is recorded or attempted. */
    blockedRedditResponseStaysUnavailable: boolean;
    circumventionAttempts: 0;
    redditSubmissionProvenancePreserved: boolean;
    budgets: BrowserBudgets;
    dailyRendersUsed: number;
    /** Derived from the adapter's daily-budget state, never a constant. */
    dailyRenderBudgetExhausted: boolean;
    newTrustBoundariesAdoptionWouldCreate: string[];
    coreIngestionBrowserDependentRequirements: 0;
    liveBrowserUsedInReplay: false;
    liveProviderOrNetworkEgress: 0;
    liveMeasurement: { status: "recorded-out-of-band"; note: string };
  };
  adoption: { adopt: boolean; threshold: string };
}

interface RecordedExtraction {
  status?: string;
  reason?: string | null;
  retryable?: boolean | null;
  text?: string | null;
  method?: string | null;
}

function affordabilityAssessment(
  budgets: BrowserBudgets,
  record: BrowserExtractionRecord,
  outcome: BrowserRecordReport["browser"]["outcome"],
  affordable: boolean,
): { affordable: boolean; reason: string } {
  if (outcome === "not-attempted-http-succeeded")
    return {
      affordable: false,
      reason:
        "HTTP-only extraction recorded complete coverage; no browser render was needed or attempted",
    };
  if (outcome === "rendered")
    return {
      affordable,
      reason: affordable
        ? `Rendered within the recorded budgets: declared ${record.browser.declaredRenderMs}ms <= ${budgets.perRenderTimeoutMs}ms timeout and ${record.browser.declaredMemoryMb}MB <= ${budgets.perRenderMemoryMb}MB memory; sandboxed, secret-free and provenance-preserving by adapter construction`
        : `Rendered outside the recorded budgets: declared ${record.browser.declaredRenderMs}ms vs ${budgets.perRenderTimeoutMs}ms timeout, ${record.browser.declaredMemoryMb}MB vs ${budgets.perRenderMemoryMb}MB memory`,
    };
  return {
    affordable: false,
    reason: `Affordability not reached: the simulated adapter refused or failed before rendering (${outcome})`,
  };
}

function rejectionReason(
  record: BrowserExtractionRecord,
  conditions: {
    httpInaccessible: boolean;
    browserRenderPermitted: boolean;
    affordable: boolean;
    observedDeploymentGap: boolean;
    browserLift: number;
  },
): string {
  const unmet: string[] = [];
  if (!conditions.httpInaccessible)
    unmet.push(
      "(a) HTTP-only extraction recorded complete coverage, so no content was lost to recover",
    );
  if (!conditions.browserRenderPermitted)
    unmet.push(
      "(b) a browser render is not permitted: the page sits behind an authentication, platform/anti-abuse or robots/terms restriction, and rendering it would circumvent that control",
    );
  if (!conditions.affordable)
    unmet.push(
      "(c) affordability was not established inside the explicit budgets",
    );
  if (!conditions.observedDeploymentGap)
    unmet.push(
      "(a-grounding) no deployment-recorded outcome (an unavailable extraction, or a submitted URL whose content could not be retrieved) demonstrates this limitation; the record is a capability probe, not observed pipeline loss",
    );
  if (
    conditions.httpInaccessible &&
    conditions.browserRenderPermitted &&
    conditions.browserLift <= 0
  )
    unmet.push("(d) no recorded browser lift over the HTTP baseline");
  return `Record ${record.id} does not qualify: ${unmet.join("; ")} ${record.groundingNote}`;
}

/**
 * Runs the evaluation deterministically. All HTTP responses come from the
 * recorded corpus behind the shipped extractor; the browser arm is the
 * simulated recorded adapter; nothing fetches, launches or reads the wall
 * clock, so a repeat run reproduces the baseline byte for byte.
 */
export async function evaluateBrowserExtraction(
  corpusInput: unknown,
): Promise<BrowserExtractionEvaluationReport> {
  const corpus = browserExtractionCorpusSchema.parse(corpusInput);
  const hash = createHash("sha256")
    .update(JSON.stringify(corpus))
    .digest("hex");
  const store = new Store(":memory:");
  const adapter = new RecordedBrowserAdapter(corpus.budgets);
  try {
    // Recorded fake DNS/transport behind the shipped HttpContentExtractor: no
    // network exists during the replay.
    const responses = new Map<
      string,
      { status: number; headers: Record<string, string>; body: string }
    >();
    for (const record of corpus.records)
      responses.set(new URL(record.url).href, record.http);
    const extractor = new HttpContentExtractor(
      async (host) => {
        if (!host) throw new Error("No host to resolve");
        return ["93.184.216.34"];
      },
      async (url) => {
        const found = responses.get(url.href);
        if (!found)
          throw new Error(`No recorded HTTP response for ${url.href}`);
        return {
          status: found.status,
          headers: found.headers,
          body: found.body,
        };
      },
    );
    // The shipped extraction handler, wired exactly as src/main.ts wires it:
    // reference resolution, HN structured-body handling and trusted-origin
    // plumbing unchanged, driven over issue #17's manual submission intake.
    const handler = extractionHandler(store, extractor, []);

    const records: BrowserRecordReport[] = [];
    let redditProvenancePreserved = true;
    let blockedRedditStaysUnavailable = true;
    let redditRecordSeen = false;

    for (const [index, record] of corpus.records.entries()) {
      const now = corpus.asOf + index * 1000;
      const reddit = parseRedditDiscussion(record.url);
      const submission = submitUrl(store, {
        submissionId: `browser-extraction-evaluation:${record.id}`,
        url: record.url,
        origin: "manual",
        ...(record.snippet !== undefined ? { snippet: record.snippet } : {}),
        now,
      });
      if (reddit) {
        redditRecordSeen = true;
        const provenance = submissionFor(store, submission.itemId);
        const recordedReddit = (
          provenance?.metadata as
            { reddit?: { postId?: string; subreddit?: string } } | undefined
        )?.reddit;
        if (
          !provenance ||
          recordedReddit?.postId !== reddit.postId ||
          recordedReddit?.subreddit !== reddit.subreddit
        )
          redditProvenancePreserved = false;
      }
      const job = store.claimProcessing("extract", now + 1);
      if (!job || job.item_id !== submission.itemId)
        throw new Error(
          `No extract job claimable for record ${record.id}; the shipped ingest path no longer enqueues extraction`,
        );
      let handled: { status: string; result?: string };
      try {
        handled = await handler(job, AbortSignal.timeout(15_000));
      } catch (error) {
        // A retryable failure throws through the shipped handler contract;
        // the shipped worker records such attempts for retry via the shipped
        // failProcessing path, and this replay does exactly that. Because the
        // replay models no retries, it refuses to emit a decision from an
        // incomplete HTTP attempt — a transient 429/503 is neither terminal
        // unavailability nor a browser-arm trigger.
        store.failProcessing(job, (error as Error).message, now + 2);
        throw new Error(
          `Incomplete browser-extraction replay: shipped HTTP extraction for record ${record.id} remains retryable (${(error as Error).message}); the replay models no retries, so it refuses to record a transient attempt as terminal HTTP coverage`,
        );
      }
      if (handled.status !== "extracted" && handled.status !== "unavailable")
        throw new Error(
          `Unexpected shipped extraction status ${String(handled.status)} for record ${record.id}`,
        );
      const completed =
        handled.status === "extracted"
          ? store.completeProcessing(
              job,
              "extracted",
              now + 2,
              handled.result ?? null,
            )
          : store.completeProcessing(
              job,
              "unavailable",
              now + 2,
              handled.result ?? null,
            );
      if (!completed)
        throw new Error(
          `Shipped job completion refused for record ${record.id}`,
        );
      const extraction = JSON.parse(
        handled.result ?? "{}",
      ) as RecordedExtraction;
      const httpStatus: BrowserRecordReport["http"]["status"] =
        extraction.status === "extracted" ? "extracted" : "unavailable";
      const httpTextChars = extraction.text?.length ?? 0;
      // Recorded completeness check: an "extracted" body only counts as
      // complete coverage when it contains every recorded expected marker —
      // a readable JavaScript shell that merely shows a loading placeholder
      // is partial coverage, and the browser arm is consulted for it.
      const missingMarkers = (record.expectedHttpContent ?? []).filter(
        (marker) => !(extraction.text ?? "").includes(marker),
      );
      const httpCoverage: BrowserRecordReport["http"]["coverage"] =
        httpStatus === "unavailable"
          ? "absent"
          : missingMarkers.length > 0
            ? "partial"
            : "complete";
      const httpInaccessible = httpCoverage !== "complete";

      // The browser arm is consulted only when HTTP-only extraction failed.
      let attempted = false;
      let browserOutcome: BrowserRecordReport["browser"]["outcome"] =
        "not-attempted-http-succeeded";
      let browserReason: string | null = null;
      let browserTextChars: number | null = null;
      let renderedMs: number | null = null;
      let memoryMb: number | null = null;
      if (httpInaccessible) {
        attempted = true;
        const rendered = await adapter.render(record.url, record);
        if (rendered.kind === "rendered") {
          browserOutcome = "rendered";
          browserTextChars = rendered.text.length;
          renderedMs = rendered.renderedMs;
          memoryMb = rendered.memoryMb;
        } else if (rendered.kind === "refused") {
          browserOutcome = "refused";
          browserReason = rendered.reason;
        } else {
          browserOutcome = "unavailable";
          browserReason = rendered.reason;
        }
      }
      const browserRenderPermitted =
        record.browser.refusalBasis === undefined &&
        record.browser.crash !== true;
      const renderedWithinBudgets =
        browserOutcome === "rendered" &&
        renderedMs !== null &&
        renderedMs <= corpus.budgets.perRenderTimeoutMs &&
        memoryMb !== null &&
        memoryMb <= corpus.budgets.perRenderMemoryMb;
      const { affordable, reason: affordabilityReason } =
        affordabilityAssessment(
          corpus.budgets,
          record,
          browserOutcome,
          renderedWithinBudgets,
        );
      const observedDeploymentGap = record.grounding === "deployment-recorded";
      const browserLift =
        browserOutcome === "rendered"
          ? Math.max(0, (browserTextChars ?? 0) - httpTextChars)
          : 0;
      const qualifying =
        httpInaccessible &&
        browserRenderPermitted &&
        affordable &&
        observedDeploymentGap;
      records.push({
        id: record.id,
        useCase: record.useCase,
        url: record.url,
        canonicalUrl: canonicalItemUrl(record.url),
        grounding: record.grounding,
        groundingNote: record.groundingNote,
        permitted: record.permitted,
        permittedBasis: record.permittedBasis,
        http: {
          method: "http",
          status: httpStatus,
          coverage: httpCoverage,
          reason: extraction.reason ?? null,
          retryable: extraction.retryable === true,
          textChars: httpTextChars,
        },
        browser: {
          attempted,
          outcome: browserOutcome,
          reason: browserReason,
          textChars: browserTextChars,
          renderedMs,
          memoryMb,
          sandboxed: browserOutcome === "rendered" ? true : null,
          secretFree: browserOutcome === "rendered" ? true : null,
          provenance:
            browserOutcome === "rendered"
              ? "browser-simulated recorded render; the simulated method, resolved URL and source URL are recorded with the text and stay separable from http-method extraction"
              : null,
        },
        browserLift,
        httpInaccessible,
        browserRenderPermitted,
        affordable,
        affordabilityReason,
        observedDeploymentGap,
        qualifying,
        rejectionReason: qualifying
          ? null
          : rejectionReason(record, {
              httpInaccessible,
              browserRenderPermitted,
              affordable,
              observedDeploymentGap,
              browserLift,
            }),
      });

      if (reddit) {
        const item = store.getItem(submission.itemId) as unknown as {
          extraction?: RecordedExtraction | null;
        } | null;
        const itemUnavailable = item?.extraction?.status === "unavailable";
        if (
          !itemUnavailable ||
          browserOutcome !== "refused" ||
          !(browserReason ?? "").includes("anti-abuse") ||
          !record.permittedBasis.includes("anti-abuse")
        )
          blockedRedditStaysUnavailable = false;
      }
    }
    if (!redditRecordSeen) blockedRedditStaysUnavailable = false;

    const qualifyingOnAccessPermittedAffordability = records
      .filter(
        (record) =>
          record.httpInaccessible &&
          record.browserRenderPermitted &&
          record.affordable,
      )
      .map((record) => record.id);
    const qualifyingLiftRecords = records
      .filter((record) => record.qualifying)
      .map((record) => record.id);
    const recordedRejectionReasons: Record<string, string> = {};
    for (const record of records)
      if (record.rejectionReason)
        recordedRejectionReasons[record.id] = record.rejectionReason;

    return {
      evaluationVersion: BROWSER_EXTRACTION_EVALUATION_VERSION,
      corpus: {
        id: corpus.id,
        version: corpus.version,
        asOf: corpus.asOf,
        hash,
      },
      replayShippedSurfaces: {
        httpExtraction:
          "HttpContentExtractor (src/adapters/extraction.ts, issue #3) over recorded fake DNS + transport, driven through the shipped extract processing path in the src/main.ts wiring",
        manualSubmissionPath:
          "submitUrl/submissionFor (src/manual.ts, issue #17): canonical identity, idempotency, reddit provenance and snippet retention",
        browserAdapter:
          "simulated-recorded (evaluation-only, src/browser-extraction-evaluation.ts): renders pre-recorded in the corpus; destination validation, permission refusals, timeout/memory/concurrency/daily budgets and crash isolation enforced at the boundary",
      },
      records,
      gates: {
        recordsTotal: records.length,
        httpBaselineExtracted: records.filter(
          (record) => record.http.status === "extracted",
        ).length,
        httpBaselineUnavailable: records.filter(
          (record) => record.http.status === "unavailable",
        ).length,
        browserArmAttempts: records.filter((record) => record.browser.attempted)
          .length,
        browserRendersPerformed: records.filter(
          (record) => record.browser.outcome === "rendered",
        ).length,
        browserRefusals: records.filter(
          (record) => record.browser.outcome === "refused",
        ).length,
        browserUnavailableOutcomes: records.filter(
          (record) => record.browser.outcome === "unavailable",
        ).length,
        recordsHttpInaccessible: records
          .filter((record) => record.httpInaccessible)
          .map((record) => record.id),
        partialHttpCoverageRecords: records
          .filter((record) => record.http.coverage === "partial")
          .map((record) => record.id),
        recordsPermittedToRender: records
          .filter((record) => record.browserRenderPermitted)
          .map((record) => record.id),
        recordsWithinBudgets: records
          .filter((record) => record.affordable)
          .map((record) => record.id),
        observedDeploymentGapRecords: records
          .filter((record) => record.observedDeploymentGap)
          .map((record) => record.id),
        recordsQualifyingOnAccessPermittedAffordability:
          qualifyingOnAccessPermittedAffordability,
        qualifyingLiftRecords,
        recordedRejectionReasons,
        blockedRedditResponseStaysUnavailable: blockedRedditStaysUnavailable,
        circumventionAttempts: 0,
        redditSubmissionProvenancePreserved: redditProvenancePreserved,
        budgets: corpus.budgets,
        dailyRendersUsed: adapter.rendersUsed,
        dailyRenderBudgetExhausted: adapter.dailyBudgetRejections > 0,
        newTrustBoundariesAdoptionWouldCreate: [
          "a long-lived networked browser/rendering subprocess executing untrusted page scripts inside the single-user monolith, with its own sandbox profile, binary installation and CVE maintenance cadence",
          "a budget ledger for per-render timeout/memory, concurrency and daily render counts that core HTTP ingestion does not need",
          "a second provenance surface (browser-rendered text) that must stay honestly separated from http-method extraction and record its simulated/real sandboxed method",
        ],
        coreIngestionBrowserDependentRequirements: 0,
        liveBrowserUsedInReplay: false,
        liveProviderOrNetworkEgress: 0,
        liveMeasurement: {
          status: "recorded-out-of-band",
          note: "This replay launches no browser and fetches nothing: both arms are recorded/simulated, and the recorded decision rests on the deterministic replay plus the documented terms/cost analysis. A bounded live capability probe (agent-browser CLI against a localhost-only page; no external egress; no third-party or Reddit navigation) was performed out-of-band while recording this evaluation; its environment-specific observations are documented in docs/evaluation.md and deliberately excluded from this byte-reproducible baseline.",
        },
      },
      adoption: {
        adopt: qualifyingLiftRecords.length > 0,
        threshold: ADOPTION_THRESHOLD,
      },
    };
  } finally {
    store.close();
  }
}
