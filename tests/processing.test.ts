import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";

describe("processing jobs", () => {
  test("persist, deduplicate, renew and fence item work", () => {
    const store = new Store(":memory:");
    const source = store.addSource("https://example.com/feed");
    store.enqueueDue(1);
    const poll = store.claim(1)!;
    expect(
      store.complete(
        poll,
        { items: [{ nativeId: "a", title: "Alpha", text: "searchable" }] },
        2,
      ),
    ).toBe(true);
    const item = store.search("searchable")[0]!;
    expect(store.enqueueProcessing("extract", item.id, 3)).toBe(false);
    expect(store.enqueueProcessing("extract", item.id, 3)).toBe(false);
    const first = store.claimProcessing("extract", 3)!;
    expect(store.renewProcessing(first, 10, 4)).toBe(true);
    expect(store.completeProcessing(first, "extracted", 14)).toBe(false);
    const second = store.claimProcessing("extract", 14)!;
    expect(store.completeProcessing(first, "extracted", 15)).toBe(false);
    expect(store.completeProcessing(second, "extracted", 15)).toBe(true);
    expect(store.getItem(item.id)?.status).toBe("extracted");
    expect(store.search("searchable")).toHaveLength(1);
    store.close();
  });
});

test("ingestion queues durable extraction and stages run independently", async () => {
  const store = new Store(":memory:");
  const source = store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  const poll = store.claim(1)!;
  store.complete(
    poll,
    { items: [{ nativeId: "a", title: "Alpha", text: "searchable" }] },
    2,
  );
  const item = store.search("searchable")[0]!;
  const job = store.claimProcessing("extract", 3);
  expect(job?.item_id).toBe(item.id);
  expect(store.completeProcessing(job!, "extracted", 4)).toBe(true);
  expect(store.claimProcessing("analyse", 5)?.item_id).toBe(item.id);
  store.close();
});

test("failed processing retries with backoff and is fenced", () => {
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "body" }] },
    2,
  );
  const job = store.claimProcessing("extract", 3)!;
  expect(store.failProcessing(job, "temporary", 4)).toBe(true);
  expect(store.failProcessing(job, "stale", 5)).toBe(false);
  expect(store.claimProcessing("extract", 100)).toBeNull();
  expect(store.claimProcessing("extract", 30004)?.attempts).toBe(2);
  store.close();
});

test("processing lease cannot be used to alter a different item or stage", () => {
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    {
      items: [
        { nativeId: "a", title: "Alpha", text: "body" },
        { nativeId: "b", title: "Beta", text: "body" },
      ],
    },
    2,
  );
  const job = store.claimProcessing("extract", 3)!;
  const other = store.search("body").find((item) => item.id !== job.item_id)!;
  expect(
    store.completeProcessing({ ...job, item_id: other.id }, "extracted", 4),
  ).toBe(false);
  expect(store.getItem(other.id)?.status).toBe("ingested");
  expect(store.completeProcessing(job, "extracted", 4)).toBe(true);
  store.close();
});

test("a blocked stage does not prevent polling another source", async () => {
  const { ProcessingWorker, Worker } = await import("../src/worker");
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "body" }] },
    2,
  );
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const processing = new ProcessingWorker(store, {
    extract: async () => {
      await blocked;
      return { status: "extracted" };
    },
  });
  const work = processing.drain("extract", 1);
  store.addSource("https://other.example/feed");
  store.enqueueDue(Date.now());
  const poll = new Worker(store, {
    poll: async () => ({
      items: [{ nativeId: "b", title: "Beta", text: "independent" }],
    }),
  });
  await poll.drain(1);
  expect(store.search("independent")).toHaveLength(1);
  release();
  await work;
  store.close();
});

test("persists opaque source cursors alongside polling validators", () => {
  const store = new Store(":memory:");
  const source = store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [], etag: "tag", cursor: '{"page":2}' },
    2,
  );
  expect(store.state(source.id)).toEqual({
    etag: "tag",
    lastModified: undefined,
    cursor: '{"page":2}',
  });
  store.close();
});

