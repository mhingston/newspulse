import { acquireDiscoveryLock, heldDiscoveryLock } from "./discovery-lock";
import { assertDiscoveryRestoreElapsed } from "./discovery-restore-guard";

/** The lock and guard operations, injected so the ordering is unit-testable. */
export interface DiscoveryDispatchBoundary {
  assertElapsed: (dbPath: string) => void;
  held: (dbPath: string) => { close(): void } | null;
  acquire: (dbPath: string) => { close(): void };
}

const defaults: DiscoveryDispatchBoundary = {
  assertElapsed: assertDiscoveryRestoreElapsed,
  held: heldDiscoveryLock,
  acquire: acquireDiscoveryLock,
};

/**
 * Shared boundary for one confirmed manual discovery dispatch (MCP
 * `trigger_discovery` and the CLI `discovery-trigger-confirm`).
 *
 * It enforces the same restore guard and exclusive process lock as scheduled
 * and CLI discovery, *before* the approval is consumed or the provider is
 * contacted. When this process already owns the lock — the running service —
 * the existing lock is reused, so the service keeps exclusive ownership through
 * shutdown while the in-process trigger runs under it. `:memory:` and an
 * omitted path (tests) skip the OS lock and restore guard, which require a file
 * database.
 */
export async function withDiscoveryDispatch<T>(
  dbPath: string | undefined,
  work: () => Promise<T> | T,
  boundary: DiscoveryDispatchBoundary = defaults,
): Promise<T> {
  if (!dbPath || dbPath === ":memory:") return work();
  // Fast fail before contending for the lock so a restore leaves the approval
  // untouched.
  boundary.assertElapsed(dbPath);
  // A restore writes the marker while it holds the exclusive lock. If this
  // dispatch passes the check above and is then descheduled, the restore can
  // finish and release the lock before this one acquires it, so the guard is
  // re-checked *under* the lock before any provider work.
  if (boundary.held(dbPath)) {
    boundary.assertElapsed(dbPath);
    return work();
  }
  const lock = boundary.acquire(dbPath);
  try {
    boundary.assertElapsed(dbPath);
    return await work();
  } finally {
    lock.close();
  }
}
