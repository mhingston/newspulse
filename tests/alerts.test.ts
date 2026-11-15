import { expect, test } from "bun:test";
import { DELIVERY_RETRY_WINDOW, DeliveryStore } from "../src/db/delivery-store";
import {
  DeliveryWorker,
  type DeliveryEmailProvider,
  type DeliveryMessage,
} from "../src/delivery";
import { DeliveryProviderError } from "../src/delivery";
import { AlertWorker, quietEndInstant, alertsTick } from "../src/alerts";
import {
  alertConfig,
  ALERTS_DECISION_VERSION,
  type AlertConfig,
} from "../src/alert-config";
import {
  alertConfigFromCorpus,
  alertEvaluationCorpusSchema,
  ingestWave,
  openAlertReplayStore,
  settleProcessing,
  type AlertEvaluationCorpus,
} from "../src/alert-evaluation";
import { draftDigest } from "../src/digest-service";
import corpusJson from "./fixtures/alert-evaluation-corpus-v1.json";

const corpus = alertEvaluationCorpusSchema.parse(corpusJson);

const at = (iso: string) => Date.parse(iso);
const waveSun = at("2026-10-18T12:00:00Z");
const waveIncident = at("2026-10-19T09:00:00Z");
const waveQuakeUpdate = at("2026-10-20T08:00:00Z");
const waveQuakeNight = at("2026-10-21T22:30:00Z");
const waveDst = at("2026-10-25T23:30:00Z");

class FakeProvider implements DeliveryEmailProvider {
  calls: { message: DeliveryMessage; key: string }[] = [];
  outcome: { id: string } | DeliveryProviderError | "hang" = {
    id: "provider-message-1",
  };
  send(
    message: DeliveryMessage,
    idempotencyKey: string,
  ): Promise<{ id: string }> {
    this.calls.push({ message, key: idempotencyKey });
    if (this.outcome === "hang") return new Promise(() => undefined);
    if (this.outcome instanceof DeliveryProviderError)
      return Promise.reject(this.outcome);
    return Promise.resolve(this.outcome);
  }
}

interface Rig {
  store: ReturnType<typeof openAlertReplayStore>["store"];
  deliveries: DeliveryStore;
  settings: AlertConfig;
  worker: AlertWorker;
  /** Mutable sender clock so tests control the definitive send instant. */
  clock: { now: number };
  /** Ingest one publication wave mid-test (keeps future scores invisible). */
  ingest: (wave: number) => void;
  /** Settle processing at an instant (mirrors the replay timeline's ticks). */
  settle: (now: number) => void;
  close: () => void;
}

/** Opens a replay store; `waves` are ingested immediately (no ticks yet). */
function rig(waves: number[], overrides: Partial<AlertConfig> = {}): Rig {
  const replay = openAlertReplayStore(corpus);
  const settings = { ...replay.settings, ...overrides };
  for (const wave of waves) ingestWave(replay, corpus, wave);
  const worker = new AlertWorker(replay.store, replay.deliveries, settings);
  const clock = { now: Date.now() };
  return {
    store: replay.store,
    deliveries: replay.deliveries,
    settings,
    worker,
    clock,
    ingest: (wave: number) => {
      ingestWave(replay, corpus, wave);
    },
    settle: (now: number) => {
      settleProcessing(replay.store, corpus, now);
    },
    close: () => replay.store.close(),
  };
}

/** A sender bound to the rig's mutable clock (real deployments use Date.now). */
function senderFor(test: Rig, provider: FakeProvider) {
  return new DeliveryWorker(test.deliveries, provider, () => test.clock.now);
}

test("quiet hours end computes DST-safe instants for Europe/London transitions", () => {
  const settings = alertConfigFromCorpus(corpus.alertSettings);
  // Spring forward: 01:00 GMT becomes 02:00 BST on 2026-03-29; 07:00 BST = 06:00Z.
  expect(quietEndInstant(at("2026-03-29T00:30:00Z"), settings)).toBe(
    at("2026-03-29T06:00:00Z"),
  );
  // Autumn overlap: clocks fall back 01:00Z; 07:00 GMT = 07:00Z.
  expect(quietEndInstant(at("2026-10-25T00:30:00Z"), settings)).toBe(
    at("2026-10-25T07:00:00Z"),
  );
  // Evening evaluation schedules the next morning's quiet end.
  expect(quietEndInstant(at("2026-10-19T22:30:00Z"), settings)).toBe(
    at("2026-10-20T06:00:00Z"),
  );
});

