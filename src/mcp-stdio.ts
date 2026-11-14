import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { createMcp, type McpOptions } from "./mcp";
import type { Store } from "./db/store";
import { log } from "./worker";

/**
 * Tracks in-flight client requests whose tool handler has not finished yet.
 *
 * The SDK protocol sends a request's response (or error response) on the
 * transport only AFTER that request's handler has completed, so a request id
 * recorded on inbound and not yet seen on outbound means a handler whose
 * persistence — for example a discovery page's completePage/failPage settle —
 * has not happened yet. drain() resolves exactly when none is outstanding.
 */
export class PendingRequests {
  private readonly outstanding = new Set<unknown>();
  private notifyIdle: (() => void) | null = null;
  get size(): number {
    return this.outstanding.size;
  }
  /** Record an inbound client request that must produce a response. */
  add(message: JSONRPCMessage): void {
    if (!isJSONRPCRequest(message) || message.id === undefined) return;
    this.outstanding.add(message.id);
  }
  /** Mark the request id settled by an outbound response or error response. */
  settle(message: JSONRPCMessage): void {
    if (
      !(isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) ||
      !this.outstanding.has(message.id)
    )
      return;
    this.outstanding.delete(message.id);
    if (this.outstanding.size === 0) this.notifyIdle?.();
  }
  /** Forget every outstanding id (a closed transport can settle nothing). */
  clear(): void {
    const wasBusy = this.outstanding.size > 0;
    this.outstanding.clear();
    if (wasBusy) this.notifyIdle?.();
  }
  /** Resolves once every outstanding request has settled. */
  drain(): Promise<void> {
    if (this.outstanding.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      // A settle that raced this promise would fire before the callback is
      // installed, so re-check instead of waiting for a settle already done.
      this.notifyIdle = () => {
        this.notifyIdle = null;
        resolve();
      };
      if (this.outstanding.size === 0) this.notifyIdle();
    });
  }
}

/**
 * Serve the same MCP tool surface over the official SDK's stdio transport
 * (decision D15). This is an opt-in, local, single-client mode started with
 * `serve-mcp-stdio`; the Streamable HTTP path remains the default interface.
 *
 * Boundaries that the mode must keep explicit:
 *
 * - Stdout carries exclusively newline-delimited JSON-RPC protocol data. Every
 *   log line goes to stderr through `log()`, and nothing else in the process
 *   may write to stdout. Transport and protocol errors (for example a
 *   malformed stdin line) are reported on stderr, never on stdout.
 * - No scheduler, poller or delivery worker is started here. The process reads
 *   the same SQLite database as the main process, so running a second
 *   conflicting scheduler would double-claim jobs. Any scheduled work must run
 *   in its own process.
 * - Mutation tools keep the platform's preview → confirm flow unchanged; the
 *   confirmation tokens live in the database, so a preview and its confirm may
 *   cross between HTTP and stdio sessions.
 * - Shutdown is ordered so the shared database never loses discovered work: on
 *   client disconnect or a stop signal, new stdin parsing stops first, then
 *   in-flight tool handlers drain while the store is still open. The SDK sends
 *   a request's response only after its handler completes, so a drained
 *   handler has finished persisting (for example the reserved discovery page
 *   is completed or failed, never left for reconciliation) before this
 *   function returns and the CLI caller closes the store.
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
  const pending = new PendingRequests();
  const server = createMcp(store, options);
  // Neither this entry point nor createMcp installs the SDK's error callback;
  // without one, malformed stdin lines would be dropped silently. Route every
  // transport/protocol error through the shared stderr logger.
  server.server.onerror = (error) =>
    log("mcp_stdio_protocol_error", { error: error.message });
  // One client, one session. `closing` resolves only after in-flight tool
  // handlers have drained, keeping the database open until then; the store
  // closes when this function returns to the CLI caller.
  const closing = new Promise<void>((resolve) => {
    let shuttingDown = false;
    const stop = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Stop intake first. A stdin chunk delivered before the pause has
      // already been parsed synchronously, so the pending set is now exact.
      process.stdin.pause();
      log("mcp_stdio_draining", { in_flight: pending.size });
      while (pending.size > 0) await pending.drain();
      // With nothing in flight, close() cannot abandon a handler's
      // persistence: sessions stop accepting work, the transport closes and
      // the caller releases the database only afterwards.
      await server.close();
      resolve();
    };
    // Install transport hooks BEFORE connect(): the SDK protocol wraps the
    // callbacks that already exist, so these run while the protocol's own
    // bookkeeping stays intact. Callbacks assigned after connect() would
    // replace the protocol's wrapper instead.
    transport.onmessage = (message) => pending.add(message);
    const transportSend = transport.send.bind(transport);
    transport.send = (message: JSONRPCMessage) => {
      pending.settle(message);
      return transportSend(message);
    };
    transport.onclose = () => {
      pending.clear();
      if (!shuttingDown) {
        log("mcp_stdio_transport_closed", {
          note: "stdin ended or the read buffer was exceeded; nothing further is accepted",
        });
        void stop();
      }
    };
    // The SDK transport does not end the process when stdin closes, so the
    // disconnect and every stop signal route through the ordered shutdown.
    process.stdin.once("end", () => void stop());
    process.stdin.once("close", () => void stop());
    process.once("SIGTERM", () => void stop());
    process.once("SIGINT", () => void stop());
  });
  await server.connect(transport);
  log("mcp_stdio_started", {
    db: options.dbPath,
    note: "stdout carries JSON-RPC only; logs go to stderr",
  });
  await closing;
  // The transport is closed; release stdin so the process can exit naturally
  // once the CLI caller closes its store.
  process.stdin.destroy();
  log("mcp_stdio_stopped", {});
}
