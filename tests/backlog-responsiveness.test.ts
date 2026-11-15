import { expect, test } from "bun:test";
import { Store, type ProcessingJob } from "../src/db/store";
import { createApp } from "../src/http";
import { ProcessingWorker, Worker, schedule } from "../src/worker";
import { scoringHandler } from "../src/scoring-service";
import type { Candidate } from "../src/domain";

const token = "backlog-test-token-at-least-24-characters";
const BACKLOG = 200;
/** Article-sized bodies: grouping hashes the text it compares. */
const body =
  "Detailed report on the rollout, its measurements and the effect on operators. ".repeat(
    12,
  );

function backlog(count: number): Candidate[] {
  return Array.from({ length: count }, (_, index) => ({
    nativeId: `native-${index}`,
    url: `https://example.com/articles/${index}`,
    title: `Deployment report ${index} for service ${index}`,
    text: `Feed description for article ${index}. ${body.slice(0, 200)}`,
  }));
}

test("a queued backlog keeps the HTTP service answering", async () => {
  const store = new Store(":memory:");
  try {
    store.addSource("https://example.com/feed.xml", "Backlog feed");
    store.enqueueDue(1);
    const poll = store.claim(1)!;
    expect(store.complete(poll, { items: backlog(BACKLOG) }, 2)).toBe(true);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM items")
        .get(),
    ).toEqual({ n: BACKLOG });

    const app = createApp(store, {
      token,
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
      mcp: {},
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
    });
    const processing = new ProcessingWorker(
      store,
      {
        // No network: the stage handler returns the body it would have read.
        extract: async (job: ProcessingJob) => ({
          status: "extracted",
          result: JSON.stringify({
            status: "extracted",
            text: `${body} Article ${job.item_id}.`,
            method: "http",
            at: Date.now(),
          }),
        }),
        group: async () => {
          const result = store.stories.reconcile();
          if (result.stale)
            throw new Error("Story inputs changed during grouping");
          return {
            status: "grouped",
            result: JSON.stringify(result),
            fullPass: result.changed,
          };
        },
        score: scoringHandler(store),
      },
      undefined,
      { extract: 2, score: 2 },
    );
    const scheduler = schedule(
      store,
      new Worker(store, { poll: async () => ({ items: [] }) }),
      processing,
    );
    try {
      const latencies: number[] = [];
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const started = performance.now();
        const response = await fetch(new URL("/health", server.url), {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2000),
        });
        latencies.push(performance.now() - started);
        expect(response.status).toBe(200);
        await Bun.sleep(25);
      }
      expect(Math.max(...latencies)).toBeLessThan(1000);
      // The backlog drained while the service stayed answerable, and the
      // ingested items stayed queryable throughout.
      const queue = store.status().health.queue;
      const pending = (stage: string) =>
        queue.find((entry) => entry.stage === stage)?.pending ?? 0;
      expect(pending("extract")).toBeLessThan(BACKLOG);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM story_memberships",
          )
          .get(),
      ).toEqual({ n: BACKLOG });
      expect(store.search("Deployment").length).toBeGreaterThan(0);
    } finally {
      await scheduler.stop();
      server.stop(true);
    }
  } finally {
    store.close();
  }
}, 60_000);
