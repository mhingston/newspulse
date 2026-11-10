import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Process-lifetime discovery locks, keyed by the resolved database path. The
 * running service registers its lock here so an in-process dispatch (an MCP
 * confirmation) reuses it instead of trying to re-acquire.
 */
const held = new Map<string, { close(): void }>();

/** The service holds this OS lock for its whole lifetime, including in-flight requests. */
export function acquireDiscoveryLock(dbPath: string): { close(): void } {
  if (process.platform !== "linux" || dbPath === ":memory:")
    throw new Error(
      "Discovery service exclusion requires a file database on Linux",
    );
  const key = resolve(dbPath);
  if (held.has(key))
    throw new Error(
      "Database is in use by a service or reconciliation process",
    );
  mkdirSync(dirname(key), { recursive: true });
  const canonical = existsSync(key)
    ? realpathSync(key)
    : join(realpathSync(dirname(key)), basename(key));
  const libc = dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  let fd: number;
  try {
    fd = openSync(
      `${canonical}.discovery.lock`,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    libc.close();
    throw error;
  }
  if (libc.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    libc.close();
    throw new Error(
      "Database is in use by a service or reconciliation process",
    );
  }
  let closed = false;
  const handle = {
    close() {
      if (!closed) {
        closed = true;
        held.delete(key);
        closeSync(fd);
        libc.close();
      }
    },
  };
  held.set(key, handle);
  return handle;
}

/**
 * The process-wide discovery lock for `dbPath`, when this process already owns
 * it. Returns null when another process owns it or this process holds none.
 */
export function heldDiscoveryLock(dbPath: string): { close(): void } | null {
  if (dbPath === ":memory:") return null;
  return held.get(resolve(dbPath)) ?? null;
}
