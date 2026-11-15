import { createHash } from "node:crypto";
import { z } from "zod";
import { Store } from "./db/store";
import type { AnalysisRecord } from "./db/store";
import { DeliveryStore } from "./db/delivery-store";
import { AlertWorker } from "./alerts";
import type { AlertConfig } from "./alert-config";
import { ALERTS_DECISION_VERSION } from "./alert-config";
import { draftDigest, type DigestOptions } from "./digest-service";
import {
  localPublicationDate,
  publicationInstant,
} from "./publication-schedule";
import { SCORING_CRITERIA_VERSION, scoreItem } from "./scoring";
import { CHANGE_EVIDENCE_VERSION } from "./dev-changes";
import { STORY_RULE_VERSION } from "./story-grouping";

/**
 * Event alert evaluation (issue #27). Replays a labeled corpus of
 * time-sensitive developments — an urgent coordination incident, a
 * rapidly-updating event with recorded changed facts, repeat coverage of a
 * development already in the daily digest, and normal slow news that must not
 * alert — across the shipped daily-digest cadence and the shipped opt-in
 * alert evaluation, and compares digest delivery latency, missed
 * time-sensitive events and alert volume. No provider calls; unknown values
 * are recorded as unknown, never zero.
 */

export const ALERT_EVALUATION_VERSION = "alert-evaluation-v1";

/**
 * The replay store derives item, story and outbox ids from crypto.randomUUID,
 * which is random per run. Curation ties between equal-scored candidates would
 * then resolve run-to-run instead of deterministically, so the replay replaces
 * randomUUID with a counter-seeded UUID v4-shaped generator for the duration
 * of each evaluation and restores it afterwards. Version-labelled UUIDs and
 * store uniqueness do not depend on the randomness itself.
 */
let replayUuidCounter = 0;
const realRandomUuid = crypto.randomUUID;
const deterministicRandomUuid = (): string => {
  replayUuidCounter += 1;
  const hash = createHash("sha256")
    .update(`alert-evaluation-v1:${replayUuidCounter}`)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
};
function withDeterministicUuids<T>(run: () => T): T {
  replayUuidCounter = 0;
  const uuidApi = crypto as { randomUUID: () => string };
  uuidApi.randomUUID = deterministicRandomUuid;
  try {
    return run();
  } finally {
    uuidApi.randomUUID = realRandomUuid;
  }
}

const HALF_DAY_MS = 43_200_000;

const observationSchema = z.strictObject({
  observedAt: z.number().int().safe(),
  title: z.string().min(1).max(1000),
  text: z.string().max(200000),
  publishedAt: z.number().int().safe().nullable(),
});

const expectationSchema = z.enum([
  /** Urgent new development: must alert within its horizon. */
  "alert_time_sensitive",
  /** Recorded changed facts on a known development: must alert. */
  "alert_update",
  /** More coverage of a development already recorded: must not alert. */
  "repeat_coverage",
  /** Normal slow news: must not alert. */
  "no_alert",
]);

