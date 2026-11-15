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
 * meaningful update (recorded changed facts, or the first recorded coverage
 * of a development), never merely a high scoring article. Thresholds
 * (priority/credibility), quiet hours (Europe/London semantics, DST-safe via
 * the shipped publication calendar), per-development cooldowns, a daily cap
 * and per-event deduplication are explicit user configuration; disabled by
 * default an evaluation sends nothing and writes nothing. Delivery reuses the
 * existing durable outbox and idempotency rules; nothing here contacts a
 * provider inside a transaction.
 */

/** Events younger than this may still be awaiting grouping; do not skip them. */
const UNGROUPED_GRACE_MS = 15 * 60_000;
const SCAN_LIMIT = 500;

export type SuppressionReason =
  | "not_alertable_kind"
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

export interface AlertTickResult {
  disabled: boolean;
  evaluated: number;
  /** Set when an ungrouped young event stops the batch to await grouping. */
  deferredUngrouped: boolean;
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

/** The item's latest completed deterministic score, or null when unfinished. */
export function latestScore(
  store: Store,
  itemId: string,
): {
  scoreId: string;
  criteriaVersion: string;
  total: number;
  eligible: boolean;
  evidenceComponent: number;
  reasons: string[];
} | null {
  const row = store.sqlite
    .query<
      { score_id: string; criteria_version: string; result: string },
      [string]
    >(
      `SELECT s.id AS score_id,s.criteria_version,s.result FROM item_scores s
       WHERE s.item_id=? AND s.generation=(SELECT max(e.generation) FROM processing_jobs e WHERE e.stage='extract' AND e.item_id=s.item_id)
       ORDER BY s.created_at DESC,s.rowid DESC LIMIT 1`,
    )
    .get(itemId);
  if (!row) return null;
  let parsed: {
    total: number;
    eligible: boolean;
    components: Record<string, number>;
    reasons: string[];
  };
  try {
    parsed = JSON.parse(row.result);
  } catch {
    return null;
  }
  return {
    scoreId: row.score_id,
    criteriaVersion: row.criteria_version,
    total: parsed.total,
    eligible: parsed.eligible,
    evidenceComponent: parsed.components?.evidence ?? 0,
    reasons: parsed.reasons ?? [],
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
    let deferredUngrouped = false;
    let evaluatedCount = 0;
    for (const event of events) {
      if (deferredUngrouped) break;
      const outcome = db.transaction(() => this.decide(event, now)).immediate();
      if ("immediate" in outcome && outcome.immediate) {
        // A young ungrouped event stopped the batch before the cursor moved.
        deferredUngrouped = true;
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
      deferredUngrouped,
      fired,
      suppressed,
      cancelled,
    };
  }

  private decide(
    event: EventRow,
    now: number,
  ):
    | { immediate: true }
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
        ? { immediate: true }
        : suppress("development_ungrouped");
    if (
      event.kind === "new_coverage" &&
      db
        .query<{ n: number }, [string, number]>(
          "SELECT count(*) AS n FROM story_change_events WHERE group_id=? AND id<?",
        )
        .get(groupId, event.id)!.n > 0
    )
      return suppress("repeat_coverage", { groupId });
    const score = latestScore(this.store, event.item_id);
    if (!score) return suppress("score_unavailable");
    if (score.criteriaVersion !== SCORING_CRITERIA_VERSION)
      return suppress("score_version_stale", {
        criteriaVersion: score.criteriaVersion,
      });
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
  // Flush the shared outbox: any ready pending send (this tick's alerts, plus
  // quiet-hour rows whose instant has now passed) is claimed exactly once.
  if (result.fired.length > 0) await sender.send(now);
  return result;
}
