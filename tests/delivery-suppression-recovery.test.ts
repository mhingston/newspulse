import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Store } from "../src/db/store";
import { DeliveryStore } from "../src/db/delivery-store";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryWorker, type DeliveryEmailProvider } from "../src/delivery";
import { acquireDeliveryLock } from "../src/delivery-lock";

const date = "2026-11-09";
const recipient = "reader@example.test";
const sender = "sender@example.test";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// Builds a populated database at the pre-0047/0048 schema, the way an
// operator's pre-suppression backup looks, with one frozen edition and a
// pending outbox row for that edition. The backup is taken with VACUUM INTO
// from the same connection so the WAL is folded in.
function priorVersionBackup(dir: string): string {
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const old = join(dir, "prior-migrations");
  mkdirSync(join(old, "meta"), { recursive: true });
  for (const file of readdirSync(migrations)) {
    if (file.endsWith(".sql") && !/^004[789]_/.test(file))
      copyFileSync(join(migrations, file), join(old, file));
  }
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => !/^004[789]_/.test(entry.tag),
  );
  writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
  for (const file of readdirSync(join(migrations, "meta"))) {
    if (file.endsWith("_snapshot.json") && !/^004[789]/.test(file))
      copyFileSync(join(migrations, "meta", file), join(old, "meta", file));
  }
  const db = new Database(join(dir, "prior.sqlite"), {
    create: true,
    strict: true,
  });
  db.exec("PRAGMA foreign_keys=ON");
  migrate(drizzle(db), { migrationsFolder: old });
  db.query(
    "INSERT INTO items(id,identity,url,title,ingested_at,status) VALUES('story','url:https://example.test/story','https://example.test/story','Story',1,'extracted')",
  ).run();
  const items = [
    { itemId: "story", groupId: null, scoreId: null, snapshot: {} },
  ];
  const digests = new DigestStore(db);
  digests.freeze(
    {
      date,
      timezone: "Europe/London",
      subject: "News",
      html: "<p>Story</p>",
      text: "Story",
      decisionSnapshot: {},
      items,
    },
    1,
  );
  new DeliveryStore(db).prepare(
    date,
    recipient,
    sender,
    () => digests.get(date),
    1000,
  );
  const backup = join(dir, "backup.sqlite");
  db.query("VACUUM INTO ?").run(backup);
  db.close();
  return backup;
}

function runCli(
  dbPath: string,
  args: string[],
  env: Record<string, string> = {},
) {
  return Bun.spawnSync([process.execPath, cli, ...args], {
    env: {
      ...process.env,
      DB_PATH: dbPath,
      DELIVERY_FROM: sender,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("restored pre-0048 database: CLI suppression refuses under lock and persists once reopened with a fake sender", async () => {
  const dir = mkdtempSync(join(tmpdir(), "suppression-recovery-"));
  try {
    const backup = priorVersionBackup(dir);
    const before = new Database(backup, { readonly: true });
    try {
      expect(
        before
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_suppressions'",
          )
          .all(),
      ).toEqual([]);
      expect(
        before
          .query<{ status: string }, [string]>(
            "SELECT status FROM deliveries WHERE edition_date=?",
          )
          .get(date),
      ).toEqual({ status: "pending" });
    } finally {
      before.close();
    }
    const restored = join(dir, "restored.sqlite");
    const restore = Bun.spawnSync([process.execPath, cli, "restore", backup], {
      env: { ...process.env, DB_PATH: restored },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(restore.exitCode).toBe(0);

    // A service or reconciliation process holds the lock: the CLI must refuse.
    const lock = acquireDeliveryLock(restored);
    try {
      const refused = runCli(restored, [
        "delivery-suppress-preview",
        date,
        recipient,
        "re_restored_accept",
      ]);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr.toString()).toContain("in use");
    } finally {
      lock.close();
    }

    const preview = runCli(restored, [
      "delivery-suppress-preview",
      date,
      recipient,
      "re_restored_accept",
    ]);
    expect(preview.exitCode).toBe(0);
    const previewed = JSON.parse(preview.stdout.toString()) as {
      confirmation: { asOf: number; hash: string };
      outcome: string;
    };
    expect(previewed.outcome).toBe("suppressed_pending");
    const confirm = runCli(restored, [
      "delivery-suppress-confirm",
      date,
      recipient,
      "re_restored_accept",
      String(previewed.confirmation.asOf),
      previewed.confirmation.hash,
    ]);
    expect(confirm.exitCode).toBe(0);

    // Reopen the file as a restart would, with a sender that must never run.
    const sends: string[] = [];
    const reopened = new Store(restored);
    try {
      const provider: DeliveryEmailProvider = {
        async send(_message, key) {
          sends.push(key);
          return { id: "should-not-send" };
        },
      };
      await new DeliveryWorker(
        new DeliveryStore(reopened.sqlite),
        provider,
        () => Date.now() + 1000,
      ).send(Date.now() + 1000);
      expect(sends).toEqual([]);
      const outbox = reopened.sqlite
        .query<{ status: string; provider_id: string | null }, [string]>(
          "SELECT status,provider_id FROM deliveries WHERE edition_date=?",
        )
        .all(date);
      expect(outbox).toEqual([
        { status: "sent", provider_id: "re_restored_accept" },
      ]);
      const audits = reopened.sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM delivery_suppressions",
        )
        .get()!;
      expect(audits.n).toBe(1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
