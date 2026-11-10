import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { runDiscovery, type DiscoveryLimits } from "../src/discovery-service";
import type { SearchProvider } from "../src/search-provider";

const limits: DiscoveryLimits = {
  maxQueriesPerDay: 10,
  maxQueriesPerRun: 2,
  maxResultsPerDay: 20,
  maxResultsPerRun: 10,
  maxCostMicrosPerDay: 100,
  maxCostMicrosPerRun: 20,
  reservedCostMicrosPerQuery: 10,
};
const ticking = () => {
  let time = 1_700_000_000_000;
  return () => {
    time += 6000;
    return time;
  };
};

test("search pages deduplicate canonical identities, preserve query observations and keep snippets separate", async () => {
  const store = new Store(":memory:");
  try {
    store.addSource("https://example.org/feed");
    store.enqueueDue(100);
    store.complete(
      store.claim(100)!,
      {
        items: [
          {
            nativeId: "feed-item",
            url: "https://example.org/article",
            title: "Feed title",
            text: "Feed body",
          },
        ],
      },
      101,
    );
    const provider: SearchProvider = {
      name: "fake",
      version: "1",
      async search({ cursor }) {
        return cursor
          ? {
              results: [
                {
                  url: "https://outside.example/story?utm_x=abc",
                  title: "Independent item",
                  snippet: "Unverified search claim",
                },
              ],
              truncated: false,
            }
          : {
              results: [
                {
                  url: "https://example.org/article",
                  title: "Search title differs",
                },
                {
                  url: "https://outside.example/story",
                  title: "Independent item",
                },
              ],
              nextCursor: "page-2",
              truncated: false,
            };
      },
    };
    const outcome = await runDiscovery(
      store,
      provider,
      "robotics",
      limits,
      ticking(),
    );
    expect(outcome).toMatchObject({ status: "complete", pages: 2, results: 3 });
    expect(store.sqlite.query("SELECT id FROM items").all()).toHaveLength(2);
    expect(
      store.sqlite
        .query("SELECT origin FROM discovery_results ORDER BY id")
        .all(),
    ).toEqual([
      { origin: "subscribed" },
      { origin: "discovered" },
      { origin: "discovered" },
    ]);
    const content = store.sqlite
      .query<{ text: string }, []>(
        "SELECT content.text FROM content JOIN items ON content.item_id=items.id WHERE items.url='https://outside.example/story'",
      )
      .get();
    expect(content?.text).toBe("");
    expect(
      store.sqlite.query("SELECT * FROM discovery_results").all(),
    ).toHaveLength(3);
    const again = await runDiscovery(
      store,
      provider,
      "different query",
      limits,
      ticking(),
    );
    expect(again.status).toBe("complete");
    expect(
      store.sqlite.query("SELECT * FROM discovery_results").all(),
    ).toHaveLength(6);
    expect(
      store.sqlite
        .query<{ title: string }, []>(
          "SELECT title FROM items WHERE url='https://example.org/article'",
        )
        .get()?.title,
    ).toBe("Feed title");
  } finally {
    store.close();
  }
});

test("concurrent reservations cap requests and failures remain charged across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-discovery-"));
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    let calls = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: SearchProvider = {
      name: "fake",
      version: "1",
      async search() {
        calls++;
        await wait;
        throw new Error("secret must never persist");
      },
    };
    const cap = { ...limits, maxQueriesPerDay: 1, maxQueriesPerRun: 1 };
    const first = runDiscovery(store, provider, "first", cap, ticking());
    const second = await runDiscovery(
      store,
      provider,
      "second",
      cap,
      ticking(),
    );
    expect(second.status).toBe("budget_exhausted");
    release();
    expect((await first).status).toBe("failed");
    expect(calls).toBe(1);
    store.close();
    store = new Store(path);
    const third = await runDiscovery(store, provider, "third", cap, ticking());
    expect(third.status).toBe("budget_exhausted");
    const rows = store.sqlite
      .query<{ last_error: string }, []>(
        "SELECT last_error FROM discovery_pages",
      )
      .all();
    expect(rows).toEqual([{ last_error: "provider_or_page_error" }]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty page succeeds and repeated cursors fail closed", async () => {
  const store = new Store(":memory:");
  try {
    const empty: SearchProvider = {
      name: "fake",
      version: "1",
      async search() {
        return { results: [], truncated: false };
      },
    };
    expect(
      (await runDiscovery(store, empty, "empty", limits, ticking())).status,
    ).toBe("complete");
    const cycle: SearchProvider = {
      name: "other",
      version: "1",
      async search() {
        return { results: [], nextCursor: "same", truncated: false };
      },
    };
    expect(
      (await runDiscovery(store, cycle, "cycle", limits, ticking())).status,
    ).toBe("failed");
  } finally {
    store.close();
  }
});