test("scheduler runs injected stage work and stops cleanly", async () => {
  const { ProcessingWorker, Worker, schedule } = await import("../src/worker");
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "body" }] },
    2,
  );
  let ran!: () => void;
  const completed = new Promise<void>((resolve) => {
    ran = resolve;
  });
  const processing = new ProcessingWorker(store, {
    extract: async () => {
      ran();
      return { status: "extracted" };
    },
  });
  const scheduler = schedule(
    store,
    new Worker(store, { poll: async () => ({ items: [] }) }),
    processing,
  );
  await completed;
  await scheduler.stop();
  expect(store.search("body")[0]?.status).toBe("extracted");
  store.close();
});

test("stage output is committed with its fenced completion", () => {
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "body" }] },
    2,
  );
  const job = store.claimProcessing("extract", 3)!;
  expect(
    store.completeProcessing(job, "extracted", 4, '{"text":"extracted"}'),
  ).toBe(true);
  expect(store.processingResult("extract", job.item_id)).toBe(
    '{"text":"extracted"}',
  );
  store.close();
});

test("all stages survive restart and replay without duplicating work", () => {
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pipeline-"));
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "body" }] },
    2,
  );
  const id = store.search("body")[0]!.id;
  let now = 3;
  for (const [stage, status] of [
    ["extract", "extracted"],
    ["analyse", "analysed"],
    ["score", "scored"],
  ] as const) {
    const job = store.claimProcessing(stage, now)!;
    store.close();
    store = new Store(path);
    const reclaimed = store.claimProcessing(stage, now + 60000)!;
    expect(store.completeProcessing(job, status, now + 60001)).toBe(false);
    expect(store.completeProcessing(reclaimed, status, now + 60001)).toBe(true);
    expect(store.enqueueProcessing(stage, id, now + 60001)).toBe(false);
    now += 60002;
  }
  expect(store.getItem(id)?.status).toBe("available");
  expect(store.search("body")).toHaveLength(1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("rejects invalid stage transitions and records unavailable work", () => {
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "body" }] },
    2,
  );
  const job = store.claimProcessing("extract", 3)!;
  expect(() => store.completeProcessing(job, "available", 4)).toThrow();
  expect(store.completeProcessing(job, "unavailable", 4)).toBe(true);
  expect(store.getItem(job.item_id)?.status).toBe("unavailable");
  expect(store.claimProcessing("analyse", 5)).toBeNull();
  store.close();
});

test("unchanged poll preserves an opaque cursor", () => {
  const store = new Store(":memory:");
  const source = store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(store.claim(1)!, { items: [], cursor: "page2" }, 2);
  store.enqueueDue(3, true);
  store.complete(store.claim(3)!, { items: [], notModified: true }, 4);
  expect(store.state(source.id).cursor).toBe("page2");
  store.close();
});

test("timed out non-cooperative handlers cannot accumulate work", async () => {
  const { ProcessingWorker } = await import("../src/worker");
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    {
      items: [
        { nativeId: "a", title: "Alpha", text: "body" },
        { nativeId: "b", title: "Beta", text: "body" },
      ],
    },
    2,
  );
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new ProcessingWorker(
    store,
    {
      extract: async () => {
        calls++;
        await blocked;
        return { status: "extracted" };
      },
    },
    5,
  );
  await worker.drain("extract");
  await worker.drain("extract");
  expect(calls).toBe(1);
  release();
  store.close();
});

test("item exposes pending, retryable and terminal stage outcomes", () => {
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "body" }] },
    2,
  );
  const id = store.search("body")[0]!.id;
  expect(store.getItem(id)?.processing[0]?.status).toBe("pending");
  let now = 3;
  for (let i = 0; i < 5; i++) {
    const job = store.claimProcessing("extract", now)!;
    store.failProcessing(job, "broken", now + 1);
    expect(store.getItem(id)?.processing[0]?.status).toBe(
      i === 4 ? "failed" : "pending",
    );
    now += 3600001;
  }
  store.close();
});

