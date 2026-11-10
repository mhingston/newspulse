import { acquireDiscoveryLock, heldDiscoveryLock } from "./discovery-lock";
import { assertDiscoveryRestoreElapsed } from "./discovery-restore-guard";

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
): Promise<T> {
  if (!dbPath || dbPath === ":memory:") return work();
  assertDiscoveryRestoreElapsed(dbPath);
  if (heldDiscoveryLock(dbPath)) return work();
  const lock = acquireDiscoveryLock(dbPath);
  try {
    return await work();
  } finally {
    lock.close();
  }
}
