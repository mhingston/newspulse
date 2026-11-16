import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { ProcessingWorker } from "../src/worker";
import type { ProcessingJob } from "../src/db/store";

const day = 86400000;
const start = Date.UTC(2026, 10, 1);
const batching = { batch: 5, maxDelayMs: 30_000 };
// Ingestion queues each item's grouping job at the poll's completion time.
const ingestedAt = start + 1001;

function ingest(store: Store, count: number, offset = 0, now = ingestedAt) {
  const source = store.addSource("https://feed.example/rss", "Batching feed");
  store.enqueueDue(now - 1, true);
  const job = store.claim(now - 1)!;
  expect(job.source_id).toBe(source.id);
  const items = Array.from({ length: count }, (_, i) => {
    const n = i + offset;
    return {
      nativeId: "native-" + n,
      url: "https://articles.example/" + n,
      title: `Deployment report ${n} for service ${n}`,
      publishedAt: start + n * day,
      text: `Feed description ${n}`,
    };
  });
  expect(store.complete(job, { items }, now)).toBe(true);
}

function extractAll(store: Store, now: number) {
  let job = store.claimProcessing("extract", now);
  while (job) {
    expect(
      store.completeProcessing(
        job,
        "extracted",
        now + 1,
        JSON.stringify({
          status: "extracted",
          text: "Body " + job.item_id,
          method: "http",
          at: now,
        }),
      ),
    ).toBe(true);
    job = store.claimProcessing("extract", now);
  }
}

function groupingState(store: Store) {
  return store.sqlite
    .query<{ fingerprint: string }, []>(
      "SELECT fingerprint FROM story_grouping_state WHERE id=1",
    )
    .get()?.fingerprint;
}

function pendingGroupJobs(store: Store) {
  return store.sqlite
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM processing_jobs WHERE stage='group' AND status='pending'",
    )
    .get()!.n;
}

function claimGroup(store: Store, now: number): ProcessingJob | null {
  return store.claimProcessing("group", now);
}

test("inputs below the batch size wait for the maximum delay", () => {
  const store = new Store(":memory:", batching);
  try {
    ingest(store, 4);
    extractAll(store, ingestedAt + 1000);
    expect(pendingGroupJobs(store)).toBe(4);
    expect(claimGroup(store, ingestedAt + 1000)).toBeNull();
    expect(claimGroup(store, ingestedAt + 29_000)).toBeNull();
    expect(store.status().grouping.current_memberships).toBe(0);
  } finally {
    store.close();
  }
});

test("reaching the batch size replans the whole batch in one pass", () => {
  const store = new Store(":memory:", batching);
  try {
    ingest(store, 5);
    extractAll(store, ingestedAt + 1000);
    const job = claimGroup(store, ingestedAt + 2000);
    expect(job).not.toBeNull();
    const result = store.stories.reconcile(ingestedAt + 2000);
    expect(result.changed).toBe(true);
    expect(result.members).toBe(5);
    expect(store.completeProcessing(job!, "grouped", ingestedAt + 2001)).toBe(
      true,
    );
    expect(pendingGroupJobs(store)).toBe(0);
    expect(store.stories.reconcile().changed).toBe(false);
  } finally {
    store.close();
  }
});

test("a lone dirty input is replanned at the maximum delay", () => {
  const store = new Store(":memory:", batching);
  try {
    ingest(store, 1);
    extractAll(store, ingestedAt + 1000);
    expect(claimGroup(store, ingestedAt + 29_999)).toBeNull();
    const job = claimGroup(store, ingestedAt + 30_000);
    expect(job).not.toBeNull();
    expect(store.stories.reconcile(ingestedAt + 30_000).members).toBe(1);
    expect(store.completeProcessing(job!, "grouped", ingestedAt + 30_001)).toBe(
      true,
    );
    expect(groupingState(store)).toStartWith("specific-development-v1:");
  } finally {
    store.close();
  }
});

test("later arrivals cannot extend the wait of the oldest input", () => {
  const store = new Store(":memory:", batching);
  try {
    ingest(store, 2);
    extractAll(store, ingestedAt + 1000);
    ingest(store, 1, 2, ingestedAt + 20_000);
    extractAll(store, ingestedAt + 21_000);
    expect(claimGroup(store, ingestedAt + 29_999)).toBeNull();
    const job = claimGroup(store, ingestedAt + 30_000);
    expect(job).not.toBeNull();
    expect(store.stories.reconcile(ingestedAt + 30_000).members).toBe(3);
  } finally {
    store.close();
  }
});

test("a batch counted after a replan starts a new delay window", () => {
  const store = new Store(":memory:", batching);
  try {
    ingest(store, 5);
    extractAll(store, ingestedAt + 1000);
    const job = claimGroup(store, ingestedAt + 2000)!;
    expect(store.stories.reconcile(ingestedAt + 2000).members).toBe(5);
    expect(store.completeProcessing(job, "grouped", ingestedAt + 2001)).toBe(
      true,
    );
    ingest(store, 1, 5, ingestedAt + 100_000);
    extractAll(store, ingestedAt + 100_001);
    expect(claimGroup(store, ingestedAt + 100_002)).toBeNull();
    expect(claimGroup(store, ingestedAt + 130_001)).not.toBeNull();
  } finally {
    store.close();
  }
});

test("a failed batched replan retries after its backoff, not at once", () => {
  const store = new Store(":memory:", batching);
  try {
    ingest(store, 5);
    extractAll(store, ingestedAt + 1000);
    const job = claimGroup(store, ingestedAt + 2000)!;
    expect(store.failProcessing(job, "transient", ingestedAt + 2001)).toBe(
      true,
    );
    const retry = store.sqlite
      .query<{ available_at: number }, [string]>(
        "SELECT available_at FROM processing_jobs WHERE id=?",
      )
      .get(job.id)!;
    expect(retry.available_at).toBe(ingestedAt + 2001 + 30_000);
  } finally {
    store.close();
  }
});

test("the default store replans each input immediately", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, 2);
    extractAll(store, ingestedAt + 1000);
    expect(claimGroup(store, ingestedAt + 1001)).not.toBeNull();
  } finally {
    store.close();
  }
});

test("shutdown stops new group claims and leaves deferred inputs persisted", async () => {
  const store = new Store(":memory:", batching);
  try {
    ingest(store, 3);
    extractAll(store, ingestedAt + 1000);
    let stopping = true;
    const worker = new ProcessingWorker(store, {
      group: async () => {
        throw new Error("must not run while stopping");
      },
    });
    expect(await worker.drain("group", 20, () => stopping)).toBe(0);
    expect(pendingGroupJobs(store)).toBe(3);
    stopping = false;
    expect(claimGroup(store, ingestedAt + 30_000)).not.toBeNull();
    expect(store.stories.reconcile(ingestedAt + 30_000).members).toBe(3);
  } finally {
    store.close();
  }
});
