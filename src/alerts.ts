import type { Store } from "./db/store";
import { SCORING_CRITERIA_VERSION } from "./scoring";
import {
  localPublicationDate,
  publicationInstant,
} from "./publication-schedule";
import { AlertStore, advanceAlertCursor, alertCursor } from "./db/alert-store";
import type { DeliveryStore } from "./db/delivery-store";
import type { DeliveryWorker } from "./delivery";
import { ALERTS_DECISION_VERSION, type AlertConfig } from "./alert-config";

/**
 * Selective high-priority event alerts (issue #27, opt-in). Evaluation reuses
 * exactly one trigger surface — the append-only recorded change evidence from
 * issue #26 (`story_change_events`) — so an alert always represents a
 * meaningful update: recorded changed facts (body or headline) or the first
 * recorded coverage of a development. A URL-only edit records no new facts
 * and never alerts, and a high score alone never alerts. Thresholds
 * (priority/credibility), quiet hours (Europe/London semantics, DST-safe via
 * the shipped publication calendar), per-development cooldowns, a daily cap
 * and per-event deduplication are explicit user configuration; disabled by
 * default an evaluation sends nothing and writes nothing. Delivery reuses the
 * existing durable outbox and idempotency rules; nothing here contacts a
 * provider inside a transaction. Scores must be current in exactly the sense
 * the daily digest requires (score job done with a live refresh horizon and
 * no pending rescore) before any score-based gate runs.
 */

/** Events younger than this may still be awaiting grouping; do not skip them. */
const UNGROUPED_GRACE_MS = 15 * 60_000;
const SCAN_LIMIT = 500;
/** Outbox sends flushed per tick (bounds the loop; rows stay durable). */
const FLUSH_LIMIT = 50;

export type SuppressionReason =
  | "not_alertable_kind"
  | "cosmetic_change"
  | "development_ungrouped"
  | "repeat_coverage"
  | "score_unavailable"
  | "score_version_stale"
  | "not_interest_eligible"
  | "below_priority_threshold"
  | "below_credibility_threshold"
  | "cooldown"
  | "daily_cap"
  | "already_alerted";

export interface FiredAlert {
  alertId: string;
  changeEventId: number;
  kind: string;
  itemId: string;
  groupId: string | null;
  /** Set when quiet hours schedule the send after the quiet window ends. */
  quietUntil: number | null;
}

export interface SuppressedCandidate {
  changeEventId: number;
  reason: SuppressionReason;
}

export interface CancelledAlert {
  alertId: string;
  reason: string;
}

/** The batch stopped before consuming an event that is not yet decidable. */
export type DeferReason = "ungrouped" | "scores_pending";

export interface AlertTickResult {
  disabled: boolean;
  evaluated: number;
  /**
   * Set when the batch stopped with events still pending: a young ungrouped
   * event awaiting grouping, or an item whose current score is not settled.
   * A deferred event is NOT suppressed and its cursor does not move — it is
   * reconsidered in order on the next tick, in the same way the daily digest
   * reports `processing` for the same inputs.
   */
  deferred: DeferReason | null;
  fired: FiredAlert[];
  suppressed: SuppressedCandidate[];
  cancelled: CancelledAlert[];
}

function clockPart(now: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return get("hour") * 60 + get("minute");
}

function inQuietHours(now: number, config: AlertConfig): boolean {
  if (!config.quietStart || !config.quietEnd) return false;
  const minuteOfDay = clockPart(now, config.timezone);
  const start = config.quietStart.hour * 60 + config.quietStart.minute;
  const end = config.quietEnd.hour * 60 + config.quietEnd.minute;
  if (start === end) return false;
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

/**
 * The instant quiet hours next end, using the shipped DST-safe calendar so a
 * spring-forward gap or autumn overlap resolves exactly like daily publication.
 */
export function quietEndInstant(now: number, config: AlertConfig): number {
  if (!config.quietEnd) throw new Error("No quiet end configured");
  const date = localPublicationDate(now, config.timezone);
  const schedule = {
    timezone: config.timezone,
    hour: config.quietEnd.hour,
    minute: config.quietEnd.minute,
  };
  const today = publicationInstant(date, schedule);
  if (today !== null && today > now) return today;
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const tomorrow = publicationInstant(next, schedule);
  if (tomorrow === null)
    throw new Error("Quiet end has no occurrence on consecutive days");
  return tomorrow;
}

function parseEvidence(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { reason: "unparseable_evidence" };
  }
}

