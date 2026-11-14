import { createHash } from "node:crypto";
import { z } from "zod";
import { Store } from "./db/store";
import { purgeItemFeedText } from "./db/retention-store";
import { developmentChanges, CHANGE_EVIDENCE_VERSION } from "./dev-changes";
import { STORY_RULE_VERSION } from "./story-grouping";

/**
 * Historical development comparison evaluation (issue #26). Replays a
 * realistic multi-week corpus — corrections, unchanged repeat coverage,
 * genuinely new developments, a broad-topic decoy, a missing report date and
 * content expired under retention — through the shipped store only, and
 * compares today's baseline composition of read surfaces (`search_items`
 * plus story/get_item reads) against the recorded change-evidence read for a
 * recorded "what changed since last week?" query set. No provider calls;
 * unknown values are recorded as unknown, never zero.
 */

export const HISTORY_COMPARISON_EVALUATION_VERSION =
  "history-comparison-evaluation-v1";

const DAY_MS = 86_400_000;

const observationSchema = z.strictObject({
  observedAt: z.number().int().safe(),
  title: z.string().min(1).max(1000),
  text: z.string().max(100000),
  /** Per-observation source-declared report date; null when undeclared. */
  publishedAt: z.number().int().safe().nullable(),
});

const expectationSchema = z.enum([
  /** A claimed change (retraction/correction/updated figures). */
  "meaningful_update",
  /** New coverage of a development or a genuinely new development. */
  "new_coverage",
  /** More coverage whose story itself did not change. */
  "no_update",
  /** Broad-topic decoy about the same space, a different development. */
  "decoy",
]);

const itemSchema = z.strictObject({
  id: z.string().min(1).max(200),
  url: z.string().min(1).max(8192),
  sourceId: z.string().min(1).max(200),
  nativeId: z.string().min(1).max(200),
  development: z.string().min(1).max(200).nullable(),
  /** Development anchor declared per query, not by item order. */
  publishedAt: z.number().int().safe().nullable(),
  expectation: expectationSchema,
  missingReportDate: z.boolean().optional(),
  /** The item's content expires under the recorded retention policy. */
  expiredDetail: z.boolean().optional(),
  observations: z.array(observationSchema).min(1).max(10),
});

const querySchema = z.strictObject({
  id: z.string().min(1).max(100),
  terms: z.string().min(1).max(500),
  development: z.string().min(1).max(200),
  /** The fixture item whose story group anchors the development. */
  anchorItemId: z.string().min(1).max(200),
});

export const historyComparisonCorpusSchema = z
  .strictObject({
    version: z.number().int().positive(),
    id: z.string().min(1),
    asOf: z.number().int().safe(),
    windowDays: z.number().int().min(1).max(365),
    notes: z.string().max(2000),
    sources: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(200),
          url: z.string().min(1).max(8192),
          title: z.string().min(1).max(500),
        }),
      )
      .min(1)
      .max(20),
    items: z.array(itemSchema).min(1).max(200),
    queries: z.array(querySchema).min(1).max(50),
  })
  .superRefine((corpus, context) => {
    const ids = new Set(corpus.items.map((item) => item.id));
    if (ids.size !== corpus.items.length)
      context.addIssue({ code: "custom", message: "Item IDs must be unique" });
    for (const query of corpus.queries)
      if (!ids.has(query.anchorItemId))
        context.addIssue({
          code: "custom",
          message: `Query ${query.id} anchors unknown item ${query.anchorItemId}`,
        });
  });

export type HistoryComparisonCorpus = z.infer<
  typeof historyComparisonCorpusSchema
>;

export interface HistoryComparisonDatabase {
  store: Store;
  /** Canonical item id for a fixture item id. */
  resolve: (fixtureItemId: string) => string;
}

/**
 * Populates a throwaway database with the exact production schema by polling
 * recorded waves through the shipped ingest path (items, content_versions,
 * processing jobs, story groups), settles all derived work deterministically
 * without providers, and replays the recorded retention outcome for the
 * labeled expired items using the shipped purge path.
 */
