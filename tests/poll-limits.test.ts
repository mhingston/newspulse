import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { Worker, hostOfSource } from "../src/worker";
import type { PollResult, SourceAdapter } from "../src/domain";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function instant(): PollResult {
  return { items: [] };
}

describe("poll concurrency and per-host fairness", () => {
  test("a slow host cannot occupy every poll slot", async () => {
    const store = new Store(":memory:");
    try {
      store.addSource("https://slow.example/a.xml", "slow a", 60);
      store.addSource("https://slow.example/b.xml", "slow b", 60);
      store.addSource("https://ok.example/feed.xml", "ok", 60);
      store.enqueueDue(0, true);
      const started: string[] = [];
      const hold = gate();
      const adapter: SourceAdapter = {
        async poll(url) {
          started.push(url);
          if (url.includes("slow.")) await hold.promise;
          return instant();
        },
      };
      const worker = new Worker(store, adapter, {
        concurrency: 2,
        perHost: 1,
      });
      const draining = worker.drain(10);
      // Let the first wave start. Only one slow poll may be in flight, so the
      // healthy feed still gets the second slot.
      await new Promise((r) => setTimeout(r, 20));
      expect(started.filter((u) => u.includes("slow."))).toHaveLength(1);
      expect(started.some((u) => u.includes("ok.example"))).toBe(true);
      hold.open();
      expect(await draining).toBe(3);
    } finally {
      store.close();
    }
  });

  test("concurrency ceiling bounds simultaneous polls", async () => {
    const store = new Store(":memory:");
    try {
      for (let i = 0; i < 6; i++)
        store.addSource(`https://h${i}.example/feed.xml`, `h${i}`, 60);
      store.enqueueDue(0, true);
      let inFlight = 0;
      let peak = 0;
      const adapter: SourceAdapter = {
        async poll() {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return instant();
        },
      };
      expect(
        await new Worker(store, adapter, { concurrency: 3, perHost: 1 }).drain(
          20,
        ),
      ).toBe(6);
      expect(peak).toBe(3);
    } finally {
      store.close();
    }
  });

  test("default limits keep one poll at a time", async () => {
    const store = new Store(":memory:");
    try {
      store.addSource("https://a.example/feed.xml", "a", 60);
      store.addSource("https://b.example/feed.xml", "b", 60);
      store.enqueueDue(0, true);
      let inFlight = 0;
      let peak = 0;
      const adapter: SourceAdapter = {
        async poll() {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight--;
          return instant();
        },
      };
      await new Worker(store, adapter).drain(10);
      expect(peak).toBe(1);
    } finally {
      store.close();
    }
  });

  test("a reclaimed lease is not counted twice against the host ceiling", () => {
    const store = new Store(":memory:");
    try {
      store.addSource("https://one.example/a.xml", "a", 60);
      store.addSource("https://one.example/b.xml", "b", 60);
      store.enqueueDue(0, true);
      const first = store.claim(1000, {
        hostLimit: 1,
        hostOf: hostOfSource,
      });
      expect(first).not.toBeNull();
      // Same host is saturated while the first lease is live.
      expect(
        store.claim(1000, { hostLimit: 1, hostOf: hostOfSource }),
      ).toBeNull();
      // After the lease expires it is recovered, not double counted: exactly
      // one job for the host is claimable again.
      const recovered = store.claim(1000 + 61_000, {
        hostLimit: 1,
        hostOf: hostOfSource,
      });
      expect(recovered).not.toBeNull();
      expect(
        store.claim(1000 + 61_000, { hostLimit: 1, hostOf: hostOfSource }),
      ).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a healthy feed behind more than 500 blocked jobs is still claimed", () => {
    const store = new Store(":memory:");
    try {
      store.addSource("https://busy.example/running.xml", "running", 60);
      for (let i = 0; i < 600; i++)
        store.addSource(`https://busy.example/feed${i}.xml`, `busy${i}`, 60);
      store.addSource("https://healthy.example/feed.xml", "healthy", 60);
      store.enqueueDue(0, true);
      // Earliest due jobs all belong to the busy host, which is at its ceiling.
      const running = store.claim(1000, { hostLimit: 1, hostOf: hostOfSource });
      expect(new URL(store.source(running!.source_id)!.url).hostname).toBe(
        "busy.example",
      );
      const next = store.claim(1000, { hostLimit: 1, hostOf: hostOfSource });
      expect(next).not.toBeNull();
      expect(new URL(store.source(next!.source_id)!.url).hostname).toBe(
        "healthy.example",
      );
    } finally {
      store.close();
    }
  });

  test("rejects invalid limits", () => {
    const store = new Store(":memory:");
    try {
      const adapter: SourceAdapter = { poll: async () => instant() };
      expect(
        () => new Worker(store, adapter, { concurrency: 0, perHost: 1 }),
      ).toThrow("Invalid poll limits");
      expect(
        () => new Worker(store, adapter, { concurrency: 1, perHost: 0 }),
      ).toThrow("Invalid poll limits");
    } finally {
      store.close();
    }
  });
});