test("updated events alert within the tick; thresholds and eligibility gates record why others are silent", () => {
  // Ticks run strictly in chronological order below and each wave is
  // ingested only once its own tick has run (no future scores leak back).
  const test = rig([]);
  try {
    test.ingest(waveSun);
    // Earlier events are consumed by their own ticks with recorded reasons:
    // the quake seed (score 66 < minScore 75) is below the priority
    // threshold; the atlas release matches no interest.
    const seed = test.worker.evaluate(at("2026-10-18T12:30:00Z"));
    expect(seed.fired).toHaveLength(0);
    expect(seed.suppressed.map((row) => row.reason).sort()).toEqual([
      "below_priority_threshold",
      "not_interest_eligible",
    ]);
    test.ingest(waveIncident);
    const fire = test.worker.evaluate(at("2026-10-19T09:30:00Z"));
    expect(fire.fired).toHaveLength(1);
    // The quake update (recorded changed facts) fires at its own later tick.
    test.ingest(waveQuakeUpdate);
    const update = test.worker.evaluate(at("2026-10-20T08:30:00Z"));
    expect(update.fired.map((fired) => fired.kind)).toEqual(["content_change"]);
    const alert = JSON.parse(test.worker.list()[0]!.decision) as Record<
      string,
      unknown
    >;
    expect(alert["version"]).toBe(ALERTS_DECISION_VERSION);
    expect((alert["gates"] as Record<string, unknown>)["thresholds"]).toEqual({
      minScore: corpus.alertSettings.minScore,
      minEvidence: corpus.alertSettings.minEvidence,
    });
    expect((alert["trigger"] as Record<string, unknown>)["kind"]).toBe(
      "new_coverage",
    );
  } finally {
    test.close();
  }
});

test("repeat coverage of an alerted development is suppressed with a recorded reason", () => {
  // repeat-1 (verbatim republication of the quake update) joins the quake
  // development at its own wave; its new_coverage event is not the
  // development's first.
  const test = rig([]);
  try {
    test.ingest(waveSun);
    test.worker.evaluate(at("2026-10-18T12:30:00Z"));
    test.ingest(waveIncident);
    test.worker.evaluate(at("2026-10-19T09:30:00Z"));
    test.ingest(waveQuakeUpdate);
    test.worker.evaluate(at("2026-10-20T08:30:00Z"));
    test.ingest(at("2026-10-20T10:00:00Z"));
    test.settle(at("2026-10-20T10:30:00Z"));
    const repeat = test.worker.evaluate(at("2026-10-20T10:30:00Z"));
    expect(repeat.fired).toHaveLength(0);
    expect(
      repeat.suppressed.find((row) => row.reason === "repeat_coverage"),
    ).toBeDefined();
    expect(test.worker.evaluate(at("2026-10-20T11:00:00Z")).fired).toHaveLength(
      0,
    );
  } finally {
    test.close();
  }
});

test("a second recorded update inside the cooldown window is suppressed, outside it fires", () => {
  const short = rig([]);
  try {
    short.ingest(waveSun);
    short.ingest(waveIncident);
    short.ingest(waveQuakeUpdate);
    short.worker.evaluate(at("2026-10-20T08:30:00Z"));
    short.ingest(waveQuakeNight);
    short.settle(at("2026-10-21T23:00:00Z"));
    const night = short.worker.evaluate(at("2026-10-21T23:00:00Z"));
    // quake's second changed-facts update lands inside the 12h cooldown? No:
    // 38.5h later, so it fires (quiet hours schedule the send past 07:00).
    const quietFired = night.fired.find(
      (fired) => fired.kind === "content_change" && fired.quietUntil !== null,
    );
    expect(quietFired).toBeDefined();
    expect(new Date(quietFired!.quietUntil!).toISOString()).toBe(
      "2026-10-22T06:00:00.000Z",
    );
  } finally {
    short.close();
  }
  const long = rig([], { cooldownHours: 168 });
  try {
    long.ingest(waveSun);
    long.ingest(waveIncident);
    long.ingest(waveQuakeUpdate);
    long.worker.evaluate(at("2026-10-20T08:30:00Z"));
    long.ingest(waveQuakeNight);
    long.settle(at("2026-10-21T23:00:00Z"));
    const night = long.worker.evaluate(at("2026-10-21T23:00:00Z"));
    expect(
      night.suppressed.find((row) => row.reason === "cooldown"),
    ).toBeDefined();
    expect(
      night.fired.filter((fired) => fired.kind === "content_change"),
    ).toHaveLength(0);
  } finally {
    long.close();
  }
});

