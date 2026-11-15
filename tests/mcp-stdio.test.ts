import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { PendingRequests } from "../src/mcp-stdio";
import { Store } from "../src/db/store";
import { RssAdapter } from "../src/adapters/rss";
import { Worker } from "../src/worker";
import { rss } from "./fixtures";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// Issue #30: the opt-in `serve-mcp-stdio` mode reuses createMcp over the
// official SDK's StdioServerTransport. These tests connect with the official
// SDK's StdioClientTransport (spawned subprocess, same pinned SDK version as
// the server) and assert the contracts in the issue: same tool list, clean
// close without leaked processes or DB handles, malformed-line resilience,
// unchanged mutation semantics, and stdout that carries only protocol data
// while logs go to stderr. All fixtures are local and deterministic: no live
// providers and no real email.

const expectedToolNames = [
  "add_source",
  "explain_ranking",
  "get_digest",
  "get_discoveries",
  "get_feedback",
  "get_development_changes",
  "get_interests",
  "get_item",
  "get_sources",
  "get_status",
  "get_story_group",
  "get_submission",
  "ingest_url",
  "remove_source",
  "search_items",
  "submit_feedback",
  "trigger_discovery",
  "update_interest",
].sort();

let dbPath = "";
let fixtureItemId = "";
let fixtureDir = "";

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "stdio-mcp-"));
  dbPath = join(fixtureDir, "fixture.sqlite");
  const feed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(rss, {
        headers: { "content-type": "application/xml" },
      });
    },
  });
  const store = new Store(dbPath);
  try {
    store.addSource(`${feed.url}rss`, "Fixture feed");
    store.enqueueDue();
    await new Worker(store, new RssAdapter()).drain();
    fixtureItemId = store.search("robotics")[0]!.id;
  } finally {
    store.close();
  }
  feed.stop(true);
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** Spawn `serve-mcp-stdio` through the official SDK stdio client transport. */
function stdioSession(stderr: "pipe" | "inherit" = "pipe"): {
  client: Client;
  transport: StdioClientTransport;
} {
  const env: Record<string, string> = { ...process.env, DB_PATH: dbPath };
  for (const key of Object.keys(env))
    if (env[key] === undefined) delete env[key];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "..", "src", "cli.ts"), "serve-mcp-stdio"],
    cwd: join(import.meta.dir, ".."),
    env,
    stderr,
  });
  const client = new Client({ name: "stdio-interop-test", version: "1.0.0" });
  return { client, transport };
}

/** Poll until the spawned server process has exited. */
async function exited(pid: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

const request = (id: number): JSONRPCMessage =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: {} }) as JSONRPCMessage;
const result = (id: number): JSONRPCMessage =>
  ({ jsonrpc: "2.0", id, result: {} }) as JSONRPCMessage;
const errorResponse = (id: number): JSONRPCMessage =>
  ({
    jsonrpc: "2.0",
    id,
    error: { code: -32603, message: "boom" },
  }) as JSONRPCMessage;

test("PendingRequests drains only after every in-flight tool handler's response settles (issue #30 review finding 1)", async () => {
  const pending = new PendingRequests();
  // Notifications must never block a drain.
  pending.add({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  } as JSONRPCMessage);
  expect(pending.size).toBe(0);
  pending.add(request(1));
  pending.add(request(2));
  expect(pending.size).toBe(2);
  const drained = pending.drain();
  let resolved = false;
  void drained.then(() => {
    resolved = true;
  });
  await Bun.sleep(5);
  expect(resolved).toBe(false);
  // A handler still holding its id keeps the database open (no drain).
  pending.settle(result(1));
  expect(pending.size).toBe(1);
  await Bun.sleep(5);
  expect(resolved).toBe(false);
  // A handler that FAILED also settles (its error response is its settle).
  pending.settle(errorResponse(2));
  expect(pending.size).toBe(0);
  await drained;
  expect(await pending.drain()).toBeUndefined();
});

test("PendingRequests.clear settles an interrupted session so shutdown cannot hang", async () => {
  const pending = new PendingRequests();
  pending.add(request(7));
  const drained = pending.drain();
  pending.clear();
  expect(pending.size).toBe(0);
  await drained;
});

test("official SDK client over stdio initializes, lists the same tool contract, calls read tools and closes without leaks", async () => {
  const { client, transport } = stdioSession();
  // The ordered shutdown is observable: draining runs before the process
  // exits, so a settled handler never races the caller's store close.
  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) =>
    stderrChunks.push(chunk.toString("utf8")),
  );
  const errors: unknown[] = [];
  transport.onerror = (error) => errors.push(error);
  expect(transport.pid).toBeNull();
  await client.connect(transport);
  const pid = transport.pid!;
  expect(pid).not.toBeNull();
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
    expectedToolNames,
  );
  const search = await client.callTool({
    name: "search_items",
    arguments: { query: "robotics" },
  });
  const payload = JSON.parse((search.content as { text: string }[])[0]!.text);
  expect(payload.items.length).toBe(1);
  const detail = await client.callTool({
    name: "get_item",
    arguments: { id: payload.items[0].id },
  });
  const item = JSON.parse((detail.content as { text: string }[])[0]!.text);
  expect(item.id).toBe(payload.items[0].id);
  const sources = await client.callTool({
    name: "get_sources",
    arguments: {},
  });
  const listed = JSON.parse((sources.content as { text: string }[])[0]!.text);
  expect(listed.sources.length).toBe(1);
  // A clean client close ends stdin; the server drains (nothing in flight
  // here) and exits on its own instead of leaking a process or its DB handle.
  await client.close();
  expect(await exited(pid)).toBe(true);
  const events = stderrChunks
    .join("")
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.event === "mcp_stdio_draining")).toBe(
    true,
  );
  expect(events.some((event) => event.event === "mcp_stdio_stopped")).toBe(
    true,
  );
  expect(errors).toEqual([]);
});