export function createHistoryComparisonDatabase(
  corpus: HistoryComparisonCorpus,
  path: string = ":memory:",
): HistoryComparisonDatabase {
  const store = new Store(path);
  const sources = new Map(
    corpus.sources.map((source) => {
      const added = store.addSource(source.url, source.title);
      return [source.id, added] as const;
    }),
  );

  // The ingest path assigns canonical UUIDs; map fixture item ids to them via
  // the recorded canonical identity (fixture URLs carry no tracking params).
  const identityOf = (item: HistoryComparisonCorpus["items"][number]) =>
    "url:" + canonicalItemUrl(item.url);
  const itemIds = new Map<string, string>();
  const resolve = (fixtureItemId: string): string => {
    const resolved = itemIds.get(fixtureItemId);
    if (!resolved) throw new Error(`Unknown fixture item ${fixtureItemId}`);
    return resolved;
  };

  const waves = [
    ...new Set(
      corpus.items.flatMap((item) =>
        item.observations.map((o) => o.observedAt),
      ),
    ),
  ].sort((a, b) => a - b);
  const feed = (
    entries: {
      nativeId: string;
      title: string;
      text: string;
      url?: string;
      publishedAt?: number;
    }[],
  ) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${entries
      .map(
        (entry) =>
          `<item><guid>${entry.nativeId}</guid><title>${entry.title}</title>${
            entry.url ? `<link>${entry.url}</link>` : ""
          }<description><![CDATA[${entry.text}]]></description>${
            entry.publishedAt !== undefined
              ? `<pubDate>${new Date(entry.publishedAt).toUTCString()}</pubDate>`
              : ""
          }</item>`,
      )
      .join("")}</channel></rss>`;

  const itemsBySource = new Map<string, HistoryComparisonCorpus["items"]>();
  for (const item of corpus.items) {
    itemsBySource.set(item.sourceId, [
      ...(itemsBySource.get(item.sourceId) ?? []),
      item,
    ]);
  }

  for (const wave of waves) {
    for (const [sourceId, items] of itemsBySource) {
      const source = sources.get(sourceId);
      if (!source) throw new Error(`Unknown fixture source ${sourceId}`);
      const entries = items.flatMap((item) => {
        const observation = item.observations.find(
          (o) => o.observedAt === wave,
        );
        if (!observation) return [];
        return [
          {
            nativeId: item.nativeId,
            title: observation.title,
            text: observation.text,
            url: item.url,
            publishedAt: observation.publishedAt ?? undefined,
          },
        ];
      });
      if (!entries.length) continue;
      store.enqueueDue(wave, true);
      let job = store.claim(wave);
      while (job && job.source_id !== source.id) {
        store.complete(job, { items: [] }, wave);
        job = store.claim(wave);
      }
      if (!job) throw new Error(`No poll job for fixture source ${sourceId}`);
      store.complete(
        job,
        {
          items: entries.map((entry) => ({
            nativeId: entry.nativeId,
            url: entry.url,
            title: entry.title,
            text: entry.text,
            publishedAt: entry.publishedAt,
          })),
        },
        wave + 1000,
      );
    }
    // Group each wave with production planning so memberships and their
    // audit trail match shipped behavior at every point in time.
    store.stories.reconcile(wave);
  }
  for (const item of corpus.items) {
    const id = store.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM items WHERE identity=?")
      .get(identityOf(item))?.id;
    if (!id) throw new Error(`Fixture item ${item.id} was never ingested`);
    itemIds.set(item.id, id);
  }

  // Settle all derived work deterministically (no providers) so the recorded
  // retention state is reachable, exactly as an operator's database would be.
  settleAll(store, waves[waves.length - 1]! + 2000);

  // Replay the recorded retention outcome for the labeled expired items with
  // the shipped purge path (fingerprints, tombstones, audit, FTS rebuild).
  for (const item of corpus.items)
    if (item.expiredDetail)
      purgeItemFeedText(store.sqlite, resolve(item.id), corpus.asOf);
  return { store, resolve };
}

function settleAll(store: Store, now: number): void {
  const stages = [
    ["extract", "extracted"],
    ["group", "grouped"],
    ["analyse", "analysed"],
    ["score", "scored"],
  ] as const;
  for (;;) {
    let progressed = false;
    for (const [stage, outcome] of stages) {
      for (;;) {
        const job = store.claimProcessing(stage, now);
        if (!job) break;
        const result =
          stage === "extract"
            ? JSON.stringify({ status: "extracted", text: "" })
            : null;
        if (!store.completeProcessing(job, outcome, now, result)) break;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
}

function canonicalItemUrl(value: string): string {
  const u = new URL(value);
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (/^utm_|^(fbclid|gclid)$/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href;
}

interface LabeledUpdates {
  updateItemIds: string[];
  coverageItemIds: string[];
  unchangedItemIds: string[];
  decoyItemIds: string[];
  unknownDateItemIds: string[];
  expiredItemIds: string[];
}

function labels(
  corpus: HistoryComparisonCorpus,
  resolve: (fixtureItemId: string) => string,
): Map<string, LabeledUpdates> {
  const byDevelopment = new Map<string, LabeledUpdates>();
  const forDev = (development: string) => {
    let entry = byDevelopment.get(development);
    if (!entry)
      byDevelopment.set(
        development,
        (entry = {
          updateItemIds: [],
          coverageItemIds: [],
          unchangedItemIds: [],
          decoyItemIds: [],
          unknownDateItemIds: [],
          expiredItemIds: [],
        }),
      );
    return entry;
  };
  for (const item of corpus.items) {
    if (item.development) {
      const entry = forDev(item.development);
      if (item.expectation === "meaningful_update")
        entry.updateItemIds.push(resolve(item.id));
      if (item.expectation === "new_coverage")
        entry.coverageItemIds.push(resolve(item.id));
      if (item.expectation === "no_update")
        entry.unchangedItemIds.push(resolve(item.id));
      if (item.expectation === "decoy")
        entry.decoyItemIds.push(resolve(item.id));
      if (item.missingReportDate)
        entry.unknownDateItemIds.push(resolve(item.id));
      if (item.expiredDetail) entry.expiredItemIds.push(resolve(item.id));
    }
  }
  return byDevelopment;
}

export interface BaselineHit {
  /** Canonical item id. */
  itemId: string;
  ingestedAt: number;
  /** Report date if the source declared one, else the ingestion fallback the baseline would display. */
  displayedTimelineDate: number;
  displayedDateUnknown: boolean;
  groupId: string | null;
  /** No shipped read surface classifies claimed updates versus repeats. */
  evidenceClassification: "unavailable";
  detailAvailable: boolean;
}

export interface BaselineQueryAnswer {
  queryId: string;
  development: string;
  hits: BaselineHit[];
}

export interface AdoptedEvent {
  id: number;
  kind: string;
  itemId: string;
  reportedAt: number | null;
  eventAt: number | null;
  observedAt: number;
  detailAvailable: boolean;
  classifiedAs: "claimed_update" | "new_coverage" | "grouping_correction";
  evidence: unknown;
}

export interface AdoptedQueryAnswer {
  queryId: string;
  development: string;
  groupId: string | null;
  events: AdoptedEvent[];
  coverage: { currentMembers: number; membersWithoutChangeEvidence: number };
}

export interface ComparisonMetric {
  numerator: number;
  denominator: number;
  value: number | null;
}

function ratio(numerator: number, denominator: number): ComparisonMetric {
  return {
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
  };
}

export interface HistoryComparisonReport {
  evaluation: { id: string; version: string };
  corpus: {
    id: string;
    version: number;
    asOf: number;
    items: number;
    hash: string;
  };
  config: {
    windowDays: number;
    window: { since: number; until: number };
    groupingVersion: string;
    changeEvidenceVersion: string;
    labelledDevelopments: string[];
  };
  arms: {
    baseline: {
      description: string;
      methodology: string;
      perQuery: BaselineQueryAnswer[];
      metrics: {
        updateRecall: ComparisonMetric;
        /** Window hits presented as changes that are not labeled updates. */
        presentedWithoutEvidence: number;
        /** Distinct unknown-date items the baseline re-dates from ingestion. */
        inventedChronology: string[];
        expiredUpdatesRetrievable: ComparisonMetric;
        coverageRecall: ComparisonMetric;
      };
    };
    adopted: {
      description: string;
      methodology: string;
      perQuery: AdoptedQueryAnswer[];
      metrics: {
        updateRecall: ComparisonMetric;
        /** Claimed-update classifications contradicted by labels. */
        updateFalsePositives: string[];
        /** Unknown report dates surfaced as unknown, never re-dated. */
        inventedChronology: string[];
        expiredUpdatesRetrievable: ComparisonMetric;
        coverageRecall: ComparisonMetric;
      };
    };
  };
  adoption: {
    adopted: boolean;
    threshold: string;
    reason: string;
    summary: string;
  };
  usage: {
    providerCalls: 0;
    cost: null;
    costPerUpdate: { value: null; note: string };
  };
  latencyMs: null;
  latencyReason: string;
}

/**
 * The baseline arm answers "what changed since last week?" exactly as a
 * connecting agent composes today's documented read surfaces: one windowed
 * `search_items` call per development (the shipped `since`/`until` window
 * applies to `items.ingested_at`), then `get_item` reads for each hit. The
 * composition is recorded, not invented by this evaluation.
 */
function baselineArm(
  store: Store,
  corpus: HistoryComparisonCorpus,
  resolve: (fixtureItemId: string) => string,
  reverse: Map<string, string>,
  since: number,
): {
  perQuery: BaselineQueryAnswer[];
  metrics: HistoryComparisonReport["arms"]["baseline"]["metrics"];
} {
  const perQuery: BaselineQueryAnswer[] = [];
  let updateHits = 0;
  let presentedWithoutEvidence = 0;
  const invented = new Set<string>();
  let coverageHits = 0;
  for (const query of corpus.queries) {
    const results = store.search(query.terms, 20, undefined, since, 0, {
      until: corpus.asOf,
    });
    const hits: BaselineHit[] = results.map((hit) => {
      const item = store.getItem(hit.id)!;
      if (item.published_at === null)
        invented.add(reverse.get(hit.id) ?? hit.id);
      return {
        itemId: reverse.get(hit.id) ?? hit.id,
        ingestedAt: hit.ingested_at,
        displayedTimelineDate: item.published_at ?? hit.ingested_at,
        displayedDateUnknown: item.published_at === null,
        groupId: item.story.current?.group_id ?? null,
        evidenceClassification: "unavailable" as const,
        detailAvailable:
          (item.content_versions ?? []).some(
            (version) => version.text !== "",
          ) || false,
      };
    });
    perQuery.push({
      queryId: query.id,
      development: query.development,
      hits,
    });
    // Classify against the raw stored ids; the presented answer carries
    // fixture ids so the recorded report is deterministic.
    const labeled = labels(corpus, resolve).get(query.development);
    if (labeled)
      for (const hit of results) {
        if (labeled.updateItemIds.includes(hit.id)) updateHits += 1;
        else if (labeled.coverageItemIds.includes(hit.id)) coverageHits += 1;
        else
          // Unchanged repeats, broad-topic decoys and unlabeled hits are all
          // presented by the baseline with no classification evidence.
          presentedWithoutEvidence += 1;
      }
  }
  return {
    perQuery,
    metrics: {
      updateRecall: ratio(
        updateHits,
        corpus.items.filter((item) => item.expectation === "meaningful_update")
          .length,
      ),
      presentedWithoutEvidence,
      inventedChronology: [...invented].sort(),
      expiredUpdatesRetrievable: ratio(
        0,
        corpus.items.filter((item) => item.expiredDetail).length,
      ),
      coverageRecall: ratio(
        coverageHits,
        corpus.items.filter((item) => item.expectation === "new_coverage")
          .length,
      ),
    },
  };
}

/**
 * The adopted arm answers the same recorded query set through the shipped
 * change-evidence read: one `get_development_changes` call per development
 * over the same window, reading the append-only recorded events.
 */
function adoptedArm(
  store: Store,
  corpus: HistoryComparisonCorpus,
  resolve: (fixtureItemId: string) => string,
  reverse: Map<string, string>,
  since: number,
): {
  perQuery: AdoptedQueryAnswer[];
  metrics: HistoryComparisonReport["arms"]["adopted"]["metrics"];
} {
  const perQuery: AdoptedQueryAnswer[] = [];
  let updateEvents = 0;
  const falsePositives = new Set<string>();
  const invented = new Set<string>();
  let expired = 0;
  let coverage = 0;
  for (const query of corpus.queries) {
    const anchorGroup =
      store.getItem(resolve(query.anchorItemId))?.story.current?.group_id ??
      null;
    const answer = anchorGroup
      ? developmentChanges(store, {
          groupId: anchorGroup,
          since,
          until: corpus.asOf,
          limit: 100,
        })
      : null;
    if (!answer) {
      perQuery.push({
        queryId: query.id,
        development: query.development,
        groupId: anchorGroup,
        events: [],
        coverage: { currentMembers: 0, membersWithoutChangeEvidence: 0 },
      });
      continue;
    }
    const labeled = labels(corpus, resolve).get(query.development);
    // Classified raw ids; the presented answer carries fixture ids.
    const rawEvents = answer.events;
    const events: AdoptedEvent[] = rawEvents.map((event) => ({
      id: event.id,
      kind: event.kind,
      itemId: reverse.get(event.item.itemId) ?? event.item.itemId,
      reportedAt: event.reportedAt,
      eventAt: event.eventAt,
      observedAt: event.observedAt,
      detailAvailable: event.detailAvailable,
      classifiedAs:
        event.kind === "content_change"
          ? ("claimed_update" as const)
          : event.kind === "new_coverage"
            ? ("new_coverage" as const)
            : ("grouping_correction" as const),
      evidence: event.evidence,
    }));
    perQuery.push({
      queryId: query.id,
      development: query.development,
      groupId: answer.groupId,
      events,
      coverage: {
        currentMembers: answer.coverage.currentMembers.length,
        membersWithoutChangeEvidence:
          answer.coverage.membersWithoutChangeEvidence.length,
      },
    });
    if (labeled) {
      const own = new Set([
        ...labeled.updateItemIds,
        ...labeled.coverageItemIds,
        ...labeled.unchangedItemIds,
      ]);
      for (const event of rawEvents) {
        const rawId = event.item.itemId;
        if (event.kind === "content_change") {
          if (labeled.updateItemIds.includes(rawId)) updateEvents += 1;
          else falsePositives.add(reverse.get(rawId) ?? rawId);
        } else if (event.kind === "new_coverage") {
          // New coverage of the development (including an unchanged
          // verbatim re-publication) is correct output; only an event for
          // an item that was never part of this development counts as a
          // false positive.
          if (labeled.coverageItemIds.includes(rawId)) coverage += 1;
          else if (!own.has(rawId))
            falsePositives.add(reverse.get(rawId) ?? rawId);
        }
      }
    }
    for (const expiredItem of labeled?.expiredItemIds ?? [])
      if (
        rawEvents.some(
          (event) =>
            event.item.itemId === expiredItem &&
            event.kind === "content_change",
        )
      )
        expired += 1;
  }
  return {
    perQuery,
    metrics: {
      updateRecall: ratio(
        updateEvents,
        corpus.items.filter((item) => item.expectation === "meaningful_update")
          .length,
      ),
      updateFalsePositives: [...falsePositives].sort(),
      inventedChronology: [...invented].sort(),
      expiredUpdatesRetrievable: ratio(
        expired,
        corpus.items.filter((item) => item.expiredDetail).length,
      ),
      coverageRecall: ratio(
        coverage,
        corpus.items.filter((item) => item.expectation === "new_coverage")
          .length,
      ),
    },
  };
}

/** Adoption threshold, fixed in code before the results were observed. */
const ADOPTION_THRESHOLD =
  "Adopt the recorded change-evidence slice only when, on the same labeled multi-week corpus, instant and query set: the baseline leaves at least one labeled meaningful update unretrievable through documented windowed reads; the adopted read retrieves every labeled meaningful update (recall 1.0) without classifying any labeled unchanged repeat or broad-topic decoy as a claimed update; labeled unknown report dates remain unknown (no invented chronology); expired content stays citable with detail marked unavailable; labeled coverage recall does not fall below the baseline; and the replay provider call count is zero. Otherwise record a justified non-adoption.";

function decide(
  baseline: HistoryComparisonReport["arms"]["baseline"]["metrics"],
  adopted: HistoryComparisonReport["arms"]["adopted"]["metrics"],
  providerCalls: 0,
): HistoryComparisonReport["adoption"] {
  const gapExists =
    baseline.updateRecall.value !== null && baseline.updateRecall.value < 1;
  const reasons: string[] = [];
  if (!gapExists)
    reasons.push(
      "the baseline already retrieves every labeled meaningful update through documented windowed reads",
    );
  if (gapExists && (adopted.updateRecall.value ?? 0) < 1)
    reasons.push(
      `adopted recall ${adopted.updateRecall.numerator}/${adopted.updateRecall.denominator} does not reach 1.0 on the labeled updates`,
    );
  if (adopted.updateFalsePositives.length)
    reasons.push(
      `${adopted.updateFalsePositives.length} labeled non-update(s) classified as claimed updates by the adopted read`,
    );
  if (adopted.inventedChronology.length)
    reasons.push(
      `${adopted.inventedChronology.length} invented chronology row(s) in the adopted answer`,
    );
  if ((adopted.expiredUpdatesRetrievable.value ?? 0) < 1)
    reasons.push(
      "expired-content updates are not fully citable with missing-detail markers",
    );
  if (
    (adopted.coverageRecall.value ?? 0) < (baseline.coverageRecall.value ?? 0)
  )
    reasons.push("labeled coverage recall fell below the baseline");
  if (providerCalls !== 0) reasons.push("the replay made provider calls");
  const adoptedDecision =
    gapExists &&
    (adopted.updateRecall.value ?? 0) >= 1 &&
    adopted.updateFalsePositives.length === 0 &&
    adopted.inventedChronology.length === 0 &&
    (adopted.expiredUpdatesRetrievable.value ?? 0) >= 1 &&
    (adopted.coverageRecall.value ?? 0) >=
      (baseline.coverageRecall.value ?? 0) &&
    providerCalls === 0;
  return {
    adopted: adoptedDecision,
    threshold: ADOPTION_THRESHOLD,
    reason: adoptedDecision
      ? "gap confirmed and closed: the recorded evidence read retrieves every labeled meaningful update, classifies unchanged repeats and decoys correctly, keeps unknown dates unknown, retains citations for expired content, and loses no labeled coverage"
      : reasons.join("; ") || "threshold not met",
    summary: adoptedDecision
      ? `Baseline update recall ${baseline.updateRecall.numerator}/${baseline.updateRecall.denominator} versus adopted ${adopted.updateRecall.numerator}/${adopted.updateRecall.denominator}; adopted claimed-update false positives ${adopted.updateFalsePositives.length}; invented chronology ${adopted.inventedChronology.length}; expired updates citable ${adopted.expiredUpdatesRetrievable.numerator}/${adopted.expiredUpdatesRetrievable.denominator}.`
      : "Non-adoption recorded on the labeled fixture; revisit requires new recorded evidence.",
  };
}

export function evaluateHistoryComparisons(
  corpusInput: unknown,
): HistoryComparisonReport {
  const corpus = historyComparisonCorpusSchema.parse(corpusInput);
  const { store, resolve } = createHistoryComparisonDatabase(corpus);
  try {
    const since = corpus.asOf - corpus.windowDays * DAY_MS;
    const reverse = new Map(
      corpus.items
        .map((item) => {
          let storedId: string | undefined;
          try {
            storedId = resolve(item.id);
          } catch {
            storedId = undefined;
          }
          return [storedId ?? "", item.id] as const;
        })
        .filter(([storedId]) => storedId !== ""),
    );
    const baseline = baselineArm(store, corpus, resolve, reverse, since);
    const adopted = adoptedArm(store, corpus, resolve, reverse, since);
    const usage = { providerCalls: 0 as const };
    return {
      evaluation: {
        id: corpus.id,
        version: HISTORY_COMPARISON_EVALUATION_VERSION,
      },
      corpus: {
        id: corpus.id,
        version: corpus.version,
        asOf: corpus.asOf,
        items: corpus.items.length,
        hash: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
      },
      config: {
        windowDays: corpus.windowDays,
        window: { since, until: corpus.asOf },
        groupingVersion: STORY_RULE_VERSION,
        changeEvidenceVersion: CHANGE_EVIDENCE_VERSION,
        labelledDevelopments: [...labels(corpus, resolve).keys()].sort(),
      },
      arms: {
        baseline: {
          description:
            "Today's baseline capability: windowed search_items (ingested_at window) plus per-hit story/get_item reads; no shipped surface classifies claimed updates, separates report/event/ingestion times per observation, or survives content expiry with change evidence.",
          methodology:
            "For each recorded query: store.search(terms, since, until), then store.getItem for every hit; report dates fall back to ingested_at exactly as a connector would have to (the shipped read leaves no other anchor); change classification unavailable.",
          perQuery: baseline.perQuery,
          metrics: baseline.metrics,
        },
        adopted: {
          description:
            "Recorded change evidence (issue #26 slice): per development, get_development_changes reads the append-only story_change_events written at ingestion and grouping-correction time, with citations that survive content expiry and explicit unknown report/event times.",
          methodology:
            "For each recorded query: resolve the anchor item's development, then developmentChanges({groupId, since, until}); classify events by kind; unknown dates stay null.",
          perQuery: adopted.perQuery,
          metrics: adopted.metrics,
        },
      },
      adoption: decide(baseline.metrics, adopted.metrics, usage.providerCalls),
      usage: {
        providerCalls: usage.providerCalls,
        cost: null,
        costPerUpdate: {
          value: null,
          note: "Recorded evidence writes are local; replay provider calls are zero and monetary cost stays unknown, not zero.",
        },
      },
      latencyMs: null,
      latencyReason:
        "No timing observation recorded; elapsed time is environment-dependent and excluded from deterministic replay.",
    };
  } finally {
    store.close();
  }
}
