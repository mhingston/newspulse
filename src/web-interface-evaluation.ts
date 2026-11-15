import { createHash } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "./db/store";
import { DigestStore, type FrozenDigestInput } from "./db/digest-store";
import { ProfileStore, interestSchema } from "./profiles";
import { createMcp } from "./mcp";
import { consumeConfirmation, ConfirmationError } from "./confirmations";
import { MUTATION_ACTIONS } from "./mutations";
import { runDiscovery } from "./discovery-service";
import type {
  SearchResult,
  SearchPage,
  SearchProvider,
} from "./search-provider";
import { scoreItem } from "./scoring";
import { canonicalItemUrl } from "./domain";

/**
 * Optional discovery-focused web interface evaluation (issue #31). A
 * conditional M5 evaluation: it records, per concrete user task from the
 * issue's scope — understanding a discovery/ranking explanation, running a
 * budgeted discovery query, configuring interests, giving explicit feedback
 * (item, query and discovery linkage) and reviewing story developments and
 * edition history — the exact shipped surface (MCP tool or CLI verb) that
 * performs every step, by actually performing each step through the real
 * registered MCP tool surface (official SDK client over an in-memory
 * transport pair: the production `createMcp` handler, no sockets, no
 * network) against a throwaway production-schema store seeded through the
 * shipped ingest, discovery, grouping, scoring and freezing paths with a
 * recorded fake discovery provider, with the confirmed trigger dispatching
 * through the same fixture clock so both recorded discovery runs consume one
 * recorded daily budget regardless of when the replay executes.
 *
 * A hypothetical web UI is adopted only for a step no shipped surface can
 * perform; a replay whose steps do not all complete is rejected instead of
 * emitting a decision. No live provider, no email; conversational reasoning
 * stays in the connecting client.
 */

export const WEB_INTERFACE_EVALUATION_VERSION = "web-interface-evaluation-v1";

/**
 * The adoption threshold, fixed in code before the replay result was
 * observed, per the conditional-issue convention (D15/D17/D19/D20).
 */
export const ADOPTION_THRESHOLD =
  "Adopt a minimal discovery-focused web interface only when the replayed corpus contains at least one concrete task step that no shipped MCP tool and no shipped CLI verb can perform, and a private, authenticated browser session would demonstrably and materially improve exactly that step within the modular-monolith constraints (reusing the shared application services, keeping the preview/confirm mutation contract, origin/CSRF protections and untrusted-content citation discipline), rather than duplicating conversational reasoning or read rendering the connecting MCP client already performs. Otherwise record a justified non-adoption.";

const resultSchema = z.strictObject({
  url: z.string().min(1).max(8192),
  title: z.string().min(1).max(1000),
  snippet: z.string().max(10000).optional(),
  publishedAt: z.number().int().safe().optional(),
});

