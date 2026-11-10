import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const dayMs = 86_400_000;
function markerPath(dbPath: string): string {
  if (!dbPath || dbPath === ":memory:")
    throw new Error("Discovery restore guard requires a file database");
  const absolute = resolve(dbPath);
  const canonical = existsSync(absolute)
    ? realpathSync(absolute)
    : join(realpathSync(dirname(absolute)), basename(absolute));
  return `${canonical}.discovery-restore-pending`;
}
function checkTime(now: number) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid discovery restore time");
}

/** Call before copying a backup into a new database path, while dispatch is stopped. */
export function markRestoredDiscovery(dbPath: string, now = Date.now()): void {
  checkTime(now);
  const marker = markerPath(dbPath);
  const fd = openSync(
    marker,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, JSON.stringify({ version: 1, restoredAt: now }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(dirname(marker), constants.O_RDONLY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** Missing marker means no managed restore. Keep the marker after expiry to fail closed on clock rollback. */
export function assertDiscoveryRestoreElapsed(
  dbPath: string,
  now = Date.now(),
): void {
  checkTime(now);
  const marker = markerPath(dbPath);
  let fd: number;
  try {
    fd = openSync(
      marker,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Unable to inspect discovery restore guard");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024)
      throw new Error("Invalid discovery restore guard");
    const record: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new Error("Invalid discovery restore guard");
    const { version, restoredAt } = record as {
      version?: unknown;
      restoredAt?: unknown;
    };
    if (
      version !== 1 ||
      typeof restoredAt !== "number" ||
      !Number.isSafeInteger(restoredAt) ||
      restoredAt < 0
    )
      throw new Error("Invalid discovery restore guard");
    if (Math.floor(now / dayMs) <= Math.floor(restoredAt / dayMs))
      throw new Error(
        "Discovery is blocked until the next UTC day after restore",
      );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message ===
        "Discovery is blocked until the next UTC day after restore" ||
        error.message === "Invalid discovery restore guard")
    )
      throw error;
    throw new Error("Invalid discovery restore guard");
  } finally {
    closeSync(fd);
  }
}
