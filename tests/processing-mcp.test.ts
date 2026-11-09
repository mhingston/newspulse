import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/db/store";
import { ProcessingWorker } from "../src/worker";
import { createApp } from "../src/http";

test("MCP serves ingested item while analysis is blocked and reports queue health", async () => {
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue();
  store.complete(store.claim()!, {
    items: [
      { nativeId: "1", title: "Blocked analysis", text: "searchable item" },
    ],
  });
  const extracted = store.claimProcessing("extract")!;
  store.completeProcessing(extracted, "extracted");
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const worker = new ProcessingWorker(store, {
    analyse: async () => {
      started();
      await gate;
      return { status: "analysed" };
    },
  });
  const work = worker.drain("analyse", 1);
  await active;
  const token = "test-token-with-at-least-24-characters";
  const app = createApp(store, {
    token,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  const client = new Client({ name: "processing-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("mcp", server.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const search = await client.callTool({
      name: "search_items",
      arguments: { query: "searchable" },
    });
    const payload = JSON.parse((search.content as { text: string }[])[0]!.text);
    expect(payload.items).toHaveLength(1);
    const detail = await client.callTool({
      name: "get_item",
      arguments: { id: payload.items[0].id },
    });
    const item = JSON.parse((detail.content as { text: string }[])[0]!.text);
    const explanation = await client.callTool({
      name: "explain_ranking",
      arguments: { id: payload.items[0].id },
    });
    const ranking = JSON.parse(
      (explanation.content as { text: string }[])[0]!.text,
    );
    expect(ranking.item_id).toBe(payload.items[0].id);
    expect(ranking.references).toEqual(item.references);
    expect(ranking.scores).toEqual([]);
    const missing = await client.callTool({
      name: "explain_ranking",
      arguments: { id: "missing" },
    });
    expect(missing.isError).toBe(true);
    expect(
      item.processing.some(
        (job: { stage: string; status: string }) =>
          job.stage === "analyse" && job.status === "running",
      ),
    ).toBe(true);
    const health = await client.callTool({ name: "get_status", arguments: {} });
    const status = JSON.parse((health.content as { text: string }[])[0]!.text);
    expect(status.processing_jobs).toContainEqual({
      stage: "analyse",
      status: "running",
      count: 1,
    });
  } finally {
    release();
    await work;
    await client.close();
    await server.stop(true);
    store.close();
  }
});
