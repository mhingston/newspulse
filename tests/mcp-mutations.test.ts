import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/db/store";
import { createApp } from "../src/http";
import type { SearchPage, SearchProvider } from "../src/search-provider";
import { ProfileStore } from "../src/profiles";

const token = "mutation-test-token-at-least-24-chars";
const env = {
  DISCOVERY_DAILY_QUERIES: "2",
  DISCOVERY_RUN_QUERIES: "1",
  DISCOVERY_DAILY_RESULTS: "10",
  DISCOVERY_RUN_RESULTS: "5",
  DISCOVERY_DAILY_MICROS: "1000",
  DISCOVERY_RUN_MICROS: "500",
  DISCOVERY_QUERY_MICROS: "100",
};

function fakeProvider(calls: { n: number }, delayMs = 0): SearchProvider {
  let page = 0;
  return {
    name: "fake",
    version: "1",
    async search(input): Promise<SearchPage> {
      calls.n++;
      if (delayMs) await Bun.sleep(delayMs);
      page++;
      return {
        results: [
          {
            url: `https://example.com/discovered-${page}`,
            title: `${input.query} result`,
            snippet: "snippet",
          },
        ],
        truncated: false,
      };
    },
  };
}

/**
 * Spin up the real HTTP app with the official SDK client. `run` receives the
 * helpers and closes the server even when an assertion fails.
 */