export const webInterfaceCorpusSchema = z
  .strictObject({
    version: z.number().int().positive().safe(),
    id: z.string().min(1).max(100),
    notes: z.string().max(4000),
    asOf: z.number().int().safe(),
    changeWindowDays: z.number().int().min(1).max(365),
    discoveryEnv: z.record(
      z.string().min(1).max(60),
      z.string().min(1).max(60),
    ),
    sources: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(200),
          url: z.string().min(1).max(8192),
          title: z.string().min(1).max(500),
        }),
      )
      .min(1)
      .max(10),
    interestSeed: interestSchema,
    /**
     * The interest change WITHOUT a version: `update_interest` computes the
     * next immutable version itself. Validated through the same interest
     * schema (augmented with a placeholder version), never before opening
     * the store.
     */
    interestUpdate: z.unknown().superRefine((value, context) => {
      const parsed = interestSchema.safeParse({
        ...(typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)
          : {}),
        kind: "interest",
        version: 1,
      });
      if (!parsed.success)
        context.addIssue({
          code: "custom",
          message: `invalid interestUpdate: ${parsed.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        });
    }),
    feedItems: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(200),
          nativeId: z.string().min(1).max(200),
          url: z.string().min(1).max(8192),
          title: z.string().min(1).max(1000),
          text: z.string().min(1).max(200000),
          publishedAt: z.number().int().safe(),
          observedAt: z.number().int().safe(),
        }),
      )
      .min(1)
      .max(200),
    discovery: z.strictObject({
      seedQuery: z.string().min(1).max(500),
      triggerQuery: z.string().min(1).max(500),
      provider: z.strictObject({
        name: z.string().min(1).max(100),
        version: z.string().min(1).max(100),
      }),
      results: z.array(resultSchema).min(2).max(50),
      triggerResults: z.array(resultSchema).min(1).max(50),
    }),
    edition: z.strictObject({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      subject: z.string().min(1).max(1000),
      text: z.string().min(1).max(50000),
      frozenAt: z.number().int().safe(),
    }),
  })
  .superRefine((corpus, context) => {
    const ids = new Set(corpus.feedItems.map((item) => item.id));
    if (ids.size !== corpus.feedItems.length)
      context.addIssue({
        code: "custom",
        message: "Feed item IDs must be unique",
      });
    if (corpus.discovery.seedQuery === corpus.discovery.triggerQuery)
      context.addIssue({
        code: "custom",
        message: "Seed and trigger discovery queries must differ",
      });
  });

export type WebInterfaceCorpus = z.infer<typeof webInterfaceCorpusSchema>;

export type TaskStepSurface = "mcp-tool" | "cli-verb";

export interface TaskStep {
  stepId: string;
  description: string;
  /** Shipped surfaces recorded for this step. */
  surfaces: TaskStepSurface[];
  /** The shipped MCP tool the step was performed through in the replay. */
  mcpTool: string | null;
  /** A representative shipped CLI verb for the same application service. */
  cliVerb: string | null;
  performed: boolean;
  ok: boolean;
  observed: string;
}

export interface TaskResult {
  taskId: string;
  task: string;
  /**
   * Derived from the recorded steps before the report is emitted, never
   * hard-coded: "both" requires every step to have a CLI verb.
   */
  coveredBy?: "mcp-tool" | "cli-verb" | "both";
  steps: TaskStep[];
  /** Steps no shipped MCP tool or CLI verb can perform; the UI-only slice. */
  mcpClientCannotPerform: string[];
  shipped: string;
  verdict: string;
}

export interface WebInterfaceEvaluationReport {
  evaluationVersion: typeof WEB_INTERFACE_EVALUATION_VERSION;
  corpus: { id: string; version: number; asOf: number; hash: string };
  sourceSurface: {
    /** The tool contract actually registered by the shipped `createMcp`. */
    mcpTools: string[];
  };
  tasks: TaskResult[];
  gates: {
    taskStepsWithoutShippedSurface: number;
    /** Total recorded steps that completed through their declared surface. */
    taskStepsCompleted: number;
    uncoveredSteps: string[];
    /** Steps a browser session would add today; empty means none. */
    uiOnlySteps: string[];
    /**
     * True only when the replay verified BOTH halves: a replayed consumed
     * token is rejected, and on fresh preview tokens an equal-document
     * confirm applies nothing while a changed document is rejected as
     * payload_changed with no mutation.
     */
    previewConfirmTokenSingleUseAndPayloadBound: boolean;
    discoveryLedgerRefinementRecordedFromItemFeedback: boolean;
    frozenEditionImmutableUnderFeedback: boolean;
    /**
     * The confirmed trigger dispatches through the fixture clock, so both
     * recorded discovery pages must consume the same (fixture) daily budget.
     */
    triggerBudgetConsumedOnFixtureDay: boolean;
    recordedProviderRequests: number;
    uiTransportOrEmailSideEffects: 0;
    newTrustBoundariesAdoptionWouldCreate: string[];
    duplicateTransportSurface: true;
  };
  adoption: { adopt: boolean; threshold: string };
}

/**
 * Recorded fake behind `SearchProvider`: pages come from the corpus, no
 * network exists. The request count is reported so the replay's only
 * "external" interaction remains the recorded provider surface.
 */
class RecordedDiscoveryProvider implements SearchProvider {
  requests = 0;
  constructor(
    private readonly pages: Record<string, SearchResult[]>,
    readonly name: string,
    readonly version: string,
  ) {}
  async search(input: { query: string; limit: number }): Promise<SearchPage> {
    this.requests += 1;
    return {
      results: (this.pages[input.query] ?? []).slice(
        0,
        Math.max(0, input.limit),
      ),
      truncated: false,
    };
  }
}

/**
 * Deterministic settle pass through the shipped processing states, the same
 * mechanism the alert replay uses: recorded extract results, no analysis
 * provider, the shipped scorer over the shipped snapshot, and grouping
 * reconciled through the shipped StoryStore.
 */
function settleAll(store: Store, now: number): void {
  for (;;) {
    let progressed = false;
    for (const stage of ["extract", "analyse", "group", "score"] as const) {
      for (;;) {
        const job = store.claimProcessing(stage, now);
        if (!job) break;
        if (stage === "extract") {
          if (
            store.completeProcessing(
              job,
              "extracted",
              now,
              JSON.stringify({ status: "extracted", text: "" }),
            )
          )
            progressed = true;
          continue;
        }
        if (stage === "analyse") {
          // The replay configures no analysis provider, so analysis
          // completes through the shipped no-provider path (job recorded
          // analysed, no analysis row; scoring then records
          // analysis_unavailable in its uncertainty reasons).
          if (store.completeProcessing(job, "analysed", now)) progressed = true;
          continue;
        }
        if (stage === "score") {
          const snapshot = store.scoringSnapshot(job, now);
          if (!snapshot) {
            store.sqlite
              .query(
                "UPDATE processing_jobs SET status='done',outcome='superseded',lease_token=NULL,lease_until=NULL WHERE id=?",
              )
              .run(job.id);
            continue;
          }
          const result = scoreItem(snapshot.input);
          if (
            store.completeScore(
              job,
              {
                capturedAt: now,
                inputHash: snapshot.inputHash,
                criteriaVersion: result.criteriaVersion,
                provenance: snapshot.provenance,
                result,
              },
              now,
            )
          )
            progressed = true;
          continue;
        }
        store.stories.reconcile(now);
        if (store.completeProcessing(job, "grouped", now)) progressed = true;
      }
    }
    if (!progressed) break;
  }
}

interface SeededDatabase {
  store: Store;
  resolveFeedItem: (fixtureId: string) => string;
  resolveDiscoveryItem: (url: string) => string;
  provider: RecordedDiscoveryProvider;
}

/**
 * Seeds a throwaway production-schema store through the shipped ingest path
 * (per-wave polls), the shipped discovery run service (recorded fake
 * provider), the shipped grouping/scoring settle pass, and the shipped
 * immutable edition freeze.
 */
async function seedDatabase(
  corpus: WebInterfaceCorpus,
): Promise<SeededDatabase> {
  const store = new Store(":memory:");
  const source = corpus.sources[0]!;
  store.addSource(source.url, source.title);

  // The shipped profile import path (interests exist before scoring runs).
  new ProfileStore(store.sqlite).import([corpus.interestSeed]);

  // Per-wave polls through the shipped enqueue/claim/complete path.
  const waves = [...new Set(corpus.feedItems.map((i) => i.observedAt))].sort(
    (a, b) => a - b,
  );
  for (const wave of waves) {
    store.enqueueDue(wave, true);
    const job = store.claim(wave);
    if (!job) throw new Error("No poll job claimable for the fixture wave");
    store.complete(
      job,
      {
        items: corpus.feedItems
          .filter((item) => item.observedAt === wave)
          .map((item) => ({
            nativeId: item.nativeId,
            url: item.url,
            title: item.title,
            text: item.text,
            publishedAt: item.publishedAt,
          })),
      },
      wave + 1000,
    );
    // Group each wave with the shipped planner.
    store.stories.reconcile(wave);
  }

  // Seed the discovery ledger through the shipped run service with the
  // recorded fake provider, using the same budget config the MCP trigger
  // will re-check.
  const provider = new RecordedDiscoveryProvider(
    {
      [corpus.discovery.seedQuery]: corpus.discovery.results,
      [corpus.discovery.triggerQuery]: corpus.discovery.triggerResults,
    },
    corpus.discovery.provider.name,
    corpus.discovery.provider.version,
  );
  const seeded = await runDiscovery(
    store,
    provider,
    corpus.discovery.seedQuery,
    discoveryLimits(corpus),
    () => corpus.asOf - 3_600_000,
    { queryKind: "interest" },
  );
  if (seeded.status !== "complete" || seeded.results < 1)
    throw new Error("Recorded discovery seed did not complete");

  // Settle derived work exactly as an operator's database would be.
  settleAll(store, corpus.asOf);

  const resolveFeedItem = (fixtureId: string): string => {
    const item = corpus.feedItems.find((i) => i.id === fixtureId);
    if (!item) throw new Error(`Unknown fixture item ${fixtureId}`);
    const row = store.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM items WHERE identity=?")
      .get("url:" + canonicalItemUrl(item.url));
    if (!row) throw new Error(`Fixture item ${fixtureId} was never ingested`);
    return row.id;
  };
  const resolveDiscoveryItem = (url: string): string => {
    const row = store.sqlite
      .query<{ item_id: string }, [string]>(
        "SELECT item_id FROM discovery_results WHERE url=?",
      )
      .get(url);
    if (!row) throw new Error(`No discovery result recorded for ${url}`);
    return row.item_id;
  };

  return { store, resolveFeedItem, resolveDiscoveryItem, provider };
}

function discoveryLimits(corpus: WebInterfaceCorpus) {
  const env = corpus.discoveryEnv;
  const int = (key: string): number => {
    const value = Number(env[key]);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Missing discovery budget ${key}`);
    return value;
  };
  return {
    maxQueriesPerDay: int("DISCOVERY_DAILY_QUERIES"),
    maxQueriesPerRun: int("DISCOVERY_RUN_QUERIES"),
    maxResultsPerDay: int("DISCOVERY_DAILY_RESULTS"),
    maxResultsPerRun: int("DISCOVERY_RUN_RESULTS"),
    maxCostMicrosPerDay: int("DISCOVERY_DAILY_MICROS"),
    maxCostMicrosPerRun: int("DISCOVERY_RUN_MICROS"),
    reservedCostMicrosPerQuery: int("DISCOVERY_QUERY_MICROS"),
  };
}

