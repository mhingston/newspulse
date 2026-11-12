import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { ProcessingWorker } from "../src/worker";

function seedItems(store: Store, count: number): void {
  store.addSource("https://example.com/feed", "feed", 60);
  store.enqueueDue(1, true);
  const items = Array.from({ length: count }, (_, i) => ({
    nativeId: `n${i}`,
    title: `Title ${i}`,
    text: `body ${i}`,
  }));
  store.complete(store.claim(1)!, { items }, 2);
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

describe("processing stage concurrency", () => {
  test("a stage never runs more jobs than its configured ceiling", async () => {
    const store = new Store(":memory:");
    try {
      seedItems(store, 6);
      let inFlight = 0;
      let peak = 0;
      const worker = new ProcessingWorker(
        store,
        {
          extract: async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await tick();
            inFlight--;
            return { status: "extracted" };
          },
        },
        50_000,
        { extract: 2 },
      );
      expect(await worker.drain("extract", 20)).toBe(6);
      expect(peak).toBe(2);
    } finally {
      store.close();
    }
  });

  test("default stage concurrency stays serial", async () => {
    const store = new Store(":memory:");
    try {
      seedItems(store, 3);
      let inFlight = 0;
      let peak = 0;
      const worker = new ProcessingWorker(store, {
        extract: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await tick();
          inFlight--;
          return { status: "extracted" };
        },
      });
      expect(await worker.drain("extract", 20)).toBe(3);
      expect(peak).toBe(1);
    } finally {
      store.close();
    }
  });

  test("a saturated stage does not block a different stage", async () => {
    const store = new Store(":memory:");
    try {
      seedItems(store, 2);
      const scoreItem = store.search("body")[0]!.id;
      store.enqueueProcessing("score", scoreItem, 3);
      const hold = gate();
      const worker = new ProcessingWorker(
        store,
        {
          extract: async () => {
            await hold.promise;
            return { status: "extracted" };
          },
          score: async () => ({ status: "scored" }),
        },
        50_000,
        { extract: 1, score: 1 },
      );
      let scored = 0;
      const stuck = worker.drain("extract", 20);
      await tick();
      // The extract stage is saturated, yet score work still gets a slot.
      scored = await worker.drain("score", 2);
      expect(scored).toBeGreaterThan(0);
      hold.open();
      await stuck;
    } finally {
      store.close();
    }
  });

  test("a timed-out handler keeps its slot until it actually settles", async () => {
    const store = new Store(":memory:");
    try {
      seedItems(store, 2);
      const hold = gate();
      let started = 0;
      const worker = new ProcessingWorker(
        store,
        {
          extract: async () => {
            started++;
            // Ignores abort: keeps running past the timeout.
            await hold.promise;
            return { status: "extracted" };
          },
        },
        20,
        { extract: 1 },
      );
      const draining = worker.drain("extract", 2);
      await new Promise((r) => setTimeout(r, 80));
      // The first job timed out, but its handler is still running, so the
      // second job must not start in an oversubscribed slot.
      expect(started).toBe(1);
      hold.open();
      await draining;
    } finally {
      store.close();
    }
  });

  test("a retry in a spare slot does not replace the stuck handler's abort signal", async () => {
    const store = new Store(":memory:");
    try {
      seedItems(store, 2);
      const signals: AbortSignal[] = [];
      const hold = gate();
      const worker = new ProcessingWorker(
        store,
        {
          extract: async (_job, signal) => {
            signals.push(signal);
            // First invocation ignores abort and stays stuck; the second
            // completes, so the stuck handler is the only one still running.
            if (signals.length === 1) await hold.promise;
            return { status: "extracted" };
          },
        },
        20,
        { extract: 2 },
      );
      const draining = worker.drain("extract", 2);
      await new Promise((r) => setTimeout(r, 80));
      // The stuck invocation timed out and was aborted; its own signal must
      // be the one aborted, not a replacement from a later attempt.
      expect(signals[0]!.aborted).toBe(true);
      expect(signals.length).toBeGreaterThanOrEqual(2);
      expect(signals[1]!.aborted).toBe(false);
      hold.open();
      await draining;
    } finally {
      store.close();
    }
  });

  test("rejects invalid stage concurrency", () => {
    const store = new Store(":memory:");
    try {
      expect(
        () => new ProcessingWorker(store, {}, 50_000, { extract: 0 }),
      ).toThrow("Invalid stage concurrency");
    } finally {
      store.close();
    }
  });
});
