import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import { createApp } from "../src/http";
import { parseFeed } from "../src/adapters/rss";
import { rss } from "./fixtures";

const token = "read-contracts-test-token-at-least-24-chars";

async function withMcp(
  store: Store,
  run: (
    call: (name: string, args?: Record<string, unknown>) => Promise<any>,
  ) => Promise<void>,
) {
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
  const client = new Client({ name: "read-contracts-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("mcp", server.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    await run(async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      if (result.isError === true) return { isError: true, data: { text } };
      return { isError: false, data: JSON.parse(text) };
    });
  } finally {
    await client.close();
    server.stop(true);
  }
}

/** Ingest one RSS feed through the real poll path so items get real source links. */
function ingestFeed(store: Store, url: string, body: string) {
  const source = store.addSource(url, url);
  store.enqueueDue(100);
  const job = store.claim(100)!;
  store.complete(job, { items: parseFeed(body, source.url) }, 101);
  return source;
}

function feed(items: { guid: string; title: string }[]) {
  return `<rss><channel>${items
    .map(
      (i) =>
        `<item><guid>${i.guid}</guid><title>${i.title}</title><link>https://example.com/${i.guid}</link><description>robot text</description></item>`,
    )
    .join("")}</channel></rss>`;
}

describe("search_items filters", () => {
  test("until bounds the ingestion window and source_kind matches stored kind", async () => {
    const store = new Store(":memory:");
    try {
      ingestFeed(
        store,
        "https://example.com/a.xml",
        feed([{ guid: "a1", title: "robot alpha" }]),
      );
      await withMcp(store, async (call) => {
        const all = await call("search_items", { query: "robot" });
        expect(all.data.items.length).toBeGreaterThan(0);
        const rssOnly = await call("search_items", {
          query: "robot",
          source_kind: "rss",
        });
        expect(rssOnly.data.items.length).toBe(all.data.items.length);
        const none = await call("search_items", {
          query: "robot",
          source_kind: "github",
        });
        expect(none.data.items).toEqual([]);
        const before = await call("search_items", { query: "robot", until: 0 });
        expect(before.data.items).toEqual([]);
      });
    } finally {
      store.close();
    }
  });

  test("analysis_status filter excludes items whose status differs", async () => {
    const store = new Store(":memory:");
    try {
      ingestFeed(
        store,
        "https://example.com/b.xml",
        feed([{ guid: "b1", title: "robot beta" }]),
      );
      await withMcp(store, async (call) => {
        const pending = await call("search_items", {
          query: "robot",
          analysis_status: "pending",
        });
        const analysed = await call("search_items", {
          query: "robot",
          analysis_status: "analysed",
        });
        expect(pending.isError).toBe(false);
        expect(analysed.data.items).toEqual([]);
        expect(pending.data.items.length).toBeGreaterThan(0);
      });
    } finally {
      store.close();
    }
  });

  test("rejects unknown source_kind values", async () => {
    const store = new Store(":memory:");
    try {
      await withMcp(store, async (call) => {
        const result = await call("search_items", {
          query: "robot",
          source_kind: "reddit",
        });
        expect(result.isError).toBe(true);
      });
    } finally {
      store.close();
    }
  });
});

describe("get_item latest score", () => {
  test("includes the latest score row, or null before scoring", async () => {
    const store = new Store(":memory:");
    try {
      ingestFeed(
        store,
        "https://example.com/c.xml",
        feed([{ guid: "c1", title: "robot gamma" }]),
      );
      const id = store.search("gamma")[0]!.id;
      await withMcp(store, async (call) => {
        const { data } = await call("get_item", { id });
        expect(data.latest_score).toBeNull();
        store.sqlite
          .query(
            "INSERT INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at) VALUES('s1',?,1,'h','v1','{}','{\"eligible\":true}',5)",
          )
          .run(id);
        const scored = await call("get_item", { id });
        expect(scored.data.latest_score.id).toBe("s1");
      });
    } finally {
      store.close();
    }
  });
});

describe("explain_ranking exclusions", () => {
  test("marks only ineligible scores as excluded and reports their reasons", async () => {
    const store = new Store(":memory:");
    try {
      ingestFeed(
        store,
        "https://example.com/d.xml",
        feed([{ guid: "d1", title: "robot delta" }]),
      );
      const id = store.search("delta")[0]!.id;
      const insert = (scoreId: string, result: object, createdAt: number) =>
        store.sqlite
          .query(
            "INSERT INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            scoreId,
            id,
            1,
            scoreId,
            "v1",
            "{}",
            JSON.stringify(result),
            createdAt,
          );
      insert("score-eligible", { eligible: true, reasons: ["matched"] }, 1);
      insert(
        "score-excluded",
        { eligible: false, reasons: ["no_interest_match"] },
        2,
      );
      await withMcp(store, async (call) => {
        const { data } = await call("explain_ranking", { id });
        const byId = Object.fromEntries(
          data.exclusions.map((e: { score_id: string }) => [e.score_id, e]),
        );
        expect(byId["score-excluded"]).toEqual({
          score_id: "score-excluded",
          criteria_version: "v1",
          excluded: true,
          reasons: ["no_interest_match"],
        });
        expect(byId["score-eligible"].excluded).toBe(false);
        expect(byId["score-eligible"].reasons).toEqual([]);
      });
    } finally {
      store.close();
    }
  });
});

describe("get_digest list view", () => {
  test("lists only frozen editions in the window and never rebuilds them", async () => {
    const store = new Store(":memory:");
    try {
      const digests = new DigestStore(store.sqlite);
      const edition = (date: string) => ({
        date,
        timezone: "Europe/London",
        subject: `News ${date}`,
        html: `<p>${date}</p>`,
        text: date,
        decisionSnapshot: {},
        items: [
          {
            itemId: `item-${date}`,
            groupId: null,
            scoreId: null,
            snapshot: {},
          },
        ],
      });
      digests.freeze(edition("2026-01-01"), 1000);
      digests.freeze(edition("2026-01-02"), 2000);
      digests.freeze(edition("2026-02-01"), 3000);
      await withMcp(store, async (call) => {
        const window = await call("get_digest", {
          date: "2026-01-01",
          to: "2026-01-31",
          view: "list",
        });
        expect(window.isError).toBe(false);
        expect(
          window.data.editions.map(
            (e: { edition_date: string }) => e.edition_date,
          ),
        ).toEqual(["2026-01-02", "2026-01-01"]);
        expect(window.data.editions[0].html).toBeUndefined();

        const reversed = await call("get_digest", {
          date: "2026-02-01",
          to: "2026-01-01",
          view: "list",
        });
        expect(reversed.isError).toBe(true);
      });
    } finally {
      store.close();
    }
  });
});

describe("get_sources paging", () => {
  test("pages through all sources without gaps or duplicates", async () => {
    const store = new Store(":memory:");
    try {
      for (let n = 1; n <= 5; n++)
        store.addSource(`https://example.com/s${n}.xml`, `Source ${n}`);
      await withMcp(store, async (call) => {
        const seen: string[] = [];
        for (let offset = 0; offset < 50; offset += 2) {
          const { data } = await call("get_sources", { limit: 2, offset });
          if (!data.sources.length) break;
          for (const s of data.sources) seen.push(s.id);
        }
        expect(seen.length).toBe(5);
        expect(new Set(seen).size).toBe(5);
      });
    } finally {
      store.close();
    }
  });
});