function changeSummary(evidence: Record<string, unknown>): string {
  const parts: string[] = [];
  if (evidence.bodyChanged) {
    const added = (evidence.addedTerms as string[] | undefined) ?? [];
    const removed = (evidence.removedTerms as string[] | undefined) ?? [];
    if (added.length || removed.length)
      parts.push(
        `added: ${added.join(", ") || "none"}; removed: ${removed.join(", ") || "none"}`,
      );
    else if (evidence.bodyComparison)
      parts.push(String(evidence.bodyComparison));
  }
  if (evidence.titleChanged) parts.push("headline changed");
  if (evidence.urlChanged) parts.push("link changed");
  return parts.join("; ") || "recorded change";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderAlert(input: {
  kind: string;
  title: string;
  url: string | null;
  observedAt: number;
  evidence: Record<string, unknown>;
  scoreTotal: number;
  scoreReasons: string[];
  scoreCredibility: number;
  config: AlertConfig;
}): { subject: string; html: string; text: string } {
  const observed = new Date(input.observedAt).toISOString();
  const change = changeSummary(input.evidence);
  const subject = `[NewsPulse alert] ${input.title}`.slice(0, 1000);
  const reasonLine = `Score ${input.scoreTotal} (priority threshold ${input.config.minScore}), evidence ${input.scoreCredibility} (credibility threshold ${input.config.minEvidence}).`;
  const text =
    `NewsPulse event alert\n\n${input.title}\n` +
    `${input.url ?? "URL unavailable"}\n` +
    `Observed: ${observed}\n` +
    `Change: ${input.kind}\n${change}\n\n` +
    `${reasonLine}\n${input.scoreReasons.join("; ")}\n\n` +
    `Recorded change evidence never establishes that any claim is true; ` +
    `citations reflect what the source published.\n`;
  const html =
    `<p><strong>${escapeHtml(input.title)}</strong></p>` +
    (input.url
      ? `<p><a href="${escapeHtml(input.url)}">${escapeHtml(input.url)}</a></p>`
      : "") +
    `<p>Observed: ${escapeHtml(observed)}<br>Change: ${escapeHtml(input.kind)} — ${escapeHtml(change)}</p>` +
    `<p>${escapeHtml(reasonLine)}</p>` +
    `<p>${escapeHtml(input.scoreReasons.join("; "))}</p>`;
  return { subject, html, text };
}

type ScoreFreshness =
  | {
      kind: "ready";
      score: {
        scoreId: string;
        criteriaVersion: string;
        total: number;
        eligible: boolean;
        evidenceComponent: number;
        reasons: string[];
      };
    }
  /** Processing is incomplete or the recorded score is being refreshed. */
  | { kind: "defer" }
  /** Terminal: the shipped pipeline will never produce a current score. */
  | { kind: "terminal"; outcome: string };

/**
 * The item's score state, with exactly the currency checks the daily digest
 * applies before using a score (src/digest-service.ts): the latest extraction
 * generation's score job must be done and scored, the score's refresh row
 * must still live and not be due, criteria must match the shipped version,
 * and no global rescore may be pending. Anything else defers the event until
 * a current score exists; only terminal pipeline outcomes suppress for good.
 */
export function scoreState(
  store: Store,
  itemId: string,
  now: number,
): ScoreFreshness {
  const row = store.sqlite
    .query<
      {
        extract_generation: number | null;
        extract_status: string | null;
        score_status: string | null;
        score_outcome: string | null;
        criteria_version: string | null;
        refresh_id: string | null;
        due_at: number | null;
        score_id: string | null;
        result: string | null;
        invalidation_pending: number | null;
      },
      [string]
    >(
      `SELECT e.generation AS extract_generation,e.status AS extract_status,
        j.status AS score_status,j.outcome AS score_outcome,
        s.criteria_version,r.job_id AS refresh_id,r.due_at,
        s.id AS score_id,s.result,
        (SELECT pending FROM score_invalidation WHERE id=1) AS invalidation_pending
      FROM items i
      LEFT JOIN processing_jobs e ON e.id=(SELECT x.id FROM processing_jobs x WHERE x.item_id=i.id AND x.stage='extract' ORDER BY x.generation DESC LIMIT 1)
      LEFT JOIN processing_jobs j ON j.item_id=i.id AND j.stage='score' AND j.generation=e.generation
      LEFT JOIN score_refresh r ON r.job_id=j.id
      LEFT JOIN item_scores s ON s.id=(SELECT x.id FROM item_scores x WHERE x.item_id=i.id AND x.generation=e.generation ORDER BY x.created_at DESC,x.rowid DESC LIMIT 1)
      WHERE i.id=?`,
    )
    .get(itemId);
  if (row?.extract_status === "failed")
    return { kind: "terminal", outcome: "extract_failed" };
  if (row?.score_status === "failed")
    return { kind: "terminal", outcome: "score_failed" };
  if (row?.score_status === "done" && row.score_outcome === "unavailable")
    return { kind: "terminal", outcome: "score_unavailable" };
  // A done score whose criteria version has drifted with no refresh row
  // scheduled will never become current again.
  if (
    row?.score_status === "done" &&
    row.score_outcome === "scored" &&
    row.criteria_version !== null &&
    row.criteria_version !== SCORING_CRITERIA_VERSION &&
    !row.refresh_id
  )
    return {
      kind: "terminal",
      outcome: `criteria_${row.criteria_version}`,
    };
  if (
    !row ||
    !row.extract_generation ||
    row.invalidation_pending ||
    row.score_status !== "done" ||
    row.score_outcome !== "scored" ||
    !row.score_id ||
    !row.result ||
    !row.refresh_id ||
    row.criteria_version !== SCORING_CRITERIA_VERSION ||
    (row.due_at !== null && row.due_at <= now)
  )
    return { kind: "defer" };
  let parsed: {
    total: number;
    eligible: boolean;
    components: Record<string, number>;
    reasons: string[];
  };
  try {
    parsed = JSON.parse(row.result);
  } catch {
    return { kind: "terminal", outcome: "unparseable_score" };
  }
  return {
    kind: "ready",
    score: {
      scoreId: row.score_id,
      criteriaVersion: row.criteria_version,
      total: parsed.total,
      eligible: parsed.eligible,
      evidenceComponent: parsed.components?.evidence ?? 0,
      reasons: parsed.reasons ?? [],
    },
  };
}

interface EventRow {
  id: number;
  item_id: string;
  group_id: string | null;
  kind: string;
  source_id: string | null;
  native_id: string | null;
  reported_at: number | null;
  event_at: number | null;
  observed_at: number;
  version_id: number | null;
  evidence: string;
}

export class AlertWorker {
  private readonly alerts: AlertStore;
  constructor(
    private readonly store: Store,
    private readonly deliveries: DeliveryStore,
    private readonly config: AlertConfig,
  ) {
    this.alerts = new AlertStore(store.sqlite);
  }

  /**
   * Runs one bounded evaluation pass. Disabled configurations return a
   * disabled result without any database write; the daily digest path is
   * untouched either way. Each event decision runs in its own short immediate
   * transaction covering the suppression record or the freeze + outbox row,
   * so a crash anywhere leaves a consistent, replayable state.
   */
  evaluate(now = Date.now()): AlertTickResult {
    if (!this.config.sender || !this.config.recipient)
      throw new Error("Alert configuration incomplete");
    const db = this.store.sqlite;
    const cursorBefore = alertCursor(db);
    const events = db
      .query<EventRow, [number, number, number]>(
        "SELECT * FROM story_change_events WHERE id>? AND observed_at<=? ORDER BY id LIMIT ?",
      )
      .all(cursorBefore, now, SCAN_LIMIT);
    const fired: FiredAlert[] = [];
    const suppressed: SuppressedCandidate[] = [];
    const cancelled = this.cancelRegrouped();
    let deferred: DeferReason | null = null;
    let evaluatedCount = 0;
    for (const event of events) {
      if (deferred) break;
      const outcome = db.transaction(() => this.decide(event, now)).immediate();
      if ("deferred" in outcome) {
        // Attribution and currency cannot be decided yet: the batch stops and
        // the event is reconsidered, in order, on the next tick. Nothing was
        // suppressed and the durable cursor did not move.
        deferred = outcome.deferred;
        continue;
      }
      evaluatedCount += 1;
      if ("suppression" in outcome && outcome.suppression)
        suppressed.push(outcome.suppression);
      else if ("fired" in outcome && outcome.fired) fired.push(outcome.fired);
    }
    return {
      disabled: false,
      evaluated: evaluatedCount,
      deferred,
      fired,
      suppressed,
      cancelled,
    };
  }

  private decide(
    event: EventRow,
    now: number,
  ):
    | { deferred: DeferReason }
    | { immediate: false; suppression: SuppressedCandidate }
    | { immediate: false; fired: FiredAlert } {
    const db = this.store.sqlite;
    const suppress = (
      reason: SuppressionReason,
      details: Record<string, unknown> = {},
    ): { immediate: false; suppression: SuppressedCandidate } => {
      new AlertStore(db).suppress({
        changeEventId: event.id,
        reason,
        localDate: localPublicationDate(now, this.config.timezone),
        details: JSON.stringify(details),
        createdAt: now,
      });
      advanceAlertCursor(db, event.id, now);
      return {
        immediate: false,
        suppression: { changeEventId: event.id, reason },
      };
    };
    if (event.kind !== "content_change" && event.kind !== "new_coverage")
      return suppress("not_alertable_kind", { kind: event.kind });
    if (event.kind === "content_change") {
      // A URL-only edit records no new facts: without a recorded body or
      // headline change, re-alerting an unchanged story would only repeat
      // coverage after the cooldown. The recorded evidence qualifies the
      // update; a missing or unparsable evidence record stays conservative
      // and silent.
      const evidence = parseEvidence(event.evidence);
      if (evidence.titleChanged !== true && evidence.bodyChanged !== true)
        return suppress("cosmetic_change", {
          evidence: {
            titleChanged: evidence.titleChanged === true,
            bodyChanged: evidence.bodyChanged === true,
            urlChanged: evidence.urlChanged === true,
          },
        });
    }
    const groupId =
      event.group_id ??
      db
        .query<{ group_id: string }, [string]>(
          "SELECT group_id FROM story_memberships WHERE item_id=? AND ended_at IS NULL LIMIT 1",
        )
        .get(event.item_id)?.group_id ??
      null;
    if (!groupId)
      return now - event.observed_at < UNGROUPED_GRACE_MS
        ? { deferred: "ungrouped" }
        : suppress("development_ungrouped");
    if (
      event.kind === "new_coverage" &&
      this.countEarlierDevelopmentCoverage(groupId, event) > 0
    )
      return suppress("repeat_coverage", { groupId });
    const freshness = scoreState(this.store, event.item_id, now);
    // An unfinished or refreshing score defers the batch exactly like the
    // daily digest reports processing; the event is never retired here, so
    // alerts that run ahead of the processing stages merely wait for the
    // current score instead of discarding it permanently.
    if (freshness.kind === "defer") return { deferred: "scores_pending" };
    if (freshness.kind === "terminal")
      return suppress("score_unavailable", { terminal: freshness.outcome });
    const score = freshness.score;
    if (!score.eligible) return suppress("not_interest_eligible");
    if (score.total < this.config.minScore)
      return suppress("below_priority_threshold", {
        score: score.total,
        minScore: this.config.minScore,
      });
    if (score.evidenceComponent < this.config.minEvidence)
      return suppress("below_credibility_threshold", {
        evidence: score.evidenceComponent,
        minEvidence: this.config.minEvidence,
      });
    const existing = this.alerts.byChangeEvent(event.id);
    if (existing) return suppress("already_alerted");
    const latest = this.alerts.latestForGroup(groupId);
    if (latest && now - latest.frozenAt < this.config.cooldownHours * 3_600_000)
      return suppress("cooldown", {
        groupId,
        cooldownHours: this.config.cooldownHours,
        previousAlertId: latest.id,
      });
    const localDate = localPublicationDate(now, this.config.timezone);
    if (this.alerts.countForLocalDate(localDate) >= this.config.dailyCap)
      return suppress("daily_cap", {
        localDate,
        dailyCap: this.config.dailyCap,
      });
    const quiet = inQuietHours(now, this.config);
    const quietUntil = quiet ? quietEndInstant(now, this.config) : null;
    const version = event.version_id
      ? (db
          .query<{ title: string; url: string | null }, [number]>(
            "SELECT title,url FROM content_versions WHERE id=?",
          )
          .get(event.version_id) ?? null)
      : null;
    const title = version?.title ?? null;
    if (!title) return suppress("score_unavailable", { version_missing: true });
    const rendered = renderAlert({
      kind: event.kind,
      title,
      url: version?.url ?? null,
      observedAt: event.observed_at,
      evidence: parseEvidence(event.evidence),
      scoreTotal: score.total,
      scoreReasons: score.reasons,
      scoreCredibility: score.evidenceComponent,
      config: this.config,
    });
    const frozen = this.alerts.freeze(
      {
        changeEventId: event.id,
        kind: event.kind,
        itemId: event.item_id,
        groupId,
        localDate,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        scoreId: score.scoreId,
        decision: {
          version: ALERTS_DECISION_VERSION,
          trigger: {
            changeEventId: event.id,
            kind: event.kind,
            evidence: parseEvidence(event.evidence),
            reportedAt: event.reported_at,
            eventAt: event.event_at,
            observedAt: event.observed_at,
          },
          gates: {
            score: score.total,
            eligible: score.eligible,
            evidence: score.evidenceComponent,
            thresholds: {
              minScore: this.config.minScore,
              minEvidence: this.config.minEvidence,
            },
            quietUntil,
          },
          scoreId: score.scoreId,
          groupId,
        },
      },
      now,
    );
    if (!frozen) return suppress("already_alerted");
    this.deliveries.prepareAlert(
      frozen.id,
      localDate,
      this.config.recipient,
      this.config.sender,
      () => frozen,
      quietUntil ?? now,
      now,
    );
    advanceAlertCursor(db, event.id, now);
    return {
      immediate: false,
      fired: {
        alertId: frozen.id,
        changeEventId: event.id,
        kind: event.kind,
        itemId: event.item_id,
        groupId,
        quietUntil,
      },
    };
  }

  /**
   * Counts earlier recorded coverage of the same development that the event
   * would repeat. First coverage is normally recorded before grouping
   * resolves, with `group_id=NULL`, so a plain group lookup would miss it and
   * an unchanged republication could pass as first coverage and alert again
   * after the cooldown. Earlier unassigned events therefore resolve to a
   * development through the same membership-history evidence the recorded
   * change read uses: the event's item's live membership, or a membership
   * effective at the event's observation time.
   */
  private countEarlierDevelopmentCoverage(
    groupId: string,
    event: EventRow,
  ): number {
    return this.store.sqlite
      .query<{ n: number }, [number, string, string, string]>(
        `SELECT count(*) AS n FROM story_change_events e
         WHERE e.id<? AND e.kind IN ('new_coverage','content_change')
         AND (e.group_id=?
           OR (e.group_id IS NULL AND (
             (SELECT group_id FROM story_memberships m
              WHERE m.item_id=e.item_id AND m.ended_at IS NULL LIMIT 1)=?
           OR EXISTS (SELECT 1 FROM story_memberships m2
              WHERE m2.item_id=e.item_id AND m2.group_id=?
              AND m2.started_at<=e.observed_at
              AND (m2.ended_at IS NULL OR m2.ended_at>e.observed_at)))))`,
      )
      .get(event.id, groupId, groupId, groupId)!.n;
  }

  /**
   * Cancels pending alert deliveries whose cited development was regrouped
   * between the evaluate and send stages: the alert's development attribution
   * no longer matches the item's live membership. A sending/sent row is never
   * cancelled — an accepted provider send requires operator reconciliation.
   */
  cancelRegrouped(now = Date.now()): CancelledAlert[] {
    const rows = this.store.sqlite
      .query<{ alert_id: string; group_id: string; item_id: string }, []>(
        `SELECT d.alert_id,a.group_id,a.item_id FROM deliveries d
         JOIN alerts a ON a.id=d.alert_id
         WHERE d.status='pending' AND d.digest_id IS NULL LIMIT 100`,
      )
      .all();
    const cancelled: CancelledAlert[] = [];
    for (const row of rows) {
      if (!row.group_id) continue;
      const live = this.store.sqlite
        .query<{ group_id: string }, [string]>(
          "SELECT group_id FROM story_memberships WHERE item_id=? AND ended_at IS NULL LIMIT 1",
        )
        .get(row.item_id)?.group_id;
      if (live === row.group_id) continue;
      if (
        this.deliveries.cancelPendingAlert(
          row.alert_id,
          "development_regrouped",
          now,
        )
      )
        cancelled.push({
          alertId: row.alert_id,
          reason: "development_regrouped",
        });
    }
    return cancelled;
  }

  list(localDate?: string) {
    return this.alerts.list(localDate);
  }

  suppressions(limit = 200) {
    return this.alerts.listSuppressions(limit);
  }
}

/**
 * One scheduler tick for the opt-in alerts stage: evaluate pending change
 * events, then let the shared durable outbox flush a ready send through the
 * normal claim/lease/idempotency path (no send happens while a lease is
 * unset, and quiet-hour rows simply stay pending until their instant).
 */
export async function alertsTick(
  store: Store,
  deliveries: DeliveryStore,
  sender: DeliveryWorker,
  config: AlertConfig,
  now = Date.now(),
): Promise<AlertTickResult> {
  const worker = new AlertWorker(store, deliveries, config);
  const result = worker.evaluate(now);
  if (result.disabled) return result;
  // Flush the shared durable outbox on every enabled tick, whether or not
  // this evaluation fired anything: quiet-hour rows become due while an alert
  // tick sleeps, restarts strand pending rows, and one batch can freeze
  // several alerts. The loop drains every send that is ready NOW; a returned
  // false means nothing was claimable (all remaining work is scheduled for a
  // later instant and stays durable).
  for (let guard = 0; guard < FLUSH_LIMIT; guard += 1)
    if (!(await sender.send(now))) break;
  return result;
}