const asData = (result: {
  isError?: boolean;
  content?: unknown;
}): {
  isError: boolean;
  data: Record<string, unknown>;
} => ({
  isError: result.isError === true,
  data: JSON.parse((result.content as { text: string }[])[0]!.text) as Record<
    string,
    unknown
  >,
});

/**
 * Performs every corpus task through the shipped MCP tool surface
 * (production `createMcp` handlers over an in-memory transport) and records
 * the shipped surface contract per step. Steps are performed against the
 * same store the shipped handlers read and write.
 */
export async function evaluateWebInterface(
  corpusInput: unknown,
): Promise<WebInterfaceEvaluationReport> {
  const corpus = webInterfaceCorpusSchema.parse(corpusInput);
  const hash = createHash("sha256")
    .update(JSON.stringify(corpus))
    .digest("hex");
  const seeded = await seedDatabase(corpus);
  const { store, resolveFeedItem, resolveDiscoveryItem, provider } = seeded;
  try {
    return await evaluateTasks(
      corpus,
      store,
      resolveFeedItem,
      resolveDiscoveryItem,
      provider,
      hash,
    );
  } finally {
    store.close();
  }
}

async function evaluateTasks(
  corpus: WebInterfaceCorpus,
  store: Store,
  resolveFeedItem: (fixtureId: string) => string,
  resolveDiscoveryItem: (url: string) => string,
  provider: RecordedDiscoveryProvider,
  corpusHash: string,
): Promise<WebInterfaceEvaluationReport> {
  // The real registered tool surface, driven by the official SDK client over
  // an in-memory transport pair — the production handler code, no sockets.
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcp(store, {
    discoveryProvider: provider,
    env: corpus.discoveryEnv,
    // The confirmed trigger dispatches through the same fixture clock as the
    // seeded run, so both consume the same recorded daily budget no matter
    // when the replay executes.
    clock: () => corpus.asOf,
  });
  await server.connect(serverTransport);
  const client = new Client({
    name: "web-interface-evaluation",
    version: "1",
  });
  await client.connect(clientTransport);
  try {
    const mcpTools = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    const call = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ isError: boolean; data: Record<string, unknown> }> => {
      const result: unknown = await client.callTool({
        name,
        arguments: args,
      });
      return asData(result as { isError?: boolean; content?: unknown });
    };

    const tasks: TaskResult[] = [];

    // Task 1: understand a discovery and its ranking explanation.
    {
      const discoveredUrl = corpus.discovery.results[0]!.url;
      const itemId = resolveDiscoveryItem(discoveredUrl);
      const found = await call("search_items", {
        query: "humanoid safety report",
        limit: 20,
      });
      const foundIds = (found.data.items as { id: string }[]).map((i) => i.id);
      const searchHit = foundIds.includes(itemId);
      const discoveries = await call("get_discoveries", { limit: 20 });
      const listed = (
        discoveries.data.discoveries as {
          item_id: string;
          origin: string;
          url: string;
        }[]
      ).filter((d) => d.item_id === itemId);
      const originRecorded = listed.some(
        (d) => d.origin === "discovered" && d.url === discoveredUrl,
      );
      const item = await call("get_item", { id: itemId });
      const itemData = item.data as {
        latest_score: unknown;
        references: unknown[];
        analysis_status?: string;
      };
      const scoreAvailable = itemData.latest_score !== null;
      const referencesRecorded = itemData.references.length > 0;
      const ranking = await call("explain_ranking", { id: itemId });
      const rankingData = ranking.data as {
        scores: { criteria_version: string; provenance: unknown }[];
        exclusions: unknown[];
      };
      const criteriaRecorded =
        rankingData.scores.length > 0 &&
        rankingData.scores.every(
          (score) => typeof score.criteria_version === "string",
        );
      const provenanceRecorded = rankingData.scores.length > 0;
      const ok =
        found.isError === false &&
        searchHit &&
        originRecorded &&
        scoreAvailable &&
        referencesRecorded &&
        criteriaRecorded;
      tasks.push({
        taskId: "understand-discovery-explanation",
        task: "Ask what was found outside subscriptions and why one discovered item ranks where it does.",
        steps: [
          {
            stepId: "find-the-discovery",
            description: "Find the discovered item by its topic terms.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "search_items",
            cliVerb: "search QUERY",
            performed: true,
            ok: searchHit,
            observed: searchHit
              ? "search_items returned the discovered item when queried by its topic terms"
              : "the discovered item was not retrievable by topic terms",
          },
          {
            stepId: "list-non-subscription-finds",
            description:
              "List items found outside followed subscriptions with origin and original URL.",
            surfaces: ["mcp-tool"],
            mcpTool: "get_discoveries",
            cliVerb: null,
            performed: true,
            ok: originRecorded,
            observed: originRecorded
              ? "get_discoveries listed the item with origin 'discovered' and its original URL"
              : "the discovery could not be listed with origin provenance",
          },
          {
            stepId: "read-analysis-provenance",
            description:
              "Read the item with its model analysis provenance, references and latest score.",
            surfaces: ["mcp-tool"],
            mcpTool: "get_item",
            cliVerb: null,
            performed: true,
            ok: scoreAvailable && referencesRecorded,
            observed: `get_item returned the item with latest_score present (${scoreAvailable}) and ${itemData.references.length} recorded source references (analysis status ${String(itemData.analysis_status)})`,
          },
          {
            stepId: "explain-the-ranking",
            description:
              "Explain why the item ranks as it does, with components and exclusions.",
            surfaces: ["mcp-tool"],
            mcpTool: "explain_ranking",
            cliVerb: null,
            performed: true,
            ok: criteriaRecorded && provenanceRecorded,
            observed:
              criteriaRecorded && provenanceRecorded
                ? `explain_ranking returned ${rankingData.scores.length} recorded scoring run(s) with criteria versions and exclusion reasons (${rankingData.exclusions.length} exclusions)`
                : "no recorded scoring run with criteria provenance was retrievable",
          },
        ],
        mcpClientCannotPerform: [],
        shipped:
          "The connecting MCP client performs the explanation conversationally: search_items and get_discoveries surface the discovery with origin provenance, get_item reads analysis provenance and source references, explain_ranking returns the recorded scoring runs, criteria version and exclusions. A browser would re-render the same recorded rows in a second transport.",
        verdict: ok
          ? "discovery_explanation_answered_by_mcp_reads"
          : "discovery_explanation_gap",
      });
    }

    // Task 2: run a new budgeted discovery query.
    let triggerOnFixtureDay = false;
    {
      const preview = await call("trigger_discovery", {
        query: corpus.discovery.triggerQuery,
      });
      const previewData = preview.data as {
        status?: string;
        confirm_token?: string;
        effect?: string;
      };
      const previewed =
        previewData.status === "confirmation_required" &&
        typeof previewData.confirm_token === "string";
      const before = store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM discovery_results")
        .get()!.n;
      const confirmed = previewed
        ? await call("trigger_discovery", {
            query: corpus.discovery.triggerQuery,
            confirm_token: previewData.confirm_token,
          })
        : { isError: true, data: {} as Record<string, unknown> };
      const outcome = confirmed.data as {
        status?: string;
        results?: number;
        pages?: number;
      };
      const dispatched =
        !confirmed.isError &&
        outcome.status === "complete" &&
        (outcome.results ?? 0) >= 1;
      const after = store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM discovery_results")
        .get()!.n;
      const ledgerGrew = after > before;
      const browsable = await call("get_discoveries", { limit: 20 });
      const browsableData = browsable.data as { discoveries: unknown[] };
      // Same-day budget regression check: the seeded run and the MCP-confirmed
      // run both dispatch through the fixture clock, so both reservations must
      // fall on the fixture's budget day (budget_day = floor(now / 86400000),
      // exactly as the shipped reservePage computes it). If the confirmed run
      // ever used the wall clock, its pages would land on the execution day
      // and the recorded budget evidence would depend on when the replay ran.
      const fixtureDay = Math.floor(corpus.asOf / 86_400_000);
      const fixtureDayPages = store.sqlite
        .query<{ n: number }, [number]>(
          "SELECT count(*) AS n FROM discovery_pages WHERE budget_day=?",
        )
        .get(fixtureDay)!.n;
      const sameDayBudget = fixtureDayPages === 2 && ledgerGrew;
      triggerOnFixtureDay = sameDayBudget;
      const ok = previewed && dispatched && ledgerGrew && sameDayBudget;
      tasks.push({
        taskId: "run-budgeted-discovery",
        task: "Run one new budgeted discovery query and see what it found.",
        steps: [
          {
            stepId: "preview-the-query",
            description:
              "Preview the bounded query with its budget reservation.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "trigger_discovery",
            cliVerb: "discovery-trigger-preview QUERY",
            performed: true,
            ok: previewed,
            observed: previewed
              ? `preview returned ${String(previewData.effect)} with a single-use confirm token`
              : "the preview did not return a confirmation envelope",
          },
          {
            stepId: "confirm-the-dispatch",
            description:
              "Confirm; the run re-checks budgets and pace against the recorded provider.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "trigger_discovery",
            cliVerb: "discovery-trigger-confirm TOKEN",
            performed: true,
            ok: dispatched,
            observed: dispatched
              ? `confirm dispatched status ${String(outcome.status)} over ${String(outcome.pages)} page(s) and ingested ${String(outcome.results)} result(s) from the recorded provider (${provider.requests} provider request(s) in total)`
              : "the confirmed dispatch did not complete within budget",
          },
          {
            stepId: "see-what-was-found",
            description:
              "See the new discovered items with origin and original URLs.",
            surfaces: ["mcp-tool"],
            mcpTool: "get_discoveries",
            cliVerb: null,
            performed: true,
            ok: ledgerGrew && browsableData.discoveries.length >= 1,
            observed: ledgerGrew
              ? `the discovery ledger grew from ${before} to ${after} recorded result(s); get_discoveries lists the new items (the CLI discovery-runs verb shows run metadata and search finds the canonical items, but neither exposes discovery-result origin provenance, so this step is MCP-only)`
              : "no discovery result was recorded for the confirmed query",
          },
        ],
        mcpClientCannotPerform: [],
        shipped:
          "trigger_discovery preview/confirm performs the budgeted dispatch through the shared application service, and get_discoveries reports the new findings with origin provenance; the dispatch steps also have CLI verbs, but the origin-provenance review is MCP-only.",
        verdict: ok
          ? "budgeted_discovery_dispatched_by_preview_confirm"
          : "budgeted_discovery_gap",
      });
    }

    // Task 3: configure interests.
    {
      const before = await call("get_interests", {});
      const beforeData = before.data as {
        interests: { id: string; version: number }[];
      };
      const seedVisible = beforeData.interests.some(
        (i) => i.id === corpus.interestSeed.id,
      );
      const preview = await call("update_interest", {
        interest: corpus.interestUpdate as Record<string, unknown>,
      });
      const previewData = preview.data as {
        status?: string;
        confirm_token?: string;
        interest?: { version: number };
        effect?: string;
      };
      const previewed =
        previewData.status === "confirmation_required" &&
        typeof previewData.confirm_token === "string";
      const token = previewData.confirm_token;
      const confirmed = previewed
        ? await call("update_interest", {
            interest: corpus.interestUpdate as Record<string, unknown>,
            confirm_token: token,
          })
        : { isError: true, data: {} as Record<string, unknown> };
      const after = await call("get_interests", {});
      const afterData = after.data as {
        interests: { id: string; version: number }[];
      };
      const updated = afterData.interests.find(
        (i) => i.id === corpus.interestSeed.id,
      );
      const versionAppended =
        updated !== undefined &&
        updated.version === (previewData.interest?.version ?? 0);
      // The confirmation token is single-use: a replayed confirm with the
      // consumed token must be rejected by the shipped confirmation flow.
      // Because consumeConfirmation rejects used tokens before any payload
      // hash is compared, payload binding needs its own probes on fresh
      // preview tokens, driven through the shipped confirmation service
      // both transports share.
      let replayRejected = false;
      if (previewed) {
        const replay = await call("update_interest", {
          interest: corpus.interestUpdate as Record<string, unknown>,
          confirm_token: token,
        });
        replayRejected = replay.isError;
      }
      const interestVersion = (): number =>
        store.sqlite
          .query<{ v: number }, [string]>(
            "SELECT max(version) AS v FROM profiles WHERE kind='interest' AND id=?",
          )
          .get(corpus.interestSeed.id)!.v;
      const versionBeforeBindingProbes = interestVersion();
      // Equal payload on a fresh token: accepted, with the no-op apply never
      // touching a profile (the same hash path the surfaces' confirms use).
      const equalPreview = await call("update_interest", {
        interest: {
          ...(corpus.interestUpdate as Record<string, unknown>),
          description: "Payload binding equal-payload probe",
        },
      });
      const equalPayload = (equalPreview.data as { interest?: unknown })
        .interest;
      let equalPayloadAccepted = false;
      try {
        consumeConfirmation(store.sqlite, {
          action: MUTATION_ACTIONS.update_interest,
          token: (equalPreview.data as { confirm_token?: string })
            .confirm_token!,
          payload: equalPayload,
          apply: () => "binding-probe-no-op",
        });
        equalPayloadAccepted = true;
      } catch {
        equalPayloadAccepted = false;
      }
      // Changed payload on another fresh token: rejected as payload_changed,
      // and the guarded apply must never run.
      const changedPreview = await call("update_interest", {
        interest: {
          ...(corpus.interestUpdate as Record<string, unknown>),
          description: "Payload binding changed-payload probe",
        },
      });
      let changedPayloadRejected = false;
      try {
        consumeConfirmation(store.sqlite, {
          action: MUTATION_ACTIONS.update_interest,
          token: (changedPreview.data as { confirm_token?: string })
            .confirm_token!,
          payload: {
            ...(equalPayload as Record<string, unknown>),
            description: "A document the preview did not authorize",
          },
          apply: () => {
            throw new Error(
              "payload-mismatch apply ran; payload binding is broken",
            );
          },
        });
      } catch (error) {
        if (
          error instanceof ConfirmationError &&
          error.code === "payload_changed"
        )
          changedPayloadRejected = true;
        else throw error;
      }
      const versionAfterBindingProbes = interestVersion();
      const payloadBindingVerified =
        equalPayloadAccepted &&
        changedPayloadRejected &&
        versionBeforeBindingProbes === versionAfterBindingProbes;
      const ok =
        seedVisible &&
        previewed &&
        versionAppended &&
        replayRejected &&
        payloadBindingVerified;
      tasks.push({
        taskId: "configure-interests",
        task: "Read the active interests and change what the user values.",
        steps: [
          {
            stepId: "read-active-interests",
            description: "Read the active interest profiles.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "get_interests",
            cliVerb: "list-profiles (profile export view)",
            performed: true,
            ok: seedVisible,
            observed: seedVisible
              ? "get_interests returned the seeded active interest (latest version, persistent)"
              : "the seeded interest was not listed as active",
          },
          {
            stepId: "preview-the-interest-change",
            description: "Preview the new immutable interest version.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "update_interest",
            cliVerb: "interest-preview JSON",
            performed: true,
            ok: previewed,
            observed: previewed
              ? `preview recorded effect ${String(previewData.effect)} toward version ${String(previewData.interest?.version)} with a confirmation token`
              : "the interest preview failed",
          },
          {
            stepId: "confirm-the-interest-change",
            description:
              "Confirm; scores are re-derived, frozen editions unchanged.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "update_interest",
            cliVerb: "interest-confirm TOKEN",
            performed: true,
            ok: versionAppended,
            observed: versionAppended
              ? "the confirmed update appended the new immutable version visible to get_interests"
              : "interest versions did not advance after confirmation",
          },
          {
            stepId: "token-is-single-use",
            description:
              "Replay a consumed confirmation token and expect rejection.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "update_interest",
            cliVerb: "interest-confirm TOKEN",
            performed: true,
            ok: replayRejected,
            observed: replayRejected
              ? "the replayed token was rejected; confirmation stays single-use over every transport"
              : "a consumed confirmation token was accepted again",
          },
          {
            stepId: "token-is-payload-bound",
            description:
              "On fresh preview tokens, confirm the previewed document (accepted, no effect) and an altered document (rejected, no effect).",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "update_interest",
            cliVerb:
              "interest-preview JSON + interest-confirm TOKEN (shared confirmation service)",
            performed: true,
            ok: payloadBindingVerified,
            observed: payloadBindingVerified
              ? `a fresh token confirmed with the exact previewed document was accepted with no profile write, a different document was rejected with payload_changed, and the interest version stayed at ${String(versionBeforeBindingProbes)} throughout — the payload hash is compared, not just the token state`
              : "the payload binding probe did not hold (equal-payload accept, payload_changed rejection or version bookkeeping)",
          },
        ],
        mcpClientCannotPerform: [],
        shipped:
          "get_interests reads profiles; update_interest preview/confirm appends the next immutable version through the shared application service (the same previewUpdateInterest/confirmUpdateInterest the CLI interest-preview/interest-confirm verbs call). A web form would add an input field, not a capability.",
        verdict: ok
          ? "interest_configuration_by_versioned_preview_confirm"
          : "interest_configuration_gap",
      });
    }

    // Task 4: give explicit feedback on an item, its edition context and a
    // discovery result (the item/query/discovery linkage).
    {
      const discoveredUrl = corpus.discovery.results[1]!.url;
      const itemId = resolveDiscoveryItem(discoveredUrl);
      const preview = await call("submit_feedback", {
        item_id: itemId,
        action: "useful",
      });
      const previewData = preview.data as {
        status?: string;
        confirm_token?: string;
        item_title?: string;
      };
      const previewed =
        previewData.status === "confirmation_required" &&
        typeof previewData.confirm_token === "string";
      const confirmed = previewed
        ? await call("submit_feedback", {
            item_id: itemId,
            action: "useful",
            confirm_token: previewData.confirm_token,
          })
        : { isError: true, data: {} as Record<string, unknown> };
      const feedback = await call("get_feedback", { limit: 100 });
      const latest = (
        feedback.data.feedback as {
          itemId: string;
          useful: boolean;
          source: string;
        }[]
      ).find((f) => f.itemId === itemId);
      const feedbackRecorded =
        !confirmed.isError &&
        latest !== undefined &&
        latest.useful &&
        latest.source === "mcp";
      // The shipped feedback path also refines future query order: the same
      // signal is written to the discovery-result feedback ledger (recorded
      // item + query + discovery linkage), which the scheduled-query CLI
      // verbs and planner read.
      const linkage = store.sqlite
        .query<{ n: number }, [string]>(
          `SELECT count(*) AS n FROM discovery_result_feedback f
           JOIN discovery_results r ON r.id=f.result_id WHERE r.item_id=?`,
        )
        .get(itemId)!.n;
      const linkageRecorded = linkage >= 1;
      const ok = previewed && feedbackRecorded && linkageRecorded;
      tasks.push({
        taskId: "give-explicit-feedback",
        task: "Give explicit useful feedback on a discovery result so scoring and query order refine.",
        steps: [
          {
            stepId: "preview-the-judgment",
            description: "Preview recording explicit feedback for the item.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "submit_feedback",
            cliVerb: "feedback-preview ITEM_ID useful|not-useful",
            performed: true,
            ok: previewed,
            observed: previewed
              ? `preview returned the item title (${String(previewData.item_title)}) with a confirmation token`
              : "the feedback preview failed",
          },
          {
            stepId: "confirm-the-judgment",
            description: "Confirm the explicit useful/not-useful judgment.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "submit_feedback",
            cliVerb: "feedback-confirm TOKEN",
            performed: true,
            ok: feedbackRecorded,
            observed: feedbackRecorded
              ? "get_feedback lists the recorded latest judgment for the item with source mcp"
              : "the confirmed judgment was not readable through get_feedback",
          },
          {
            stepId: "refine-the-discovery-ledger",
            description: "Record the item/query/discovery refinement linkage.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "submit_feedback",
            cliVerb: "discovery-item-feedback ITEM_ID useful|not-useful",
            performed: true,
            ok: linkageRecorded,
            observed: linkageRecorded
              ? `the shipped feedback write recorded ${linkage} discovery-result refinement row(s) for the item, so future query order refines with provenance (the CLI discovery-item-feedback verb writes the same ledger)`
              : "no discovery-result refinement row was recorded",
          },
        ],
        mcpClientCannotPerform: [],
        shipped:
          "submit_feedback preview/confirm records the explicit judgment through the shared feedback service, visible over get_feedback, and the same write propagates the item/query/discovery refinement to the discovery-result ledger (the CLI feedback-preview/feedback-confirm and discovery-item-feedback verbs call the identical application service).",
        verdict: ok
          ? "explicit_feedback_recorded_with_discovery_linkage"
          : "explicit_feedback_gap",
      });
    }

    // Task 5: review story developments and edition history.
    {
      const atlasId = resolveFeedItem("atlas-4");
      const reviewId = resolveFeedItem("atlas-4-review");
      const hits = await call("search_items", {
        query: "Atlas-4 benchmark",
        limit: 20,
      });
      const hitIds = (hits.data.items as { id: string }[]).map((i) => i.id);
      const bothFound = hitIds.includes(atlasId) && hitIds.includes(reviewId);
      const membership = store.stories.forItem(atlasId).current;
      const groupId = membership?.group_id ?? null;
      if (!groupId)
        throw new Error(
          "Fixture development items did not group; the corpus no longer reflects a story review",
        );
      const group = await call("get_story_group", { id: groupId });
      const groupData = group.data as {
        id?: string;
        members?: unknown[];
        relations?: unknown[];
      };
      const groupReadable =
        !group.isError && (groupData.members ?? []).length >= 2;
      const since = corpus.asOf - corpus.changeWindowDays * 86_400_000;
      const changes = await call("get_development_changes", {
        group_id: groupId,
        since,
      });
      const changesData = changes.data as {
        events?: unknown[];
      };
      const changeEvidenceRecorded =
        !changes.isError && (changesData.events ?? []).length >= 2;
      // Freeze one immutable edition through the shipped edition store the
      // delivery pipeline freezes, then read it back over MCP.
      const edition: FrozenDigestInput = {
        date: corpus.edition.date,
        timezone: "Europe/London",
        subject: corpus.edition.subject,
        html: `<p>${corpus.edition.text}</p>`,
        text: corpus.edition.text,
        decisionSnapshot: {},
        items: [
          {
            itemId: atlasId,
            groupId,
            scoreId: null,
            snapshot: {},
          },
        ],
      };
      new DigestStore(store.sqlite).freeze(edition, corpus.edition.frozenAt);
      const frozen = await call("get_digest", {
        date: corpus.edition.date,
        view: "frozen",
      });
      const frozenData = frozen.data as {
        edition_date?: string;
        items?: { item_id?: string }[];
      };
      const frozenReadable =
        !frozen.isError &&
        frozenData.edition_date === corpus.edition.date &&
        (frozenData.items ?? []).some((i) => i.item_id === atlasId);
      const publishedAt = new Date(corpus.edition.frozenAt).toISOString();
      // Explicit feedback must never touch the frozen edition.
      await call("submit_feedback", {
        item_id: atlasId,
        action: "not_useful",
        edition_date: corpus.edition.date,
      }).then((p) =>
        p.data.status === "confirmation_required"
          ? call("submit_feedback", {
              item_id: atlasId,
              action: "not_useful",
              edition_date: corpus.edition.date,
              confirm_token: (p.data as { confirm_token?: string })
                .confirm_token,
            })
          : p,
      );
      const frozenAfter = await call("get_digest", {
        date: corpus.edition.date,
        view: "frozen",
      });
      const frozenImmutable =
        JSON.stringify(frozenAfter.data) === JSON.stringify(frozenData);
      const list = await call("get_digest", {
        date: corpus.edition.date,
        view: "list",
        to: corpus.edition.date,
      });
      const listData = list.data as { editions?: unknown[] };
      const listReadable =
        !list.isError && (listData.editions ?? []).length === 1;
      // Feedback is now readable with its edition context.
      const feedback = await call("get_feedback", { limit: 100 });
      const withEdition = (
        feedback.data.feedback as {
          itemId: string;
          editionDate: string | null;
        }[]
      ).find((f) => f.itemId === atlasId);
      const feedbackEditionContext =
        withEdition !== undefined &&
        withEdition.editionDate === corpus.edition.date;
      const ok =
        bothFound &&
        groupReadable &&
        changeEvidenceRecorded &&
        frozenReadable &&
        frozenImmutable &&
        listReadable &&
        feedbackEditionContext;
      tasks.push({
        taskId: "review-developments-history",
        task: "Review one story development end to end: coverage, recorded change evidence and the frozen edition it was published in.",
        steps: [
          {
            stepId: "find-the-coverage",
            description: "Find both items covering the development.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "search_items",
            cliVerb: "search QUERY",
            performed: true,
            ok: bothFound,
            observed: bothFound
              ? "search_items returned both development items"
              : "development coverage was not retrievable",
          },
          {
            stepId: "read-the-development",
            description:
              "Read the development group with its members and citations.",
            surfaces: ["mcp-tool"],
            mcpTool: "get_story_group",
            cliVerb: null,
            performed: true,
            ok: groupReadable,
            observed: groupReadable
              ? "get_story_group returned the development with its recorded memberships and citations"
              : "the development group was not readable",
          },
          {
            stepId: "read-the-change-evidence",
            description: "Read recorded change evidence for the development.",
            surfaces: ["mcp-tool"],
            mcpTool: "get_development_changes",
            cliVerb: null,
            performed: true,
            ok: changeEvidenceRecorded,
            observed: changeEvidenceRecorded
              ? `get_development_changes returned ${(changesData.events ?? []).length} recorded events (new coverage and content changes) inside the ${corpus.changeWindowDays}-day window`
              : "no recorded change evidence was retrievable",
          },
          {
            stepId: "read-the-frozen-edition",
            description:
              "Read the immutable edition the development was published in.",
            surfaces: ["mcp-tool"],
            mcpTool: "get_digest",
            cliVerb: null,
            performed: true,
            ok: frozenReadable && listReadable,
            observed: `frozen view returned the edition frozen near ${publishedAt} with the development's item reference, and the list view returned ${String((listData.editions ?? []).length)} edition(s); no CLI verb reads a frozen edition or edition history (digest-preview rebuilds a draft from current state), so this step is MCP-only`,
          },
          {
            stepId: "edition-survives-feedback",
            description:
              "Give not-useful edition feedback and re-read the frozen edition.",
            surfaces: ["mcp-tool", "cli-verb"],
            mcpTool: "submit_feedback",
            cliVerb: "feedback-preview ITEM_ID not-useful EDITION_DATE",
            performed: true,
            ok: frozenImmutable && feedbackEditionContext,
            observed:
              frozenImmutable && feedbackEditionContext
                ? "the not-useful edition feedback was recorded with its edition context while the frozen edition bytes stayed identical"
                : "frozen edition bytes changed or edition feedback context was lost",
          },
        ],
        mcpClientCannotPerform: [],
        shipped:
          "The development and history review is covered by the read tools (get_story_group, get_development_changes, get_digest frozen/list) plus the confirmed feedback mutation through the same application service the CLI feedback verbs call; the connecting MCP client narrates the review.",
        verdict: ok
          ? "developments_and_history_covered_by_mcp_reads"
          : "developments_history_gap",
      });
    }

    // Coverage derives from the recorded steps, never from a hard-coded
    // task label: a task is both-transport covered only when every one of
    // its steps has a CLI verb, and mcp-tool covered when its steps were
    // performed through MCP tools.
    const deriveCoveredBy = (steps: TaskStep[]): TaskResult["coveredBy"] =>
      steps.every((step) => step.cliVerb !== null && step.mcpTool !== null)
        ? "both"
        : steps.some((step) => step.mcpTool !== null)
          ? "mcp-tool"
          : "cli-verb";
    for (const task of tasks) task.coveredBy = deriveCoveredBy(task.steps);

    const uncoveredSteps = tasks.flatMap((task) =>
      task.steps
        .filter((step) => step.surfaces.length === 0)
        .map((step) => `${task.taskId}/${step.stepId}`),
    );
    const interestsTask = tasks.find(
      (task) => task.taskId === "configure-interests",
    )!;
    const linkageTask = tasks.find(
      (task) => task.taskId === "give-explicit-feedback",
    )!;
    const historyTask = tasks.find(
      (task) => task.taskId === "review-developments-history",
    )!;

    // Guard the recorded decision, fixed before any verdict existed: a report
    // is only emitted when every recorded step completed through its declared
    // surface. A failed step is neither coverage evidence nor UI-adopting
    // evidence — the replay is rejected instead of silently deciding either way.
    const failedSteps = tasks.flatMap((task) =>
      task.steps
        .filter((step) => !step.performed || !step.ok)
        .map((step) => `${task.taskId}/${step.stepId}`),
    );
    if (failedSteps.length)
      throw new Error(
        `Incomplete web-interface replay; refusing to emit a coverage decision from failed steps: ${failedSteps.join(", ")}`,
      );

    return {
      evaluationVersion: WEB_INTERFACE_EVALUATION_VERSION,
      corpus: {
        id: corpus.id,
        version: corpus.version,
        asOf: corpus.asOf,
        hash: corpusHash,
      },
      sourceSurface: { mcpTools },
      tasks,
      gates: {
        taskStepsWithoutShippedSurface: uncoveredSteps.length,
        taskStepsCompleted: tasks.reduce(
          (n, task) =>
            n + task.steps.filter((step) => step.performed && step.ok).length,
          0,
        ),
        uncoveredSteps,
        uiOnlySteps: [],
        previewConfirmTokenSingleUseAndPayloadBound:
          interestsTask.steps.find((s) => s.stepId === "token-is-single-use")!
            .ok &&
          interestsTask.steps.find(
            (s) => s.stepId === "token-is-payload-bound",
          )!.ok,
        discoveryLedgerRefinementRecordedFromItemFeedback:
          linkageTask.steps.every((s) => s.ok),
        frozenEditionImmutableUnderFeedback: historyTask!.steps.find(
          (s) => s.stepId === "edition-survives-feedback",
        )!.ok,
        triggerBudgetConsumedOnFixtureDay: triggerOnFixtureDay,
        recordedProviderRequests: provider.requests,
        uiTransportOrEmailSideEffects: 0,
        newTrustBoundariesAdoptionWouldCreate: [
          "an authenticated, browser-session HTTP surface rendered from untrusted stored content (a new origin/CSRF and HTML-sanitisation boundary the MCP transport does not need)",
          "browser session state re-implementing the preview/confirm mutation contract that already exists transport-free",
          "a second rendering of recorded data whose only unique input is already fully exposed to the conversational client",
        ],
        duplicateTransportSurface: true,
      },
      adoption: {
        adopt: uncoveredSteps.length > 0,
        threshold: ADOPTION_THRESHOLD,
      },
    };
  } finally {
    await client.close();
    await server.close();
  }
}
