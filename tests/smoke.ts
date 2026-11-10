import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/db/store";
import { RssAdapter } from "../src/adapters/rss";
import { parseOpml } from "../src/adapters/opml";
import { Worker, schedule } from "../src/worker";
import { createApp } from "../src/http";
import { rss, prefixedAtom, opml } from "./fixtures";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export async function smoke() {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-smoke-"));
  const path = join(dir, "data.sqlite");
  let conditional = false;
  const feed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("if-none-match") === '"fixture-v1"') {
        conditional = true;
        return new Response(null, { status: 304 });
      }
      return new Response(
        new URL(request.url).pathname === "/atom"
          ? Buffer.concat([
              Buffer.from([0xff, 0xfe]),
              Buffer.from(prefixedAtom, "utf16le"),
            ])
          : rss,
        {
          headers: { etag: '"fixture-v1"', "content-type": "application/xml" },
        },
      );
    },
  });
  let store = new Store(path);
  let api: ReturnType<typeof Bun.serve> | undefined;
  let client: Client | undefined;
  try {
    for (const f of parseOpml(opml(`${feed.url}rss`)))
      store.addSource(f.url, f.title);
    store.addSource(`${feed.url}atom`, "Atom");
    store.enqueueDue();
    await new Worker(store, new RssAdapter()).drain();
    const count = store.search("models").length;
    assert(count === 1, "Cross-feed duplicate was not merged");
    store.close();
    store = new Store(path);
    store.enqueueDue(Date.now(), true);
    await new Worker(store, new RssAdapter()).drain();
    assert(conditional, "Conditional HTTP was not used");
    assert(
      store.search("models").length === count,
      "Restart introduced duplicates",
    );
    const token = "smoke-token-with-at-least-24-characters";
    const app = createApp(store, {
      token,
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
    });
    api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    client = new Client({ name: "newspulse-smoke", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("mcp", api.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const tools = await client.listTools();
    assert(
      JSON.stringify(tools.tools.map((tool) => tool.name).sort()) ===
        JSON.stringify(
          [
            "explain_ranking",
            "get_digest",
            "get_item",
            "get_sources",
            "get_status",
            "get_story_group",
            "get_submission",
            "search_items",
          ].sort(),
        ),
      "Expected all read-only MCP tools",
    );
    const result = await client.callTool({
      name: "search_items",
      arguments: { query: "robotics" },
    });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert(payload.items.length === 1, "MCP search returned no result");
    const detail = await client.callTool({
      name: "get_item",
      arguments: { id: payload.items[0].id },
    });
    const item = JSON.parse((detail.content as { text: string }[])[0]!.text);
    assert(item.references.length === 2, "MCP lost provenance");
    assert(item.url === "https://example.com/models", "MCP lost source URL");
    assert(
      item.references.some(
        (r: { url: string }) =>
          r.url === "https://example.com/models#benchmarks",
      ),
      "MCP lost original Atom fragment",
    );
    assert(
      item.references.some(
        (r: { url: string }) =>
          r.url === "https://example.com/models?utm_source=rss",
      ),
      "MCP lost original RSS citation",
    );
    assert(
      item.published_at === Date.parse("2026-11-08T09:00:00Z"),
      "MCP lost publication timestamp",
    );
    const scheduler = schedule(store, new Worker(store, new RssAdapter()));
    await scheduler.stop();
    console.log(
      JSON.stringify({
        smoke: "passed",
        tools: tools.tools.map((t) => t.name),
        duplicate_items: 0,
        conditional,
        restart: true,
        source_references: item.references.length,
      }),
    );
  } finally {
    await client?.close();
    await api?.stop(true);
    await feed.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
if (import.meta.main) await smoke();
