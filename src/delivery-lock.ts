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

/** The service holds this OS lock for its whole lifetime, including in-flight requests. */
export function acquireDeliveryLock(dbPath: string): { close(): void } {
  if (process.platform !== "linux" || dbPath === ":memory:")
    throw new Error(
      "Delivery service exclusion requires a file database on Linux",
    );
  const absolute = resolve(dbPath);
  mkdirSync(dirname(absolute), { recursive: true });
  const canonical = existsSync(absolute)
    ? realpathSync(absolute)
    : join(realpathSync(dirname(absolute)), basename(absolute));
  const libc = dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  let fd: number;
  try {
    fd = openSync(
      `${canonical}.delivery.lock`,
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
  return {
    close() {
      if (!closed) {
        closed = true;
        closeSync(fd);
        libc.close();
      }
    },
  };
}