test("quiet hours schedule the send after the window without suppressing the alert", () => {
  const test = rig([]);
  try {
    test.ingest(waveSun);
    test.ingest(waveIncident);
    test.ingest(waveQuakeUpdate);
    test.ingest(waveQuakeNight);
    test.worker.evaluate(at("2026-10-21T23:00:00Z"));
    const pending = test.deliveries
      .list()
      .filter((row) => row.alert_id && row.status === "pending")
      .map((row) => row.available_at)
      .sort((a, b) => a - b);
    expect(pending.length).toBeGreaterThan(0);
    // The quiet send is scheduled at 07:00 local (06:00Z, BST) on 2026-10-22.
    expect(new Date(pending[pending.length - 1] ?? 0).toISOString()).toBe(
      "2026-10-22T06:00:00.000Z",
    );
    // Before the quiet end nothing is claimable; at the quiet end it is.
    expect(test.deliveries.claim(at("2026-10-22T05:59:59Z"))).toBeNull();
    expect(test.deliveries.claim(at("2026-10-22T06:00:00Z"))).not.toBeNull();
  } finally {
    test.close();
  }
});

test("daily cap suppresses a second same-day alert and resets the next day", () => {
  const test = rig([waveSun, waveIncident, waveQuakeUpdate, waveDst], {
    cooldownHours: 0,
    minScore: 60,
    minEvidence: 30,
    dailyCap: 1,
  });
  try {
    // The quake seed event is the only candidate at this tick under the
    // lowered gates; it consumes the local day's cap.
    const first = test.worker.evaluate(at("2026-10-19T00:00:00Z"));
    expect(first.fired).toHaveLength(1);
    // Same local day: the incident's alert is suppressed by the cap.
    const second = test.worker.evaluate(at("2026-10-19T09:30:00Z"));
    expect(
      second.suppressed.find((row) => row.reason === "daily_cap"),
    ).toBeDefined();
    expect(second.fired).toHaveLength(0);
    // A later local day resets the cap and the next candidate alerts.
    const later = test.worker.evaluate(at("2026-10-26T00:00:00Z"));
    expect(later.fired.length).toBeGreaterThanOrEqual(1);
  } finally {
    test.close();
  }
});

test("freeze commits before any network work and the restarted send runs exactly once", async () => {
  const test = rig([waveSun, waveIncident]);
  try {
    const result = test.worker.evaluate(at("2026-10-19T09:30:00Z"));
    expect(result.fired).toHaveLength(1);
    // Simulated crash before any send: the durable outbox row exists with a
    // stable idempotency key; a restarted sender delivers exactly once.
    const provider = new FakeProvider();
    const sender = senderFor(test, provider);
    expect(provider.calls).toHaveLength(0);
    test.clock.now = at("2026-10-19T09:30:01Z");
    await sender.send(test.clock.now);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.key.startsWith("newspulse/alert/")).toBe(true);
    expect(
      provider.calls[0]!.message.subject.startsWith("[NewsPulse alert]"),
    ).toBe(true);
    const row = test.deliveries.list()[0]!;
    expect(row.status).toBe("sent");
    expect(row.digest_id).toBeNull();
    expect(row.alert_id).toBe(result.fired[0]!.alertId);
    // A repeat send finds nothing due.
    test.clock.now = at("2026-10-19T09:35:00Z");
    await sender.send(test.clock.now);
    expect(provider.calls).toHaveLength(1);
  } finally {
    test.close();
  }
});

test("crash after provider acceptance leaves an ambiguous row that never resends automatically", async () => {
  const test = rig([waveSun, waveIncident]);
  try {
    test.worker.evaluate(at("2026-10-19T09:30:00Z"));
    const now = at("2026-10-19T09:31:00Z");
    const provider = new FakeProvider();
    const sender = senderFor(test, provider);
    const claim = test.deliveries.claim(now)!;
    expect(test.deliveries.beginSend(claim, now)).toBe(true);
    await provider.send({} as DeliveryMessage, claim.idempotency_key);
    // The lease expires without a persisted acceptance: the crash boundary.
    test.store.sqlite
      .query("UPDATE deliveries SET lease_until=? WHERE id=?")
      .run(now - 1, claim.id);
    const later = now + 120_000;
    expect(test.deliveries.claim(later)).toBeNull();
    expect(provider.calls).toHaveLength(1);
    expect(test.deliveries.list()[0]!.status).toBe("ambiguous");
    // Operator reconciliation 'not_sent' re-arms exactly the same key.
    test.deliveries.reconcile(claim.id, "not_sent", null, later + 1);
    test.clock.now = later + 2;
    await sender.send(test.clock.now);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.key).toBe(provider.calls[0]!.key);
  } finally {
    test.close();
  }
});