async function withMcp(
  run: (helpers: {
    store: Store;
    server: ReturnType<typeof Bun.serve>;
    call: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ isError: boolean; data: Record<string, unknown> }>;
    client: Client;
  }) => Promise<void>,
  provider: SearchProvider = fakeProvider({ n: 0 }),
) {
  const store = new Store(":memory:");
  const app = createApp(store, {
    token,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
    mcp: { discoveryProvider: provider, env },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  const client = new Client({ name: "mutation-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("mcp", server.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError === true,
      data: JSON.parse(
        (result.content as { text: string }[])[0]!.text,
      ) as Record<string, unknown>,
    };
  };
  try {
    await run({ store, server, call, client });
  } finally {
    await client.close();
    await server.stop(true);
    store.close();
  }
}

describe("MCP mutation tools over the real SDK and HTTP server", () => {
  test("every mutation tool appears alongside the read-only tools", async () => {
    await withMcp(async ({ client }) => {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of [
        "add_source",
        "remove_source",
        "update_interest",
        "submit_feedback",
        "ingest_url",
        "trigger_discovery",
        "get_feedback",
        "get_submission",
        "get_status",
        "search_items",
      ])
        expect(tools).toContain(name);
    });
  });

  test("an oversized preview is rejected instead of stored truncated", async () => {
    await withMcp(async ({ store, call }) => {
      const interest = {
        id: "huge",
        description: "Huge interest",
        entities: [],
        keywords: Array.from(
          { length: 60 },
          (_, i) => `${i}-${"k".repeat(480)}`,
        ),
        priority: 3,
        positive: [],
        negative: [],
        queries: [],
        lifetime: "persistent",
        feedbackRefs: [],
      };
      const preview = await call("update_interest", { interest });
      expect(preview.isError).toBe(true);
      expect(preview.data.error).toBe("too_large");
      // Nothing is persisted: no unusable token and no profile version.
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM mutation_confirmations",
          )
          .get()!.n,
      ).toBe(0);
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) AS n FROM profiles")
          .get()!.n,
      ).toBe(0);
    });
  });

  test("add_source requires a confirmed preview and creates one source", async () => {
    await withMcp(async ({ store, call }) => {
      const preview = await call("add_source", {
        url: "https://example.com/feed.xml",
        title: "Example feed",
      });
      expect(preview.data).toMatchObject({
        action: "add_source",
        effect: "create_source",
        status: "confirmation_required",
      });
      expect(preview.data.confirm_token).toBeString();
      expect(store.sources()).toHaveLength(0);

      const confirmed = await call("add_source", {
        confirm_token: preview.data.confirm_token,
      });
      expect(confirmed.data).toMatchObject({
        url: "https://example.com/feed.xml",
        title: "Example feed",
      });
      expect(store.sources()).toHaveLength(1);

      // Replaying the same token cannot re-run the effect.
      const replay = await call("add_source", {
        confirm_token: preview.data.confirm_token,
      });
      expect(replay.isError).toBe(true);
      expect(replay.data.error).toBe("used");
      expect(store.sources()).toHaveLength(1);
    });
  });

  test("a changed payload, expired token and unknown token are rejected", async () => {
    await withMcp(async ({ store, call }) => {
      const preview = await call("add_source", {
        url: "https://example.com/feed.xml",
        title: "Original",
      });
      store.sqlite
        .query(
          "UPDATE mutation_confirmations SET payload_hash='tampered' WHERE id=?",
        )
        .run(preview.data.confirm_token as string);
      const changed = await call("add_source", {
        confirm_token: preview.data.confirm_token,
      });
      expect(changed.isError).toBe(true);
      expect(changed.data.error).toBe("payload_changed");
      expect(store.sources()).toHaveLength(0);

      const late = await call("add_source", {
        url: "https://example.com/late.xml",
      });
      store.sqlite
        .query("UPDATE mutation_confirmations SET expires_at=1 WHERE id=?")
        .run(late.data.confirm_token as string);
      const expired = await call("add_source", {
        confirm_token: late.data.confirm_token,
      });
      expect(expired.isError).toBe(true);
      expect(expired.data.error).toBe("expired");

      const bogus = await call("add_source", { confirm_token: "not-a-token" });
      expect(bogus.isError).toBe(true);
      expect(bogus.data.error).toBe("not_found");
    });
  });

  test("a token cannot be reused for a different action", async () => {
    await withMcp(async ({ call }) => {
      const preview = await call("add_source", {
        url: "https://example.com/feed.xml",
      });
      const crossAction = await call("trigger_discovery", {
        confirm_token: preview.data.confirm_token,
      });
      expect(crossAction.isError).toBe(true);
      expect(crossAction.data.error).toBe("not_found");
    });
  });

  test("remove_source disables polling, keeps history and cancels queued polls", async () => {
    await withMcp(async ({ store, call }) => {
      const source = store.addSource("https://example.com/feed.xml");
      store.enqueueDue();
      const preview = await call("remove_source", { source_id: source.id });
      expect(preview.data).toMatchObject({
        action: "remove_source",
        effect: "disable_future_polling_keep_history",
      });
      const confirmed = await call("remove_source", {
        confirm_token: preview.data.confirm_token,
      });
      expect(confirmed.data).toMatchObject({
        source_id: source.id,
        removed: true,
        history_retained: true,
      });
      expect(store.source(source.id)?.removed).toBe(1);
      expect(store.sources()).toHaveLength(0);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM jobs WHERE status IN ('pending','running')",
          )
          .get()!.n,
      ).toBe(0);
      const again = await call("remove_source", { source_id: source.id });
      expect(again.isError).toBe(true);
      expect(again.data.error).toBe("source_not_found");
    });
  });

  test("removing a source during an active poll fences the running claim", async () => {
    await withMcp(async ({ store, call }) => {
      const source = store.addSource("https://example.com/feed.xml");
      store.enqueueDue();
      const running = store.claim()!;
      const preview = await call("remove_source", { source_id: source.id });
      await call("remove_source", {
        confirm_token: preview.data.confirm_token,
      });
      // The in-flight poll can no longer commit its results.
      expect(
        store.complete(running, {
          items: [{ nativeId: "late", title: "Late item", text: "late body" }],
        }),
      ).toBe(false);
      expect(store.search("late")).toHaveLength(0);
      expect(store.claim()).toBeNull();
    });
  });

  test("update_interest appends an immutable version and invalidates scores", async () => {
    await withMcp(async ({ store, call }) => {
      const interest = {
        id: "rust",
        description: "Rust systems work",
        entities: ["Rust"],
        keywords: ["ownership"],
        priority: 3,
        positive: ["fearless concurrency"],
        negative: ["crypto"],
        queries: ["rust ownership"],
        lifetime: "persistent",
        feedbackRefs: [],
      };
      const preview = await call("update_interest", { interest });
      expect(preview.data).toMatchObject({
        action: "update_interest",
        effect: "create_interest",
        previous_version: null,
      });
      expect(preview.data.interest).toMatchObject({ version: 1 });
      const confirmed = await call("update_interest", {
        confirm_token: preview.data.confirm_token,
      });
      expect((confirmed.data.interest as { version: number }).version).toBe(1);

      const next = await call("update_interest", {
        interest: { ...interest, priority: 5 },
      });
      expect(next.data.previous_version).toBe(1);
      expect((next.data.interest as { version: number }).version).toBe(2);
      await call("update_interest", { confirm_token: next.data.confirm_token });
      const versions = new ProfileStore(store.sqlite).export();
      expect(versions.map((profile) => profile.version)).toEqual([1, 2]);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM score_validity_events WHERE kind='global_invalidation'",
          )
          .get()!.n,
      ).toBe(2);

      const invalid = await call("update_interest", {
        interest: { ...interest, priority: 99 },
      });
      expect(invalid.isError).toBe(true);
      expect(String(invalid.data.error)).toContain("invalid_interest");
    });
  });

  test("submit_feedback records explicit feedback for a known item only", async () => {
    await withMcp(async ({ store, call }) => {
      store.addSource("https://example.com/feed.xml");
      store.enqueueDue();
      store.complete(store.claim()!, {
        items: [
          {
            nativeId: "1",
            url: "https://example.com/a",
            title: "Item",
            text: "body",
          },
        ],
      });
      const item = store.search("body")[0]!;
      const preview = await call("submit_feedback", {
        item_id: item.id,
        action: "useful",
      });
      expect(preview.data).toMatchObject({
        action: "submit_feedback",
        effect: "record_explicit_feedback",
        item_id: item.id,
      });
      await call("submit_feedback", {
        confirm_token: preview.data.confirm_token,
      });
      const feedback = await call("get_feedback", {});
      expect(feedback.data.feedback).toHaveLength(1);
      expect(
        (feedback.data.feedback as Record<string, unknown>[])[0],
      ).toMatchObject({
        itemId: item.id,
        useful: true,
        source: "mcp",
        editionDate: null,
      });

      const unknown = await call("submit_feedback", {
        item_id: "missing",
        action: "useful",
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.data.error).toBe("item_not_found");
    });
  });

  test("ingest_url is idempotent through the confirmation flow", async () => {
    await withMcp(async ({ call }) => {
      const preview = await call("ingest_url", {
        submission_id: "sub-1",
        url: "https://example.com/article?utm_source=chat",
        origin: "manual",
      });
      expect(preview.data).toMatchObject({
        action: "ingest_url",
        effect: "ingest_and_queue_extraction",
        submission_id: "sub-1",
      });
      const first = await call("ingest_url", {
        confirm_token: preview.data.confirm_token,
      });
      expect(first.data.duplicate).toBe(false);
      const itemId = first.data.itemId as string;
      expect(itemId).toBeString();

      const second = await call("ingest_url", {
        submission_id: "sub-1",
        url: "https://example.com/article",
        origin: "manual",
      });
      const again = await call("ingest_url", {
        confirm_token: second.data.confirm_token,
      });
      expect(again.data.duplicate).toBe(true);
      expect(again.data.itemId).toBe(itemId);
      const submission = await call("get_submission", { id: itemId });
      expect(submission.data).toMatchObject({ submission_id: "sub-1" });
    });
  });

  test("concurrent trigger_discovery stays within the persisted budget", async () => {
    const calls = { n: 0 };
    await withMcp(
      async ({ call }) => {
        const previews = await Promise.all(
          [1, 2, 3].map((n) =>
            call("trigger_discovery", { query: `query ${n}` }),
          ),
        );
        const results = await Promise.all(
          previews.map((preview) =>
            call("trigger_discovery", {
              confirm_token: preview.data.confirm_token,
            }),
          ),
        );
        const statuses = results.map((result) => String(result.data.status));
        // The first run spends the whole two-query budget; later runs are
        // refused by the same persisted ledger instead of spending more.
        expect(calls.n).toBeLessThanOrEqual(2);
        expect(statuses).toContain("budget_exhausted");
      },
      fakeProvider(calls, 20),
    );
    // Waiting lets concurrent second runs reach the ledger after the first
    // one released its reservation, so assert the ceiling again.
    expect(calls.n).toBeLessThanOrEqual(2);
  });

  test("unauthenticated calls cannot invoke any mutation tool", async () => {
    await withMcp(async ({ store, server }) => {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "add_source",
            arguments: { url: "https://example.com/f" },
          },
        }),
      });
      expect(response.status).toBe(401);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM mutation_confirmations",
          )
          .get()!.n,
      ).toBe(0);
      expect(store.sources()).toHaveLength(0);
    });
  });
});
