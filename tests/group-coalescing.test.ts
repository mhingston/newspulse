import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { ProcessingWorker } from "../src/worker";
import type { ProcessingJob } from "../src/db/store";

const day = 86400000;
const start = Date.UTC(2026, 10, 1);
const token = "group-coalescing-test";

function ingest(store: Store, count: number, offset = 0, now = start + 1000) {
  const source = store.addSource("https://feed.example/rss", "Coalescing feed");
  store.enqueueDue(now, true);
  const job = store.claim(now)!;
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
  expect(store.complete(job, { items }, now + 1)).toBe(true);
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

test("a backlog of extractions collapses into far fewer group replans", async () => {
  const store = new Store(":memory:");
  try {
    ingest(store, 60);
    let replans = 0;
    const worker = new ProcessingWorker(
      store,
      {
        extract: async (job: ProcessingJob) => ({
          status: "extracted",
          result: JSON.stringify({
            status: "extracted",
            text: `Extracted body ${job.item_id}`,
            method: "http",
            at: start,
          }),
        }),
        group: async () => {
          replans++;
          const result = store.stories.reconcile();
          if (result.stale)
            throw new Error("Story inputs changed during grouping");
          return { status: "grouped", result: JSON.stringify(result) };
        },
      },
      undefined,
      { extract: 1 },
    );
    // A backlog: extraction completes item by item while its group jobs queue.
    await worker.drain("extract", 60);
    while ((await worker.drain("group", 20)) > 0);
    const pendingGroups = store.sqlite
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM processing_jobs WHERE stage='group' AND status<>'done'",
      )
      .get()!.n;
    expect(pendingGroups).toBe(0);
    expect(replans).toBe(1);
    expect(store.status().grouping.current_memberships).toBe(60);
    expect(groupingState(store)).toStartWith("specific-development-v2:");
    expect(store.stories.reconcile().changed).toBe(false);
  } finally {
    store.close();
  }
});

test("inputs arriving during a replan are grouped by a later pass", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, 2);
    extractAll(store, start + 2000);
    const first = store.claimProcessing("group", start + 2003)!;
    expect(first).not.toBeNull();
    expect(store.stories.reconcile(start + 2004).changed).toBe(true);
    // New evidence arrives after the planning read and before the job commits.
    ingest(store, 1, 2, start + 4000);
    extractAll(store, start + 4001);
    expect(store.completeProcessing(first, "grouped", start + 4002)).toBe(true);
    expect(groupingState(store)).toBe("dirty");
    const later = store.claimProcessing("group", start + 4003);
    expect(later).not.toBeNull();
    const result = store.stories.reconcile(start + 4003);
    expect(result.stale).toBeUndefined();
    expect(result.members).toBe(3);
    expect(store.completeProcessing(later!, "grouped", start + 4004)).toBe(
      true,
    );
    expect(store.stories.reconcile().changed).toBe(false);
  } finally {
    store.close();
  }
});

test("a stale fenced group job cannot commit after its lease expires", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, 2);
    extractAll(store, start + 2000);
    const stale = store.claimProcessing("group", start + 2003)!;
    expect(stale).not.toBeNull();
    const reclaimed = store.claimProcessing("group", start + 2003 + 60_000)!;
    expect(reclaimed).not.toBeNull();
    expect(
      store.completeProcessing(stale, "grouped", start + 2003 + 60_001),
    ).toBe(false);
    expect(
      store.completeProcessing(reclaimed, "grouped", start + 2003 + 60_002),
    ).toBe(true);
  } finally {
    store.close();
  }
});

test("a coalesced group job never overrides a fresher lease", () => {
  const store = new Store(":memory:");
  try {
    ingest(store, 2);
    extractAll(store, start + 2000);
    const leased = store.claimProcessing("group", start + 2003)!;
    expect(leased).not.toBeNull();
    expect(store.stories.reconcile(start + 2004).changed).toBe(true);
    expect(store.completeProcessing(leased, "grouped", start + 5)).toBe(true);
    const outcomes = store.sqlite
      .query<{ outcome: string | null }, []>(
        "SELECT outcome FROM processing_jobs WHERE stage='group' ORDER BY outcome",
      )
      .all()
      .map((row) => row.outcome);
    expect(outcomes).toEqual(["coalesced", "grouped"]);
  } finally {
    store.close();
  }
});