const analysisSchema = z.strictObject({
  claims: z
    .array(
      z.strictObject({
        statement: z.string().min(1).max(2000),
        citation: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(10),
  uncertainty: z.array(z.string().max(200)).max(10),
});

const itemSchema = z.strictObject({
  id: z.string().min(1).max(200),
  url: z.string().min(1).max(8192),
  sourceId: z.string().min(1).max(200),
  nativeId: z.string().min(1).max(200),
  development: z.string().min(1).max(200).nullable(),
  expectation: expectationSchema,
  /**
   * Usefulness horizon for THIS item in hours; an alert (or a digest
   * inclusion) after the horizon does not count as delivered in time.
   */
  horizonHours: z.number().int().min(1).max(72),
  /** Recorded analysis ("recorded model output") or null; drives credibility. */
  analysis: analysisSchema.nullable(),
  observations: z.array(observationSchema).min(1).max(10),
});

export const alertEvaluationCorpusSchema = z
  .strictObject({
    version: z.number().int().positive(),
    id: z.string().min(1),
    asOf: z.number().int().safe(),
    firstDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().max(2000),
    digestSchedule: z.strictObject({
      timezone: z.string().min(1).max(100),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      minScore: z.number().int().min(1).max(100),
      maxItems: z.number().int().min(1).max(20),
      maxPerInterest: z.number().int().min(1).max(20),
    }),
    /** Recorded alert settings, fixed before the replay was run. */
    alertSettings: z.strictObject({
      timezone: z.string().min(1).max(100),
      minScore: z.number().int().min(1).max(100),
      minEvidence: z.number().int().min(1).max(100),
      quietStart: z.string().regex(/^\d\d:\d\d$|^none$/),
      quietEnd: z.string().regex(/^\d\d:\d\d$|^none$/),
      cooldownHours: z.number().int().min(0).max(168),
      dailyCap: z.number().int().min(1).max(50),
    }),
    tickMinutes: z.number().int().min(1).max(1440),
    interest: z.record(z.string(), z.unknown()),
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
  })
  .superRefine((corpus, context) => {
    const ids = new Set(corpus.items.map((item) => item.id));
    if (ids.size !== corpus.items.length)
      context.addIssue({ code: "custom", message: "Item IDs must be unique" });
    for (const item of corpus.items)
      if (item.expectation === "alert_update" && item.observations.length < 2)
        context.addIssue({
          code: "custom",
          message: `Item ${item.id} labeled alert_update needs a prior observation so the update records change evidence`,
        });
  });

export type AlertEvaluationCorpus = z.infer<typeof alertEvaluationCorpusSchema>;

export interface AlertEvaluationDatabase {
  store: Store;
  deliveries: DeliveryStore;
  resolve: (fixtureItemId: string) => string;
  reverse: Map<string, string>;
  settings: AlertConfig;
  /** Re-derives the stored-id ↔ fixture-id maps after a wave ingest. */
  refresh: () => void;
}

export function alertConfigFromCorpus(
  settings: AlertEvaluationCorpus["alertSettings"],
): AlertConfig {
  const parse = (value: string) => {
    if (value === "none") return null;
    const match = /^(\d\d):(\d\d)$/.exec(value)!;
    return { hour: Number(match[1]), minute: Number(match[2]) };
  };
  return {
    apiKey: "replay",
    sender: "alerts@example.test",
    recipient: "operator@example.test",
    timezone: settings.timezone,
    minScore: settings.minScore,
    minEvidence: settings.minEvidence,
    quietStart: parse(settings.quietStart),
    quietEnd: parse(settings.quietEnd),
    cooldownHours: settings.cooldownHours,
    dailyCap: settings.dailyCap,
  };
}

function canonicalItemUrl(value: string): string {
  const u = new URL(value);
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (/^utm_|^(fbclid|gclid)$/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href;
}

/**
 * Opens a replay store and records the fixture sources and interest. Waves
 * are then ingested explicitly (in timeline order) via `ingestWave`, so every
 * digest draft and alert tick sees exactly the settled state that a real
 * deployment would have seen at that instant — never a future score.
 */
export function openAlertReplayStore(
  corpus: AlertEvaluationCorpus,
  path: string = ":memory:",
  dbPath?: string,
): AlertEvaluationDatabase {
  const store = new Store(dbPath ?? path);
  const settings = alertConfigFromCorpus(corpus.alertSettings);
  const deliveries = new DeliveryStore(store.sqlite);
  for (const source of corpus.sources)
    store.addSource(source.url, source.title);
  const interest = corpus.interest as { id: string; version: number };
  store.sqlite
    .query("INSERT INTO profiles(kind,id,version,document) VALUES(?,?,?,?)")
    .run("interest", interest.id, interest.version, JSON.stringify(interest));
  const identityToFixture = new Map(
    corpus.items.map(
      (item) => ["url:" + canonicalItemUrl(item.url), item.id] as const,
    ),
  );
  const resolve = (fixtureItemId: string): string => {
    const id = store.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM items WHERE identity=?")
      .get(
        identityToFixture.get(fixtureItemId) ??
          (() => {
            for (const [identity, fixtureId] of identityToFixture)
              if (fixtureId === fixtureItemId) return identity;
            throw new Error(`Unknown fixture item ${fixtureItemId}`);
          })(),
      )?.id;
    if (!id)
      throw new Error(`Fixture item ${fixtureItemId} was never ingested`);
    return id;
  };
  const reverse = new Map<string, string>();
  const refresh = () => {
    for (const [identity, fixtureId] of identityToFixture) {
      const id = store.sqlite
        .query<{ id: string }, [string]>(
          "SELECT id FROM items WHERE identity=?",
        )
        .get(identity)?.id;
      if (id) reverse.set(id, fixtureId);
    }
  };
  return { store, deliveries, resolve, reverse, settings, refresh };
}

/**
 * Ingest one recorded poll wave through the shipped poll/ingest path at the
 * recorded instant, then reconcile grouping and settle all derived work with
 * production scoring as of that instant.
 */
export function ingestWave(
  replay: AlertEvaluationDatabase,
  corpus: AlertEvaluationCorpus,
  wave: number,
): void {
  const { store } = replay;
  const sources = new Map(
    corpus.sources.map((source) => [
      source.id,
      store.sqlite
        .query<{ id: string }, [string]>("SELECT id FROM sources WHERE url=?")
        .get(source.url)!.id,
    ]),
  );
  const itemsBySource = new Map<string, AlertEvaluationCorpus["items"]>();
  for (const item of corpus.items) {
    itemsBySource.set(item.sourceId, [
      ...(itemsBySource.get(item.sourceId) ?? []),
      item,
    ]);
  }
  for (const [sourceId, items] of itemsBySource) {
    const sourceId2 = sources.get(sourceId)!;
    const entries = items.flatMap((item) => {
      const observation = item.observations.find((o) => o.observedAt === wave);
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
    while (job && job.source_id !== sourceId2) {
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
  store.stories.reconcile(wave + 2000);
  settleProcessing(store, corpus, wave + 3000);
  replay.refresh();
}

/**
 * Convenience builder for tests and metrics inspection: ingests every wave
 * up front (so stored final state is inspectable) — NOT suitable for
 * instant-faithful tick replay, which must ingest waves through the timeline.
 */
export function createAlertEvaluationDatabase(
  corpus: AlertEvaluationCorpus,
  path: string = ":memory:",
): AlertEvaluationDatabase {
  const replay = openAlertReplayStore(corpus, path);
  const waves = [
    ...new Set(
      corpus.items.flatMap((item) =>
        item.observations.map((o) => o.observedAt),
      ),
    ),
  ].sort((a, b) => a - b);
  for (const wave of waves) ingestWave(replay, corpus, wave);
  return replay;
}

/**
 * Deterministic settle pass through the shipped processing states. Recorded
 * analyses complete through the shipped analysis-record path; scoring runs
 * the shipped snapshot + scorer so persisted item_scores are the ones the
 * digest and the alert gates read. Group stage jobs reconcile through the
 * shipped StoryStore.
 */
export function settleProcessing(
  store: Store,
  corpus: AlertEvaluationCorpus,
  now: number,
): void {
  const analysisForItem = new Map<
    string,
    AlertEvaluationCorpus["items"][number]
  >();
  for (const item of corpus.items) {
    if (!item.analysis) continue;
    const row = store.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM items WHERE identity=?")
      .get("url:" + canonicalItemUrl(item.url));
    if (row) analysisForItem.set(row.id, item);
  }
  for (;;) {
    let progressed = false;
    for (const stage of ["extract", "analyse", "group", "score"] as const) {
      for (;;) {
        const job = store.claimProcessing(stage, now);
        if (!job) break;
        if (stage === "extract") {
          store.completeProcessing(
            job,
            "extracted",
            now,
            JSON.stringify({ status: "extracted", text: "" }),
          );
          progressed = true;
          continue;
        }
        if (stage === "analyse") {
          const item = analysisForItem.get(job.item_id);
          if (item?.analysis) {
            const record: AnalysisRecord = {
              inputHash: "recorded-replay",
              provider: "recorded-fixture",
              model: "recorded-fixture",
              promptVersion: "replay",
              profiles: [],
              // The shipped record type carries the digest-facing summary;
              // the persisted JSON keeps the full recorded claim evidence.
              analysis: {
                claims: item.analysis.claims,
                uncertainty: item.analysis.uncertainty,
              } as unknown as { summary: string },
              usage: {},
              cost: 0,
            };
            if (store.completeAnalysis(job, record, now)) progressed = true;
          } else if (store.completeProcessing(job, "analysed", now))
            progressed = true;
          continue;
        }
        if (stage === "score") {
          const snapshot = store.scoringSnapshot(job, now);
          if (!snapshot) {
            store.completeProcessing(job, "superseded", now);
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

export interface BaselineDigestDay {
  date: string;
  dueAt: number;
  status: string;
  reason: string | null;
  selected: string[];
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

/** Hours between two instants, rounded to two decimals. */
function latencyHours(from: number, to: number | null): number | null {
  if (to === null) return null;
  return Math.round(((to - from) / 3_600_000) * 100) / 100;
}

export interface EventArmOutcome {
  itemId: string;
  development: string | null;
  expectation: string;
  horizonHours: number;
  /** The recorded change-evidence event that makes the item alert-worthy. */
  trigger: {
    changeEventId: number | null;
    kind: string | null;
    observedAt: number | null;
  };
  baseline: {
    /** The next daily edition that selected the item, if any. */
    deliveredAt: number | null;
    latencyHours: number | null;
    missed: boolean;
  };
  candidate: {
    alertIdPresent: boolean;
    deliveredAt: number | null;
    latencyHours: number | null;
    missed: boolean;
    quietUntil: number | null;
    suppressionReasons: string[];
  };
}

export interface AlertEvaluationReport {
  evaluation: { id: string; version: string };
  corpus: {
    id: string;
    version: number;
    asOf: number;
    horizonHours: number;
    items: number;
    hash: string;
  };
  config: {
    digest: AlertEvaluationCorpus["digestSchedule"];
    alerts: AlertEvaluationCorpus["alertSettings"];
    tickMinutes: number;
    groupingVersion: string;
    changeEvidenceVersion: string;
    scoringVersion: string;
    alertsDecisionVersion: string;
  };
  baseline: {
    description: string;
    methodology: string;
    perDay: BaselineDigestDay[];
    metrics: {
      timeSensitiveWithinHorizon: ComparisonMetric;
      missedTimeSensitive: string[];
      digestEmailsSent: number;
      digestItemsVolume: number;
      alertVolume: { value: null; note: string };
    };
  };
  candidate: {
    description: string;
    methodology: string;
    perEvent: EventArmOutcome[];
    firedAlerts: {
      itemId: string;
      kind: string;
      changeEventId: number;
      frozenAt: number;
      localDate: string;
      scheduledFor: number;
    }[];
    suppressionCounts: Record<string, number>;
    metrics: {
      timeSensitiveWithinHorizon: ComparisonMetric;
      missedTimeSensitive: string[];
      falseAlerts: string[];
      alertVolume: number;
      suppressionVolume: number;
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
    costPerAlert: { value: null; note: string };
  };
  latencyMs: null;
  latencyReason: string;
}

/** Adoption threshold, fixed in code before the replay results were observed. */
const ADOPTION_THRESHOLD =
  "Adopt the opt-in selective alert slice only when, on the same labeled corpus, fixed settings and digest cadence: the daily digest baseline leaves at least one labeled time-sensitive event undelivered within its recorded usefulness horizon (a measured cadence gap); replay through the shipped alert evaluation delivers every labeled alert-worthy event within its horizon; alerts fire for no item labeled repeat_coverage or no_alert; total alert volume does not exceed the labeled alert-worthy event count; and the replay makes zero provider calls. Otherwise record a justified non-adoption.";

function decide(
  baselineMissed: string[],
  labeledAlertworthy: number,
  candidate: AlertEvaluationReport["candidate"]["metrics"],
  providerCalls: 0,
): AlertEvaluationReport["adoption"] {
  const gap = baselineMissed.length > 0;
  const reasons: string[] = [];
  if (!gap)
    reasons.push(
      "the daily digest baseline already delivered every labeled time-sensitive event within its horizon",
    );
  if (gap && candidate.missedTimeSensitive.length)
    reasons.push(
      `the alert candidate still missed ${candidate.missedTimeSensitive.join(",")}`,
    );
  if (candidate.falseAlerts.length)
    reasons.push(
      `the alert candidate alerted labeled non-eligible items (${candidate.falseAlerts.join(",")})`,
    );
  if (candidate.alertVolume > labeledAlertworthy)
    reasons.push(
      `alert volume ${candidate.alertVolume} exceeds the ${labeledAlertworthy} labeled alert-worthy developments`,
    );
  if (providerCalls !== 0) reasons.push("the replay made provider calls");
  const adopted =
    gap &&
    candidate.missedTimeSensitive.length === 0 &&
    candidate.falseAlerts.length === 0 &&
    candidate.alertVolume <= labeledAlertworthy &&
    providerCalls === 0;
  return {
    adopted,
    threshold: ADOPTION_THRESHOLD,
    reason: adopted
      ? "measured cadence gap confirmed and closed: the shipped alert evaluation delivered every labeled time-sensitive event within its horizon, alerted nothing labeled repeat coverage or slow news, and alert volume matches the labeled alert-worthy developments"
      : reasons.join("; ") || "threshold not met",
    summary: adopted
      ? `Baseline digest missed ${baselineMissed.length}/${labeledAlertworthy} labeled time-sensitive developments; the alert candidate delivered ${candidate.timeSensitiveWithinHorizon.numerator}/${candidate.timeSensitiveWithinHorizon.denominator} within horizon with ${candidate.falseAlerts.length} false alerts at volume ${candidate.alertVolume} (suppressed ${candidate.suppressionVolume} candidate evaluations).`
      : "Non-adoption recorded on the labeled fixture; revisit requires new recorded evidence.",
  };
}

interface ChangeEventRowLite {
  id: number;
  kind: string;
  observed_at: number;
}

/** The stored change event that starts an item's alert-worthiness, if any. */
function triggerEventFor(
  store: Store,
  itemId: string,
  expectation: string,
): ChangeEventRowLite | null {
  const query =
    expectation === "alert_update"
      ? "SELECT id,kind,observed_at FROM story_change_events WHERE item_id=? AND kind='content_change' ORDER BY id LIMIT 1"
      : "SELECT id,kind,observed_at FROM story_change_events WHERE item_id=? ORDER BY id LIMIT 1";
  return (
    store.sqlite.query<ChangeEventRowLite, [string]>(query).get(itemId) ?? null
  );
}

/**
 * Runs the recorded replay: waves, digest instants and alert ticks are
 * merged into one ascending timeline so every measurement observes exactly
 * the database state a deployment would have had at that instant, then the
 * code-fixed adoption threshold decides.
 */
export function evaluateAlerts(corpusInput: unknown): AlertEvaluationReport {
  return withDeterministicUuids(() => evaluateAlertsReplay(corpusInput));
}

function evaluateAlertsReplay(corpusInput: unknown): AlertEvaluationReport {
  const corpus = alertEvaluationCorpusSchema.parse(corpusInput);
  const replay = openAlertReplayStore(corpus);
  const { store, deliveries, reverse, settings, resolve } = replay;
  try {
    const worker = new AlertWorker(store, deliveries, settings);
    const baselinePerDay: BaselineDigestDay[] = [];

    const digestInstants: { date: string; instant: number | null }[] = [];
    for (
      let date = corpus.firstDate;
      Date.parse(`${date}T00:00:00Z`) <= corpus.asOf;
      date = nextDate(date)
    ) {
      digestInstants.push({
        date,
        instant: publicationInstant(date, {
          timezone: corpus.digestSchedule.timezone,
          hour: corpus.digestSchedule.hour,
          minute: corpus.digestSchedule.minute,
        }),
      });
    }

    const waveInstants = [
      ...new Set(
        corpus.items.flatMap((item) =>
          item.observations.map((o) => o.observedAt),
        ),
      ),
    ].sort((a, b) => a - b);
    const start = Date.parse(`${corpus.firstDate}T00:00:00Z`);
    const tickMs = corpus.tickMinutes * 60_000;
    const suppressionByEvent = new Map<number, Set<string>>();
    const digestSet = new Set(
      digestInstants
        .map((d) => d.instant)
        .filter((instant): instant is number => instant !== null),
    );

    // One ascending timeline: wave ingest, digest draft, alert tick.
    const instants = new Set<number>([...digestSet]);
    for (const wave of waveInstants) instants.add(wave);
    for (let tick = start; tick <= corpus.asOf; tick += tickMs)
      instants.add(tick);

    const firedByEvent = new Map<
      number,
      { itemId: string; kind: string; frozenAt: number; scheduledFor: number }
    >();
    for (const instant of [...instants].sort((a, b) => a - b)) {
      const wave = waveInstants.find((w) => w === instant);
      if (wave !== undefined) ingestWave(replay, corpus, wave);
      // Processing ticks continuously in production; settle so every draft
      // and alert evaluation sees the state a live deployment would have.
      settleProcessing(store, corpus, instant);
      if (digestSet.has(instant)) {
        const entry = digestInstants.find((d) => d.instant === instant)!;
        const options: DigestOptions = {
          date: entry.date,
          timezone: corpus.digestSchedule.timezone,
          now: instant,
          minScore: corpus.digestSchedule.minScore,
          maxItems: corpus.digestSchedule.maxItems,
          maxPerInterest: corpus.digestSchedule.maxPerInterest,
        };
        const draft = draftDigest(store, options);
        replay.refresh();
        baselinePerDay.push({
          date: entry.date,
          dueAt: instant,
          status: draft.status,
          reason: draft.status === "processing" ? draft.reason : null,
          selected: draft.selected
            .map((item) => reverse.get(item.itemId) ?? item.itemId)
            .sort(),
        });
      }
      const result = worker.evaluate(instant);
      for (const fired of result.fired)
        if (!firedByEvent.has(fired.changeEventId))
          firedByEvent.set(fired.changeEventId, {
            itemId: fired.itemId,
            kind: fired.kind,
            frozenAt: instant,
            scheduledFor: fired.quietUntil ?? instant,
          });
      for (const suppressed of result.suppressed) {
        const reasons =
          suppressionByEvent.get(suppressed.changeEventId) ?? new Set();
        reasons.add(suppressed.reason);
        suppressionByEvent.set(suppressed.changeEventId, reasons);
      }
    }

    // --- Per-event outcomes: map stored rows back to fixture identities ---
    // The digest presents development-level coverage (one representative per
    // group), so baseline delivery counts an edition whose selection covers
    // the labeled development, not only the exact item.
    const developmentItems = new Map<string, string[]>();
    for (const item of corpus.items) {
      if (!item.development) continue;
      developmentItems.set(item.development, [
        ...(developmentItems.get(item.development) ?? []),
        item.id,
      ]);
    }
    // Labeled alert-worthy EVENTS: one for each alert_time_sensitive item
    // (its first recorded coverage) plus every recorded content_change of an
    // alert_update item — the moments an alert is supposed to fire.
    const contentChangesByItem = new Map<string, number>();
    for (const item of corpus.items) {
      const storedId = resolve(item.id);
      const count = store.sqlite
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM story_change_events WHERE item_id=? AND kind='content_change'",
        )
        .get(storedId)!.n;
      contentChangesByItem.set(item.id, count);
    }
    const labeledAlertworthyEvents = corpus.items.reduce((sum, item) => {
      if (item.expectation === "alert_time_sensitive") return sum + 1;
      if (item.expectation === "alert_update")
        return sum + Math.max(1, contentChangesByItem.get(item.id) ?? 1);
      return sum;
    }, 0);
    const perEvent: EventArmOutcome[] = [];
    const falseAlerts = new Set<string>();
    const candidateMissed = new Set<string>();
    for (const item of corpus.items) {
      const storedId = resolve(item.id);
      const trigger = triggerEventFor(store, storedId, item.expectation);
      const alertworthy =
        item.expectation === "alert_time_sensitive" ||
        item.expectation === "alert_update";
      const horizon = item.horizonHours * 3_600_000;

      const covered = (selected: string[]) =>
        selected.includes(item.id) ||
        (item.development !== null &&
          (developmentItems.get(item.development) ?? []).some((id) =>
            selected.includes(id),
          ));
      // Baseline: the next daily edition, chronologically after the trigger,
      // that covered the item or its development.
      const baselineDelivery = trigger
        ? (baselinePerDay.find(
            (day) => day.dueAt > trigger.observed_at && covered(day.selected),
          ) ?? null)
        : null;
      const baselineLatency =
        trigger && baselineDelivery
          ? latencyHours(trigger.observed_at, baselineDelivery.dueAt)
          : null;
      const baselineMissed =
        alertworthy &&
        (baselineLatency === null || baselineLatency! > item.horizonHours);

      // Candidate: the alert frozen for the trigger event (quiet hours may
      // schedule the send later within the same alert).
      const fired = trigger ? firedByEvent.get(trigger.id) : undefined;
      const candidateLatency =
        trigger && fired
          ? latencyHours(trigger.observed_at, fired.scheduledFor)
          : null;
      const candidateMissedEvent =
        alertworthy &&
        (!fired ||
          candidateLatency === null ||
          candidateLatency > item.horizonHours);
      if (fired && !alertworthy) falseAlerts.add(item.id);
      if (candidateMissedEvent) candidateMissed.add(item.id);

      perEvent.push({
        itemId: item.id,
        development: item.development,
        expectation: item.expectation,
        horizonHours: item.horizonHours,
        trigger: trigger
          ? {
              changeEventId: trigger.id,
              kind: trigger.kind,
              observedAt: trigger.observed_at,
            }
          : {
              changeEventId: null,
              kind: null,
              observedAt: null,
            },
        baseline: {
          deliveredAt: baselineDelivery?.dueAt ?? null,
          latencyHours: baselineLatency,
          missed: baselineMissed,
        },
        candidate: {
          alertIdPresent: Boolean(fired),
          deliveredAt: fired?.scheduledFor ?? null,
          latencyHours: candidateLatency,
          missed: candidateMissedEvent,
          quietUntil:
            fired && fired.scheduledFor !== fired.frozenAt
              ? fired.scheduledFor
              : null,
          suppressionReasons: trigger
            ? [...(suppressionByEvent.get(trigger.id) ?? [])].sort()
            : [],
        },
      });
    }

    const labeledAlertworthyList = corpus.items.filter(
      (item) =>
        item.expectation === "alert_time_sensitive" ||
        item.expectation === "alert_update",
    );
    const labeledAlertworthy = labeledAlertworthyList.length;
    const baselineMissed = labeledAlertworthyList
      .filter(
        (item) =>
          perEvent.find((outcome) => outcome.itemId === item.id)?.baseline
            .missed,
      )
      .map((item) => item.id);
    const candidateMissedList = labeledAlertworthyList
      .filter(
        (item) =>
          perEvent.find((outcome) => outcome.itemId === item.id)?.candidate
            .missed,
      )
      .map((item) => item.id);
    const digestEmailsSent = baselinePerDay.filter(
      (day) => day.status === "ready",
    ).length;
    const digestItemsVolume = baselinePerDay.reduce(
      (sum, day) => sum + day.selected.length,
      0,
    );
    const suppressionCounts: Record<string, number> = {};
    for (const reasons of suppressionByEvent.values())
      for (const reason of reasons)
        suppressionCounts[reason] = (suppressionCounts[reason] ?? 0) + 1;
    const alertRows = store.sqlite
      .query<
        {
          id: string;
          item_id: string;
          kind: string;
          change_event_id: number;
          local_date: string;
          frozen_at: number;
        },
        []
      >(
        "SELECT id,item_id,kind,change_event_id,local_date,frozen_at FROM alerts",
      )
      .all();

    const candidateMetrics = {
      timeSensitiveWithinHorizon: ratio(
        labeledAlertworthy - candidateMissedList.length,
        labeledAlertworthy,
      ),
      missedTimeSensitive: candidateMissedList,
      falseAlerts: [...falseAlerts].sort(),
      alertVolume: alertRows.length,
      suppressionVolume: Object.values(suppressionCounts).reduce(
        (sum, n) => sum + n,
        0,
      ),
    };
    const baselineMetrics = {
      timeSensitiveWithinHorizon: ratio(
        labeledAlertworthy - baselineMissed.length,
        labeledAlertworthy,
      ),
      missedTimeSensitive: baselineMissed,
      digestEmailsSent,
      digestItemsVolume,
      alertVolume: {
        value: null,
        note: "The baseline sends no alerts; its only channel is the daily digest.",
      },
    };
    return {
      evaluation: { id: corpus.id, version: ALERT_EVALUATION_VERSION },
      corpus: {
        id: corpus.id,
        version: corpus.version,
        asOf: corpus.asOf,
        horizonHours: corpus.items[0]!.horizonHours,
        items: corpus.items.length,
        hash: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
      },
      config: {
        digest: corpus.digestSchedule,
        alerts: corpus.alertSettings,
        tickMinutes: corpus.tickMinutes,
        groupingVersion: STORY_RULE_VERSION,
        changeEvidenceVersion: CHANGE_EVIDENCE_VERSION,
        scoringVersion: SCORING_CRITERIA_VERSION,
        alertsDecisionVersion: ALERTS_DECISION_VERSION,
      },
      baseline: {
        description:
          "Today's baseline capability: the shipped daily digest at the configured publication instant (here Europe/London 06:00). A development observed after an edition is included in the next edition; no shipped surface alerts between editions.",
        methodology:
          "For each local publication date: publicationInstant for the digest schedule, then the shipped draftDigest over the store settled as of that instant. Latency for a labeled event runs from the recorded change-evidence trigger observation to the first edition that selected the item; no inclusion within the horizon counts as missed.",
        perDay: baselinePerDay,
        metrics: baselineMetrics,
      },
      candidate: {
        description:
          "Opt-in alert candidate: the shipped AlertWorker over recorded change evidence with the recorded thresholds, quiet hours, cooldown, daily cap and per-event deduplication; every delivery persists through the shared durable outbox. The replay contacts no provider.",
        methodology:
          "At each recorded tick (digest instants included) the shipped AlertWorker.evaluate runs with the fixed recorded settings. A fired alert's scheduled send instant (quiet-hours aware, durable outbox row) measures candidate delivery; a scheduled instant beyond the horizon counts as missed. Suppressed evaluations record their reason once per event.",
        perEvent,
        firedAlerts: alertRows.map((row) => ({
          itemId: reverse.get(row.item_id) ?? row.item_id,
          kind: row.kind,
          changeEventId: row.change_event_id,
          frozenAt: row.frozen_at,
          localDate: row.local_date,
          scheduledFor:
            firedByEvent.get(row.change_event_id)?.scheduledFor ??
            row.frozen_at,
        })),
        suppressionCounts,
        metrics: candidateMetrics,
      },
      adoption: decide(
        baselineMissed,
        labeledAlertworthyEvents,
        candidateMetrics,
        0,
      ),
      usage: {
        providerCalls: 0,
        cost: null,
        costPerAlert: {
          value: null,
          note: "Alert evaluation reads recorded evidence only; replay provider calls are zero and monetary cost stays unknown, not zero.",
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

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}