test("provider idempotency expiry blocks sends outside the documented window", async () => {
  const test = rig([waveSun, waveIncident]);
  try {
    test.worker.evaluate(at("2026-10-19T09:30:00Z"));
    const now = at("2026-10-19T09:31:00Z");
    const claim = test.deliveries.claim(now)!;
    expect(test.deliveries.beginSend(claim, now)).toBe(true);
    test.store.sqlite
      .query(
        "UPDATE deliveries SET lease_until=?,first_attempt_at=? WHERE id=?",
      )
      .run(now + 60_000, now - DELIVERY_RETRY_WINDOW - 60_000, claim.id);
    const provider = new FakeProvider();
    const sender = senderFor(test, provider);
    test.clock.now = now + 1;
    await sender.send(test.clock.now);
    expect(provider.calls).toHaveLength(0);
    // beginSend refuses the stale first attempt, so the row stays 'sending'
    // until its lease expires; the next claim reconciles it as ambiguous.
    expect(test.deliveries.claim(now + 60_000 + 1)).toBeNull();
    expect(test.deliveries.list()[0]!.status).toBe("ambiguous");
  } finally {
    test.close();
  }
});

test("cancellation between evaluate and send stops a regrouped development's alert", () => {
  const test = rig([waveSun, waveIncident]);
  try {
    const result = test.worker.evaluate(at("2026-10-19T09:30:00Z"));
    expect(result.fired).toHaveLength(1);
    const alertId = result.fired[0]!.alertId;
    const itemId = result.fired[0]!.itemId;
    // The development is regrouped away before the send stage runs.
    test.store.sqlite
      .query("UPDATE story_memberships SET ended_at=? WHERE item_id=?")
      .run(at("2026-10-19T09:40:00Z"), itemId);
    const later = test.worker.evaluate(at("2026-10-19T09:45:00Z"));
    expect(later.cancelled).toEqual([
      { alertId, reason: "development_regrouped" },
    ]);
    expect(test.deliveries.claim(at("2026-10-19T09:46:00Z"))).toBeNull();
    const row = test.deliveries.list()[0]!;
    expect(row.status).toBe("cancelled");
    expect(row.last_error).toBe("development_regrouped");
    // A cancelled row cannot be cancelled again, and a sending row is never
    // cancelled through this path.
    expect(
      test.deliveries.cancelPendingAlert(
        alertId,
        "second",
        at("2026-10-19T09:47:00Z"),
      ),
    ).toBe(false);
  } finally {
    test.close();
  }
});

test("default deployments construct no alert worker and send nothing", () => {
  expect(alertConfig({})).toBeNull();
  expect(alertConfig({ ALERTS_ENABLED: "false" })).toBeNull();
  expect(() => alertConfig({ ALERTS_ENABLED: "maybe" })).toThrow();
  expect(() => alertConfig({ ALERTS_ENABLED: "true" })).toThrow(
    /RESEND_API_KEY/,
  );
});

test("alert activity leaves the daily digest draft byte-identical", () => {
  const test = rig([
    waveSun,
    waveIncident,
    waveQuakeUpdate,
    waveQuakeNight,
    waveDst,
  ]);
  try {
    const digestAt = at("2026-10-22T06:00:00Z");
    const options = {
      date: "2026-10-22",
      timezone: "Europe/London",
      now: digestAt,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    };
    const before = draftDigest(test.store, options);
    test.worker.evaluate(at("2026-10-19T09:30:00Z"));
    test.worker.evaluate(at("2026-10-20T08:30:00Z"));
    test.worker.evaluate(at("2026-10-21T23:00:00Z"));
    test.worker.evaluate(at("2026-10-26T00:00:00Z"));
    const after = draftDigest(test.store, options);
    expect(JSON.stringify(before)).toBe(JSON.stringify(after));
    // And no live network work happened in evaluation: no provider id was
    // recorded anywhere.
    expect(
      test.deliveries.list().every((row) => row.provider_id === null),
    ).toBe(true);
  } finally {
    test.close();
  }
});

test("alertsTick evaluates and drives the shared outbox send path", async () => {
  const test = rig([waveSun, waveIncident]);
  try {
    const provider = new FakeProvider();
    const sender = senderFor(test, provider);
    test.clock.now = at("2026-10-19T09:30:00Z");
    const result = await alertsTick(
      test.store,
      test.deliveries,
      sender,
      test.settings,
      at("2026-10-19T09:30:00Z"),
    );
    expect(result.fired).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    const sent = test.deliveries.list()[0]!;
    expect(sent.status).toBe("sent");
    // Operating diagnostics stay count-only and always present.
    const status = test.store.status();
    expect(status.alerts).toEqual({
      alerts: 1,
      pending_deliveries: 0,
      suppressions: [
        { reason: "below_priority_threshold", count: 1 },
        { reason: "not_interest_eligible", count: 1 },
      ],
    });
  } finally {
    test.close();
  }
});