test("stderr logging never appears in the stdout protocol stream", async () => {
  const { client, transport } = stdioSession();
  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) =>
    stderrChunks.push(chunk.toString("utf8")),
  );
  const errors: unknown[] = [];
  transport.onerror = (error) => errors.push(error);
  const clientTransport = client.transport as Transport | undefined;
  const clientErrors: unknown[] = [];
  if (clientTransport) clientTransport.onerror = (e) => clientErrors.push(e);
  await client.connect(transport);
  await client.listTools();
  await client.callTool({ name: "get_status", arguments: {} });
  await client.close();
  const stderr = stderrChunks.join("");
  expect(stderr.length).toBeGreaterThan(0);
  // Logs are JSON lines on stderr; stdout carried only newline-delimited
  // JSON-RPC, because stray bytes there would have errored the client
  // transport's read buffer (and failed the run).
  const events = stderr
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.event === "mcp_stdio_started")).toBe(
    true,
  );
  expect(errors).toEqual([]);
  expect(clientErrors).toEqual([]);
});

test("malformed line on stdin does not corrupt the protocol: the next valid request is still answered", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "src", "cli.ts"),
      "serve-mcp-stdio",
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, DB_PATH: dbPath },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderrChunks: string[] = [];
  void (async () => {
    const reader = proc.stderr!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      try {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(decoder.decode(value, { stream: true }));
      } catch {
        break;
      }
    }
  })();
  proc.stdin!.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw-probe", version: "0" },
      },
    })}\n`,
  );
  // Garbage on its own line after the initialize request: the SDK read buffer
  // skips the bad line, reports a protocol error internally and keeps reading.
  proc.stdin!.write("{not json at all}\n");
  proc.stdin!.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  proc.stdin!.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  );
  proc.stdin!.flush();
  const lines: string[] = [];
  const reader = proc.stdout!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (lines.length < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1 && lines.length < 2) {
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  void reader.cancel().catch(() => {});
  expect(lines.length).toBe(2);
  const messages = lines.map((line) => JSON.parse(line));
  expect(messages[0].id).toBe(1);
  expect(messages[0].result.serverInfo.name).toBe("newspulse");
  expect(messages[1].id).toBe(2);
  expect(
    messages[1].result.tools.map((tool: { name: string }) => tool.name),
  ).toEqual(expect.arrayContaining(expectedToolNames));
  // The malformed line did not end the session, and it produced the promised
  // stderr diagnostic (issue #30 review finding 2): neither the entry point
  // nor createMcp left the SDK error callback uninstalled. The error message
  // text comes from the runtime's JSON parser, so the contract here is that a
  // diagnostic event exists and carries a message.
  await Bun.sleep(100);
  const stderr = stderrChunks.join("");
  expect(stderr).toContain("mcp_stdio_protocol_error");
  const errorEvents = stderr
    .split("\n")
    .filter((line) => line.includes("mcp_stdio_protocol_error"))
    .map((line) => JSON.parse(line));
  expect(errorEvents.length).toBeGreaterThan(0);
  expect(
    errorEvents.every(
      (event) => typeof event.error === "string" && event.error.length > 0,
    ),
  ).toBe(true);
  expect(proc.exitCode).toBeNull();
  proc.stdin!.end();
  proc.kill();
  await proc.exited;
});

test("mutation tools keep their preview-confirm semantics over stdio; confirmations persist in the shared database", async () => {
  const { client, transport } = stdioSession();
  await client.connect(transport);
  const preview = await client.callTool({
    name: "submit_feedback",
    arguments: { item_id: fixtureItemId, action: "useful" },
  });
  const previewPayload = JSON.parse(
    (preview.content as { text: string }[])[0]!.text,
  );
  expect(previewPayload.status).toBe("confirmation_required");
  expect(previewPayload.confirm_token).toBeTruthy();
  const confirmed = await client.callTool({
    name: "submit_feedback",
    arguments: {
      item_id: fixtureItemId,
      action: "useful",
      confirm_token: previewPayload.confirm_token,
    },
  });
  const confirmedPayload = JSON.parse(
    (confirmed.content as { text: string }[])[0]!.text,
  );
  expect(confirmedPayload.itemId).toBe(fixtureItemId);
  expect(confirmedPayload.useful).toBe(true);
  expect(confirmedPayload.source).toBe("mcp");
  // The confirmation token lives in the same SQLite store every session uses,
  // so the flow is unchanged across transports.
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query(
        "SELECT useful,source FROM item_feedback WHERE item_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(fixtureItemId) as { useful: number; source: string } | null;
    expect(row?.useful).toBe(1);
    expect(row?.source).toBe("mcp");
  } finally {
    db.close();
  }
  await client.close();
});
