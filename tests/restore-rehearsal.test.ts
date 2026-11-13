import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
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
import { parseFeed } from "../src/adapters/rss";
import { verifyDatabase } from "../src/recovery";
import { assertDeliveryRestoreAcknowledged } from "../src/delivery-restore-guard";
import { DAY_MS, retentionPolicy } from "../src/retention";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const DAY0 = Date.UTC(2026, 10, 1);
const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
<item><title>Alpha</title><link>https://example.test/alpha</link><guid>alpha-1</guid><description>rehearsalword body</description></item>
<item><title>Beta</title><link>https://example.test/beta</link><guid>beta-1</guid><description>betaword body</description></item>
</channel></rss>`;

/** Migrations up to 0048, the last version before feed-text purge columns. */
function priorVersionMigrations(dir: string): string {
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const old = join(dir, "prior-migrations");
  mkdirSync(join(old, "meta"), { recursive: true });
  for (const file of readdirSync(migrations)) {
    if (file.endsWith(".sql") && !/^0049_/.test(file))
      copyFileSync(join(migrations, file), join(old, file));
  }
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => !entry.tag.startsWith("0049_"),
  );
  writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
  for (const file of readdirSync(join(migrations, "meta"))) {
    if (file.endsWith("_snapshot.json") && !file.startsWith("0049"))
      copyFileSync(join(migrations, "meta", file), join(old, "meta", file));
  }
  return old;
}

/**
 * Builds a populated pre-0049 database with raw SQL at the 0048 schema and
 * snapshots it with VACUUM INTO. `Store` is not used here because its
 * constructor migrates to the bundled journal, which would silently produce a
 * current-version backup.
 */
function populatedPriorBackup(dir: string): string {
  const path = join(dir, "prior.sqlite");
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys=ON");
  migrate(drizzle(db), { migrationsFolder: priorVersionMigrations(dir) });
  const now = DAY0;
  db.query(
    "INSERT INTO sources(id,kind,url,title,enabled,poll_seconds,next_poll,failures) VALUES('src','rss','https://example.test/feed.xml','Feed',1,1800,0,0)",
  ).run();
  const items = [
    {
      id: "item-alpha",
      title: "Alpha",
      guid: "alpha-1",
      text: "rehearsalword body",
    },
    { id: "item-beta", title: "Beta", guid: "beta-1", text: "betaword body" },
  ];
  for (const item of items) {
    const url = `https://example.test/${item.title.toLowerCase()}`;
    db.query(
      "INSERT INTO items(id,identity,url,title,ingested_at,status) VALUES(?,?,?,?,?,'extracted')",
    ).run(item.id, `url:${url}`, url, item.title, now);
    db.query(
      "INSERT INTO item_sources(item_id,source_id,native_id,url) VALUES(?,'src',?,?)",
    ).run(item.id, item.guid, url);
    db.query(
      "INSERT INTO content_versions(item_id,source_id,native_id,title,text,url,observed_at) VALUES(?,'src',?,?,?,?,?)",
    ).run(item.id, item.guid, item.title, item.text, url, now);
    db.query("INSERT INTO content(item_id,text) VALUES(?,?)").run(
      item.id,
      `${item.text} full`,
    );
  }
  db.close();
  const backup = join(dir, "backup.sqlite");
  const raw = new Database(path, { strict: true });
  raw.query("VACUUM INTO ?").run(backup);
  raw.close();
  return backup;
}

function count(path: string, sql: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ n: number }, []>(sql).get()!.n;
  } finally {
    db.close();
  }
}

test("restore rehearsal: pre-0049 backup restores into a new stopped path, verifies, and a restart is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-rehearsal-"));
  try {
    const backup = populatedPriorBackup(dir);
    const before = verifyDatabase(backup);
    expect(before.problems).toEqual([]);
    expect(before.ok).toBe(true);
    const itemsBefore = count(backup, "SELECT count(*) n FROM items");
    const versionsBefore = count(
      backup,
      "SELECT count(*) n FROM content_versions",
    );
    expect(itemsBefore).toBe(2);

    const restored = join(dir, "restored", "newspulse.sqlite");
    const restore = Bun.spawnSync([process.execPath, cli, "restore", backup], {
      env: { ...process.env, DB_PATH: restored },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(restore.exitCode).toBe(0);
    expect(existsSync(restored)).toBe(true);
    // A restored snapshot may predate an accepted send: delivery stays blocked
    // until an operator reconciles provider state.
    expect(() => assertDeliveryRestoreAcknowledged(restored)).toThrow();

    // Integrity, foreign keys and FTS consistency on the restored copy.
    const report = verifyDatabase(restored);
    expect(report.integrity).toBe("ok");
    expect(report.foreignKeyViolations).toBe(0);
    expect(report.ftsConsistent).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.counts.items).toBe(itemsBefore);
    expect(report.counts.content_versions).toBe(versionsBefore);

    // Restart: reopening runs migrations to the bundled version. Re-polling the
    // same feed must not duplicate items, versions or processing work.
    const store = new Store(restored);
    try {
      const source = store.sources()[0]!;
      store.enqueueDue(DAY0 + DAY_MS, true);
      const poll = store.claim(DAY0 + DAY_MS)!;
      store.complete(
        poll,
        { items: parseFeed(FEED, source.url) },
        DAY0 + DAY_MS,
      );
    } finally {
      store.close();
    }
    expect(count(restored, "SELECT count(*) n FROM items")).toBe(itemsBefore);
    expect(
      count(
        restored,
        "SELECT count(*) n FROM (SELECT source_id,native_id FROM item_sources GROUP BY 1,2 HAVING count(*)>1)",
      ),
    ).toBe(0);
    const restarted = verifyDatabase(restored);
    expect(restarted.ftsConsistent).toBe(true);
    expect(restarted.problems).toEqual([]);
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../drizzle/meta/_journal.json", import.meta.url),
        ),
        "utf8",
      ),
    ).entries.length as number;
    expect(report.migrations).toBe(journal - 1);
    expect(restarted.migrations).toBe(journal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore rehearsal: retention purge after restore keeps verification passing", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-rehearsal-"));
  try {
    const backup = populatedPriorBackup(dir);
    const restored = join(dir, "restored.sqlite");
    expect(
      Bun.spawnSync([process.execPath, cli, "restore", backup], {
        env: { ...process.env, DB_PATH: restored },
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode,
    ).toBe(0);
    const store = new Store(restored);
    try {
      const policy = retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" });
      // Without a completed score the restored items are unsettled, so nothing is purged.
      const unsettled = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 5 * DAY_MS,
      });
      expect(unsettled.purged.feed_text).toBe(0);
      for (const id of ["item-alpha", "item-beta"]) {
        store.sqlite
          .query(
            "INSERT INTO processing_jobs(id,stage,item_id,generation,status,outcome,attempts,available_at,queued_at,created_at) VALUES(?, 'score', ?, 1, 'done', 'scored', 1, 0, 0, 0)",
          )
          .run(`score-${id}`, id);
      }
      const report = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 5 * DAY_MS,
      });
      expect(report.purged.feed_text).toBe(2);
    } finally {
      store.close();
    }
    const after = verifyDatabase(restored);
    expect(after.problems).toEqual([]);
    expect(after.ftsConsistent).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
