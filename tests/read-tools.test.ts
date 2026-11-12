import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/db/store";
import { createApp } from "../src/http";
import { ProfileStore, type Interest } from "../src/profiles";
import { runDiscovery } from "../src/discovery-service";
import type { SearchProvider } from "../src/search-provider";

const token = "read-tools-test-token-at-least-24-chars";

function interest(overrides: Partial<Interest> = {}): Interest {
  return {
    kind: "interest",
    id: "robotics",
    version: 1,
    description: "Robotics",
    entities: [],
    keywords: ["robotics"],
    priority: 3,
    positive: [],
    negative: [],
    queries: [],
    lifetime: "persistent",
    feedbackRefs: [],
    ...overrides,
  } as Interest;
}

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
  const client = new Client({ name: "read-tools-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("mcp", server.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    await run(async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      return { isError: result.isError === true, data: JSON.parse(text) };
    });
  } finally {
    await client.close();
    server.stop(true);
  }
}

const discoveryLimits = {
  maxQueriesPerDay: 100,
  maxQueriesPerRun: 1,
  maxResultsPerDay: 1000,
  maxResultsPerRun: 100,
  maxCostMicrosPerDay: 1000,
  maxCostMicrosPerRun: 100,
  reservedCostMicrosPerQuery: 1,
};

/** Seed discoveries through the real discovery write path, one run per result. */
async function seedDiscoveries(store: Store, count: number) {
  for (let n = 1; n <= count; n++) {
    const provider: SearchProvider = {
      name: "fixture",
      version: "1",
      async search() {
        return {
          results: [
            {
              url: `https://discovered.example/${n}`,
              title: `Discovery ${n}`,
              snippet: "snippet",
            },
          ],
          truncated: false,
        };
      },
    };
    await runDiscovery(store, provider, `robotics ${n}`, discoveryLimits);
  }
}

describe("get_interests", () => {
  test("returns only the latest active version and omits expired temporary interests", async () => {
    const store = new Store(":memory:");
    try {
      const profiles = new ProfileStore(store.sqlite);
      profiles.import([
        interest({ id: "robotics", version: 1, description: "old" }),
      ]);
      profiles.import([
        interest({ id: "robotics", version: 2, description: "new" }),
      ]);
      profiles.import([
        interest({
          id: "temp",
          lifetime: "temporary",
          expiresAt: Date.now() - 1000,
        }),
      ]);
      await withMcp(store, async (call) => {
        const { isError, data } = await call("get_interests");
        expect(isError).toBe(false);
        const ids = data.interests.map((p: Interest) => `${p.id}@${p.version}`);
        expect(ids).toEqual(["robotics@2"]);
        expect(data.interests[0].description).toBe("new");
      });
    } finally {
      store.close();
    }
  });
});

describe("get_discoveries", () => {
  test("pages newest first without gaps or duplicates", async () => {
    const store = new Store(":memory:");
    try {
      await seedDiscoveries(store, 5);
      await withMcp(store, async (call) => {
        const seen: string[] = [];
        let before: number | undefined;
        for (let pages = 0; pages < 10; pages++) {
          const { data } = await call("get_discoveries", {
            limit: 2,
            ...(before ? { before } : {}),
          });
          for (const row of data.discoveries) seen.push(row.url);
          if (data.next_before === null) break;
          before = data.next_before;
        }
        expect(seen).toEqual([
          "https://discovered.example/5",
          "https://discovered.example/4",
          "https://discovered.example/3",
          "https://discovered.example/2",
          "https://discovered.example/1",
        ]);
        expect(new Set(seen).size).toBe(seen.length);
      });
    } finally {
      store.close();
    }
  });

  test("returns an explicit empty outcome and marks content untrusted", async () => {
    const store = new Store(":memory:");
    try {
      await withMcp(store, async (call) => {
        const { isError, data } = await call("get_discoveries");
        expect(isError).toBe(false);
        expect(data.discoveries).toEqual([]);
        expect(data.next_before).toBeNull();
        expect(data.content_kind).toBe("untrusted_source_content");
      });
    } finally {
      store.close();
    }
  });

  test("reads do not change persisted state", async () => {
    const store = new Store(":memory:");
    try {
      await seedDiscoveries(store, 1);
      const count = () =>
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM discovery_results",
          )
          .get()!.n;
      const before = count();
      await withMcp(store, async (call) => {
        await call("get_discoveries");
        await call("get_interests");
      });
      expect(count()).toBe(before);
    } finally {
      store.close();
    }
  });
});