test("new content generation can be processed while retaining older results", () => {
  const store = new Store(":memory:");
  const source = store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    {
      items: [
        {
          nativeId: "parent",
          title: "Digest",
          text: "digest",
          children: [{ url: "https://example.com/article", title: "Article" }],
        },
      ],
    },
    2,
  );
  const item = store.search("Article")[0]!;
  const first = store.claimProcessing("extract", 3)!;
  const articleJob =
    first.item_id === item.id ? first : store.claimProcessing("extract", 3)!;
  expect(store.completeProcessing(articleJob, "extracted", 4, "old")).toBe(
    true,
  );
  store.enqueueDue(5, true);
  store.complete(
    store.claim(5)!,
    {
      items: [
        {
          nativeId: "article",
          url: "https://example.com/article",
          title: "Article",
          text: "full body",
        },
      ],
    },
    6,
  );
  let next = store.claimProcessing("extract", 7)!;
  if (next.item_id !== item.id) next = store.claimProcessing("extract", 7)!;
  expect(next.item_id).toBe(item.id);
  expect(next.generation).toBe(2);
  expect(store.processingResult("extract", item.id, 1)).toBe("old");
  store.close();
});

test("scored completion records scored outcome and makes item available", () => {
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "body" }] },
    2,
  );
  const id = store.search("body")[0]!.id;
  store.enqueueProcessing("score", id, 3);
  const job = store.claimProcessing("score", 3)!;
  expect(store.completeProcessing(job, "scored", 4)).toBe(true);
  expect(
    store.getItem(id)?.processing.find((row) => row.stage === "score")?.outcome,
  ).toBe("scored");
  expect(store.getItem(id)?.status).toBe("available");
  store.close();
});

test("superseded generation cannot advance the current item", () => {
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    {
      items: [
        {
          nativeId: "parent",
          title: "Digest",
          text: "digest",
          children: [{ url: "https://example.com/article", title: "Article" }],
        },
      ],
    },
    2,
  );
  const item = store.search("Article")[0]!;
  let old = store.claimProcessing("extract", 3)!;
  if (old.item_id !== item.id) old = store.claimProcessing("extract", 3)!;
  store.enqueueDue(4, true);
  store.complete(
    store.claim(4)!,
    {
      items: [
        {
          nativeId: "article",
          url: "https://example.com/article",
          title: "Article",
          text: "body",
        },
      ],
    },
    5,
  );
  expect(store.completeProcessing(old, "extracted", 6)).toBe(true);
  expect(store.getItem(item.id)?.status).toBe("ingested");
  expect(store.claimProcessing("analyse", 7)).toBeNull();
  store.close();
});

test("same native ID enrichment creates a new generation and exposes current results", () => {
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "" }] },
    2,
  );
  const id = store.search("Alpha")[0]!.id;
  const old = store.claimProcessing("extract", 3)!;
  expect(store.completeProcessing(old, "extracted", 4, "old")).toBe(true);
  store.enqueueDue(5, true);
  store.complete(
    store.claim(5)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "new body" }] },
    6,
  );
  const next = store.claimProcessing("extract", 7)!;
  expect(next.generation).toBe(2);
  expect(
    store.completeProcessing(
      { ...next, generation: 1 },
      "extracted",
      8,
      "wrong",
    ),
  ).toBe(false);
  expect(store.completeProcessing(next, "extracted", 8, "new")).toBe(true);
  expect(store.processingResult("extract", id)).toBe("new");
  expect(
    store.getItem(id)?.processing.some((row) => row.generation === 2),
  ).toBe(true);
  expect(store.search("new body")[0]?.id).toBe(id);
  store.close();
});
