import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  writeSync,
  lstatSync,
  realpathSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function markerPath(dbPath: string) {
  const absolute = resolve(dbPath);
  const canonical = existsSync(absolute)
    ? realpathSync(absolute)
    : join(realpathSync(dirname(absolute)), basename(absolute));
  return `${canonical}.delivery-restore-pending`;
}
/** Must precede the backup copy, while the exclusive delivery lock is held. */
export function markRestoredDelivery(dbPath: string, now = Date.now()) {
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
    writeSync(
      fd,
      JSON.stringify({
        version: 1,
        nonce: crypto.randomUUID(),
        restoredAt: now,
      }),
    );
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
export function assertDeliveryRestoreAcknowledged(dbPath: string) {
  try {
    lstatSync(markerPath(dbPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Unable to inspect delivery restore guard");
  }
  throw new Error(
    "Restored database requires delivery recovery acknowledgment before outbound delivery",
  );
}
function snapshot(dbPath: string, now: number) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid confirmation time");
  const marker = markerPath(dbPath);
  const contents = readFileSync(marker, "utf8");
  const action = {
    kind: "acknowledge_restored_delivery_reconciliation",
    database: resolve(dbPath),
    marker: contents,
    asOf: now,
  };
  return {
    warning:
      "Audit provider history since the backup and reconcile every restored outbox row. If an accepted send has no outbox row, keep delivery disabled through that edition date and until all matching frozen editions are suppressed. If no safe suppression is available, keep delivery disabled and do not confirm.",
    database: action.database,
    confirmation: {
      asOf: now,
      expiresAt: now + 300_000,
      hash: createHash("sha256").update(JSON.stringify(action)).digest("hex"),
    },
  };
}
export function previewDeliveryRestoreAcknowledgment(
  dbPath: string,
  now = Date.now(),
) {
  return snapshot(dbPath, now);
}
/** Caller must hold the exclusive delivery lock and keep all senders stopped. */
export function confirmDeliveryRestoreAcknowledgment(
  dbPath: string,
  asOf: number,
  hash: string,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(now) || now < asOf || now - asOf > 300_000)
    throw new Error("Delivery restore confirmation expired");
  const preview = snapshot(dbPath, asOf);
  if (!/^[a-f0-9]{64}$/.test(hash) || hash !== preview.confirmation.hash)
    throw new Error(
      "Delivery restore confirmation does not match current state",
    );
  unlinkSync(markerPath(dbPath));
}
