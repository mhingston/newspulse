import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcp, type McpOptions } from "./mcp";
import type { Store } from "./db/store";
import { log } from "./worker";

/**
 * Serve the same MCP tool surface over the official SDK's stdio transport
 * (decision D15). This is an opt-in, local, single-client mode started with
 * `serve-mcp-stdio`; the Streamable HTTP path remains the default interface.
 *
 * Boundaries that the mode must keep explicit:
 *
 * - Stdout carries exclusively newline-delimited JSON-RPC protocol data. Every
 *   log line goes to stderr through `log()`, and nothing else in the process
 *   may write to stdout.
 * - No scheduler, poller or delivery worker is started here. The process reads
 *   the same SQLite database as the main process, so running a second
 *   conflicting scheduler would double-claim jobs. Any scheduled work must run
 *   in its own process.
 * - Mutation tools keep the platform's preview → confirm flow unchanged; the
 *   confirmation tokens live in the database, so a preview and its confirm may
 *   cross between HTTP and stdio sessions.
 * - STDOUT protocol discipline relies on startup errors also going to stderr:
 *   the CLI's error path writes to stderr, so a failure never lands on stdout.
 * - The connecting client process runs locally with the operator's filesystem
 *   and database access. There is no network authentication in stdio mode;
 *   local trust replaces the HTTP bearer token. Only connect clients the
 *   operator trusts with full data and approved CLI-tool access.
 */
export async function serveMcpStdio(
  store: Store,
  options: McpOptions = {},
): Promise<void> {
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  const server = createMcp(store, options);
  await server.connect(transport);
  log("mcp_stdio_started", {
    db: options.dbPath,
    note: "stdout carries JSON-RPC only; logs go to stderr",
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log("mcp_stdio_stopping", {});
    await server.close();
  };
  // The SDK transport does not end its server process when stdin closes, so
  // observe EOF (and hard closes) here: one client, one session — when the
  // client disconnects the process should exit instead of lingering.
  const stdin = process.stdin;
  stdin.once("end", () => void stop());
  stdin.once("close", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  await closed;
  // The transport is closed; release stdin so the process can exit naturally
  // once the CLI caller closes its store.
  stdin.destroy();
  log("mcp_stdio_stopped", {});
}
