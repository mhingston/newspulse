import { expect, test } from "bun:test";
import { Store } from "../src/db/store";

const day = 86400000;
const start = Date.UTC(2026, 10, 1);

function ingestTwo(store: Store) {
  const source = store.addSource("https://feed.example/rss", "Revision feed");
  store.enqueueDue(start, true);
  const job = store.claim(start)!;
  expect(job.source_id).toBe(source.id);
  expect(
    store.complete(
      job,
      {
        items: [
          {
            nativeId: "a",
            url: "https://articles.example/a",
            title: "Acme releases Atlas 2 robotics model",
            publishedAt: start,
            text: "Atlas 2 robotics body",
          },
          {
            nativeId: "b",
            url: "https://articles.example/b",
            title: "Mars probe measures distant solar wind",
            publishedAt: start + day,
            text: "Mars probe body",
          },
        ],
      },
      start + 1,
    ),
  ).toBe(true);
}

function revision(store: Store) {
  return store.sqlite
    .query<{ revision: number }, []>(
      "SELECT revision FROM story_input_revision WHERE id=1",
    )
    .get()!.revision;
}

function firstItemId(store: Store) {
  return store.sqlite
    .query<{ id: string }, []>("SELECT id FROM items ORDER BY identity LIMIT 1")
    .get()!.id;
}

const concurrentWrites: [string, (store: Store, id: string) => void][] = [
  [
    "item title",
    (store, id) =>
      store.sqlite
        .query("UPDATE items SET title='Changed title' WHERE id=?")
        .run(id),
  ],
  [
    "item identity",
    (store, id) =>
      store.sqlite
        .query("UPDATE items SET identity=identity||'-moved' WHERE id=?")
        .run(id),
  ],
  [
    "item url",
    (store, id) =>
      store.sqlite
        .query(
          "UPDATE items SET url='https://articles.example/moved' WHERE id=?",
        )
        .run(id),
  ],
  [
    "item published time",
    (store, id) =>
      store.sqlite
        .query("UPDATE items SET published_at=published_at+1 WHERE id=?")
        .run(id),
  ],
  [
    "item ingested time",
    (store, id) =>
      store.sqlite
        .query("UPDATE items SET ingested_at=ingested_at+1 WHERE id=?")
        .run(id),
  ],
  [
    "content body update",
    (store, id) =>
      store.sqlite
        .query("UPDATE content SET text=text||' revised' WHERE item_id=?")
        .run(id),
  ],
  [
    "content body insert",
    (store, id) => {
      store.sqlite.query("DELETE FROM content WHERE item_id=?").run(id);
      store.sqlite
        .query("INSERT INTO content(item_id,text) VALUES(?,'new body')")
        .run(id);
    },
  ],
  [
    "content body delete",
    (store, id) =>
      store.sqlite.query("DELETE FROM content WHERE item_id=?").run(id),
  ],
  [
    "extraction result",
    (store, id) =>
      store.sqlite
        .query(
          "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,result,available_at,created_at) " +
            "VALUES('extract-race',?,'extract',2,'done','extracted',?,0,0)",
        )
        .run(id, JSON.stringify({ text: "extracted during replan" })),
  ],
  [
    "extraction status change",
    (store, id) =>
      store.sqlite
        .query(
          "UPDATE processing_jobs SET status='done',outcome='extracted',result='{\"text\":\"x\"}' " +
            "WHERE item_id=? AND stage='extract'",
        )
        .run(id),
  ],
  [
    "item insertion",
    (store) =>
      store.sqlite
        .query(
          "INSERT INTO items(id,identity,url,title,ingested_at) VALUES('late','late-identity','https://articles.example/late','Late story',?)",
        )
        .run(start + 5),
  ],
];

for (const [kind, write] of concurrentWrites) {
  test(`a replan rejects a plan made stale by a ${kind} change`, async () => {
    const store = new Store(":memory:");
    try {
      ingestTwo(store);
      const id = firstItemId(store);
      const s = store.stories as unknown as {
        snapshot(): unknown;
        commit(snapshot: unknown, plan: unknown, now: number): unknown;
      };
      const before = revision(store);
      const snapshot = s.snapshot() as {
        inputs: unknown[];
      } & Record<string, unknown>;
      expect(snapshot).toBeDefined();
      write(store, id);
      expect(revision(store)).toBeGreaterThan(before);
      const result = s.commit(
        snapshot,
        { version: "x", groups: [], relations: [] },
        start + 2,
      );
      expect(result).toMatchObject({ changed: false, stale: true });
    } finally {
      store.close();
    }
  });
}

test("writes outside planner inputs leave the revision unchanged", () => {
  const store = new Store(":memory:");
  try {
    ingestTwo(store);
    const before = revision(store);
    store.sqlite
      .query("UPDATE items SET status=status WHERE id=?")
      .run(firstItemId(store));
    store.sqlite
      .query("UPDATE story_grouping_state SET updated_at=updated_at WHERE id=1")
      .run();
    store.sqlite
      .query(
        "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,available_at,created_at) " +
          "SELECT 'other-stage',id,'score',1,'pending',NULL,0,0 FROM items LIMIT 1",
      )
      .run();
    expect(revision(store)).toBe(before);
  } finally {
    store.close();
  }
});

test("a replan with no concurrent change commits and is then clean", async () => {
  const store = new Store(":memory:");
  try {
    ingestTwo(store);
    const result = await store.stories.reconcileAsync(start + 2);
    expect(result).toMatchObject({ changed: true, groups: 2, members: 2 });
    expect(store.stories.reconcile(start + 3).changed).toBe(false);
  } finally {
    store.close();
  }
});

test("a write racing an async replan between its snapshot and commit is rejected", async () => {
  const store = new Store(":memory:");
  try {
    ingestTwo(store);
    store.sqlite
      .query("UPDATE story_grouping_state SET fingerprint='dirty' WHERE id=1")
      .run();
    const id = firstItemId(store);
    const pending = store.stories.reconcileAsync(start + 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    store.sqlite
      .query("UPDATE items SET title='Raced title' WHERE id=?")
      .run(id);
    const result = await pending;
    expect(result.stale).toBe(true);
    expect(store.stories.reconcile(start + 3).changed).toBe(true);
  } finally {
    store.close();
  }
});

test("a replan over a large library keeps every synchronous block under the bound", async () => {
  const store = new Store(":memory:");
  try {
    const body =
      "Detailed report on the rollout, its measurements and the effect on operators. ".repeat(
        12,
      );
    const insert = store.sqlite.query(
      "INSERT INTO items(id,identity,url,title,ingested_at) VALUES(?,?,?,?,?)",
    );
    const insertContent = store.sqlite.query(
      "INSERT INTO content(item_id,text) VALUES(?,?)",
    );
    store.sqlite.transaction(() => {
      for (let index = 0; index < 4000; index++) {
        const id = `item-${index}`;
        insert.run(
          id,
          `identity-${String(index).padStart(6, "0")}`,
          `https://example.com/articles/${index}`,
          `Deployment report ${index} for service ${index}`,
          start + index,
        );
        insertContent.run(id, `Feed description ${index}. ${body}`);
      }
    })();
    let longest = 0;
    let last = performance.now();
    let stop = false;
    const tick = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      if (!stop) setImmediate(tick);
    };
    setImmediate(tick);
    const result = await store.stories.reconcileAsync(start + 10 * day);
    stop = true;
    expect(result.groups).toBe(4000);
    expect(longest).toBeLessThan(250);
  } finally {
    store.close();
  }
}, 60_000);
