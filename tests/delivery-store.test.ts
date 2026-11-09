import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import {
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_WINDOW,
  DeliveryStore,
} from "../src/db/delivery-store";
import { DeliveryWorker, type DeliveryEmailProvider } from "../src/delivery";

const date = "2026-11-09";
function fixture() {
  const store = new Store(":memory:");
  const deliveries = new DeliveryStore(store.sqlite);
  const freeze = () =>
    new DigestStore(store.sqlite).freeze(
      {
        date,
        timezone: "Europe/London",
        subject: "News",
        html: "<p>Story</p>",
        text: "Story",
        decisionSnapshot: {},
        items: [
          { itemId: "story", groupId: null, scoreId: null, snapshot: {} },
        ],
      },
      1,
    );
  const prepare = () =>
    deliveries.prepare(
      date,
      "Reader@EXAMPLE.test",
      "sender@example.test",
      freeze,
      1000,
    )!;
  return { store, deliveries, freeze, prepare };
}

test("freeze and outbox commit atomically and reuse the original envelope", () => {
  const { store, deliveries, freeze, prepare } = fixture();
  try {
    expect(() =>
      deliveries.prepare(
        date,
        "reader@example.test",
        "sender@example.test",
        () => {
          freeze();
          throw new Error("crash");
        },
        1000,
      ),
    ).toThrow();
    expect(new DigestStore(store.sqlite).get(date)).toBeNull();
    expect(deliveries.list()).toHaveLength(0);
    const row = prepare();
    expect(row.recipient).toBe("Reader@example.test");
    expect(
      deliveries.prepare(
        date,
        "Reader@example.test",
        "other@example.test",
        () => {
          throw new Error("must not refreeze");
        },
        2000,
      ),
    ).toEqual(row);
  } finally {
    store.close();
  }
});

test("fences stale claims, safely reclaims before send and blocks expired ambiguity", () => {
  const { store, deliveries, prepare } = fixture();
  try {
    const row = prepare();
    const a = deliveries.claim(1000)!;
    const b = deliveries.claim(61001)!;
    expect(deliveries.beginSend(a, 61001)).toBe(false);
    expect(deliveries.beginSend(b, 61001)).toBe(true);
    const c = deliveries.claim(121002)!;
    expect(c.idempotency_key).toBe(row.idempotency_key);
    expect(deliveries.sent(b, "provider", 121002)).toBe(false);
    expect(deliveries.beginSend(c, 121002)).toBe(true);
    expect(deliveries.fail(c, "ambiguous", 121003)).toBe(true);
    expect(deliveries.claim(61001 + DELIVERY_RETRY_WINDOW)).toBeNull();
    expect(deliveries.get(row.id)?.status).toBe("ambiguous");
    deliveries.reconcile(
      row.id,
      "not_sent",
      null,
      61001 + DELIVERY_RETRY_WINDOW,
    );
    const retry = deliveries.claim(61001 + DELIVERY_RETRY_WINDOW)!;
    expect(retry.idempotency_key).toBe(row.idempotency_key);
  } finally {
    store.close();
  }
});

test("crash after acceptance retries with same key and produces one effective send", async () => {
  const { store, deliveries, prepare } = fixture();
  try {
    const row = prepare();
    const beforeCrash = Date.now() - 120_000;
    const claim = deliveries.claim(beforeCrash)!;
    expect(deliveries.beginSend(claim, beforeCrash)).toBe(true);
    const accepted = new Map<string, string>([
      [claim.idempotency_key, "provider_1"],
    ]);
    let calls = 0;
    const provider: DeliveryEmailProvider = {
      async send(_message, key) {
        calls++;
        const id = accepted.get(key) ?? "provider_2";
        accepted.set(key, id);
        return { id };
      },
    };
    // Simulate restart after lease expiry: same key reaches fake provider.
    await new DeliveryWorker(deliveries, provider).send(Date.now());
    expect(calls).toBe(1);
    expect(accepted.size).toBe(1);
    expect(deliveries.get(row.id)?.status).toBe("sent");
  } finally {
    store.close();
  }
});

test("ambiguous sends stop after ten attempts until verified not sent", () => {
  const { store, deliveries, prepare } = fixture();
  try {
    const row = prepare();
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i++) {
      const now = 1000 + i * 60_001;
      const claim = deliveries.claim(now)!;
      expect(claim.attempts).toBe(i + 1);
      expect(deliveries.beginSend(claim, now)).toBe(true);
      expect(deliveries.fail(claim, "ambiguous", now)).toBe(true);
    }
    expect(deliveries.claim(1_000_000)).toBeNull();
    expect(deliveries.get(row.id)?.status).toBe("ambiguous");
    deliveries.reconcile(row.id, "not_sent", null, 1_000_000);
    expect(deliveries.claim(1_000_000)?.attempts).toBe(1);
  } finally {
    store.close();
  }
});

test("repeated crashes before calling provider exhaust the bounded claim budget", () => {
  const { store, deliveries, prepare } = fixture();
  try {
    const row = prepare();
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i++)
      expect(deliveries.claim(1000 + i * 60_001)).not.toBeNull();
    expect(deliveries.claim(1000 + DELIVERY_MAX_ATTEMPTS * 60_001)).toBeNull();
    expect(deliveries.get(row.id)?.status).toBe("failed");
    deliveries.reconcile(row.id, "not_sent", null, 1_000_000);
    expect(deliveries.claim(1_000_000)?.attempts).toBe(1);
  } finally {
    store.close();
  }
});

test("dispatch checks the live clock after claiming and never sends an expired lease", async () => {
  const { store, deliveries, prepare } = fixture();
  try {
    prepare();
    let calls = 0;
    const provider: DeliveryEmailProvider = {
      async send() {
        calls++;
        return { id: "provider" };
      },
    };
    const worker = new DeliveryWorker(deliveries, provider, () => 61_001);
    await worker.send(1000);
    expect(calls).toBe(0);
    expect(deliveries.list()[0]?.first_attempt_at).toBeNull();
  } finally {
    store.close();
  }
});

test("email addresses require dot-separated atoms and valid domain labels", () => {
  for (const address of [
    ".reader@example.com",
    "reader.@example.com",
    "reader@foo-.example.com",
    "reader@-foo.example.com",
    "reader..name@example.com",
    "reader@example..com",
  ]) {
    const { store, deliveries } = fixture();
    try {
      expect(() =>
        deliveries.prepare(
          date,
          address,
          "sender@example.com",
          () => null,
          1000,
        ),
      ).toThrow();
    } finally {
      store.close();
    }
  }
});
