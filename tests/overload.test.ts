import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/db/store";
import { ProcessingWorker } from "../src/worker";
import { createApp } from "../src/http";

const token = "overload-test-token-at-least-24-characters";
const tick = () => new Promise((r) => setTimeout(r, 5));

function seed(store: Store, count: number, offset = 0): void {
  // Real timestamps keep queue age meaningful for the readiness assertions.
  const now = Date.now();
  store.addSource("https://example.com/feed", "feed", 60);
  store.enqueueDue(now, true);
  const items = Array.from({ length: count }, (_, i) => ({
    nativeId: `n${offset + i}`,
    title: `Overload ${offset + i}`,
    text: `searchable body ${offset + i}`,
  }));
  store.complete(store.claim(now)!, { items }, now + 1);
}

describe("overload evidence", () => {
  test("a large backlog keeps stage concurrency and per-job time bounded", async () => {
    const store = new Store(":memory:");
    try {
      seed(store, 40);
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
        5_000,
        { extract: 3 },
      );
      const started = Date.now();
      expect(await worker.drain("extract", 100)).toBe(40);
      // The ceiling holds across the whole backlog, not just the first batch.
      expect(peak).toBe(3);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(
        store.status().health.queue.find((row) => row.stage === "extract")
          ?.pending ?? 0,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("items ingested during a saturated backlog remain searchable", async () => {
    const store = new Store(":memory:");
    try {
      seed(store, 10);
      const worker = new ProcessingWorker(
        store,
        {
          extract: async () => {
            // Each extraction is slow, so two are always in flight.
            await new Promise((r) => setTimeout(r, 30));
            return { status: "extracted" };
          },
        },
        5_000,
        { extract: 2 },
      );
      const draining = worker.drain("extract", 10);
      await tick();
      // Ingestion proceeds while extraction is saturated; the new item is
      // searchable without waiting for the backlog to drain.
      seed(store, 1, 100);
      expect(store.search("searchable body 100").length).toBe(1);
      await draining;
    } finally {
      store.close();
    }
  });

  test("durable counts survive a restart mid-backlog without double counting", () => {
    const dir = mkdtempSync(join(tmpdir(), "newspulse-overload-"));
    const path = join(dir, "state.sqlite");
    try {
      const first = new Store(path);
      seed(first, 5);
      const beforeClose = first.status().processing_jobs;
      first.close();

      const second = new Store(path);
      try {
        expect(second.status().processing_jobs).toEqual(beforeClose);
        expect(second.search("searchable").length).toBe(5);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("/health reports not-ready when a durable warning is present", async () => {
    const store = new Store(":memory:");
    try {
      // A source that keeps failing produces a durable warning.
      const source = store.addSource("https://example.com/broken", "feed", 60);
      store.sqlite
        .query("UPDATE sources SET failures=3,last_error='timeout' WHERE id=?")
        .run(source.id);
      const app = createApp(store, {
        token,
        allowedHosts: ["localhost"],
        allowedOrigins: [],
      });
      const body = (await (
        await app.request("http://localhost/health", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { ok: boolean; ready: boolean; warnings: string[] };
      expect(body.ok).toBe(true);
      expect(body.ready).toBe(false);
      expect(body.warnings).toContain("failing_sources");
    } finally {
      store.close();
    }
  });

  test("/health ignores disabled analysis queues, matching get_status", async () => {
    const store = new Store(":memory:");
    try {
      seed(store, 1);
      // Analysis is disabled, so its queued job is intentionally idle.
      store.sqlite
        .query(
          "INSERT INTO processing_jobs(id,item_id,stage,generation,status,attempts,available_at,queued_at,created_at) SELECT 'idle-analyse',id,'analyse',1,'pending',0,0,0,0 FROM items LIMIT 1",
        )
        .run();
      const env = {};
      const app = createApp(store, {
        token,
        allowedHosts: ["localhost"],
        allowedOrigins: [],
        mcp: { env },
      });
      const body = (await (
        await app.request("http://localhost/health", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { ready: boolean; warnings: string[] };
      const status = store.status({
        enabledStages: ["extract", "score", "group"],
      });
      expect(body.warnings).not.toContain("queue_age");
      expect(body.ready).toBe(status.health.ready);
    } finally {
      store.close();
    }
  });

  test("/health reports readiness behind the bearer token", async () => {
    const store = new Store(":memory:");
    try {
      seed(store, 1);
      const app = createApp(store, {
        token,
        allowedHosts: ["localhost"],
        allowedOrigins: [],
      });
      expect((await app.request("http://localhost/health")).status).toBe(401);
      const response = await app.request("http://localhost/health", {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as {
        ok: boolean;
        ready: boolean;
        warnings: string[];
        milestone?: string;
      };
      expect(body.ok).toBe(true);
      expect(body.ready).toBe(true);
      expect(body.warnings).toEqual([]);
      expect(body.milestone).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
