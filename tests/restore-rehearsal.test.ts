import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryStore } from "../src/db/delivery-store";
import { DeliveryWorker, type DeliveryEmailProvider } from "../src/delivery";
import { parseFeed } from "../src/adapters/rss";
import { verifyDatabase } from "../src/recovery";
import {
  assertDeliveryRestoreAcknowledged,
  confirmDeliveryRestoreAcknowledgment,
  previewDeliveryRestoreAcknowledgment,
} from "../src/delivery-restore-guard";
import {
  confirmDeliverySuppression,
  previewDeliverySuppression,
} from "../src/delivery-suppression";
import { DAY_MS, retentionPolicy } from "../src/retention";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const DAY0 = Date.UTC(2026, 10, 1);
const date = "2026-11-01";
const recipient = "reader@example.test";
const sender = "sender@example.test";
const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
<item><title>Alpha</title><link>https://example.test/alpha</link><guid>alpha-1</guid><description>rehearsalword body</description></item>
<item><title>Beta</title><link>https://example.test/beta</link><guid>beta-1</guid><description>betaword body</description></item>
</channel></rss>`;

/**
 * Builds a populated backup by driving the real pipeline: a real poll feeds
 * parsed items through the store, the processing stages run through the real
 * claim/complete paths with the extraction and analysis providers faked at
 * their boundary, the edition is frozen and its outbox row prepared through
 * the real digest and delivery stores, and the operator-facing backup command
 * snapshots the result. No hand-written schema SQL anywhere.
 */
function pipelineBackup(dir: string): string {
  const dbPath = join(dir, "source.sqlite");
  const store = new Store(dbPath);
  const source = store.addSource("https://example.test/feed.xml", "Feed");
  store.enqueueDue(DAY0);
  const poll = store.claim(DAY0)!;
  store.complete(poll, { items: parseFeed(FEED, source.url) }, DAY0);
  const items: { itemId: string; title: string }[] = [];
  for (const title of ["Alpha", "Beta"]) {
    const item = store.search(title)[0]!;
    items.push({ itemId: item.id, title });
    const extract = store.claimProcessing("extract", DAY0)!;
    store.completeProcessing(
      extract,
      "extracted",
      DAY0,
      JSON.stringify({ status: "extracted", text: `payload ${title} body` }),
    );
    store.completeProcessing(
      store.claimProcessing("group", DAY0)!,
      "grouped",
      DAY0,
    );
    store.completeProcessing(
      store.claimProcessing("analyse", DAY0)!,
      "unavailable",
      DAY0,
    );
    store.completeProcessing(
      store.claimProcessing("score", DAY0)!,
      "scored",
      DAY0,
    );
  }
  const digests = new DigestStore(store.sqlite);
  digests.freeze(
    {
      date,
      timezone: "Europe/London",
      subject: "News",
      html: "<p>Alpha</p>",
      text: "Alpha",
      decisionSnapshot: {},
      items: items.map((item) => ({
        itemId: item.itemId,
        groupId: null,
        scoreId: null,
        snapshot: {},
      })),
    },
    DAY0,
  );
  new DeliveryStore(store.sqlite).prepare(
    date,
    recipient,
    sender,
    () => digests.get(date),
    DAY0,
  );
  store.close();
  // The operator-facing backup command snapshots the populated database.
  const backup = join(dir, "backup.sqlite");
  const backupRun = Bun.spawnSync([process.execPath, cli, "backup", backup], {
    env: { ...process.env, DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (backupRun.exitCode !== 0)
    throw new Error(`backup failed: ${backupRun.stderr.toString()}`);
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

function restoreCli(backup: string, restored: string) {
  return Bun.spawnSync([process.execPath, cli, "restore", backup], {
    env: { ...process.env, DB_PATH: restored },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("restore rehearsal: pipeline-built backup restores into a new stopped path, verifies, and a restart is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-rehearsal-"));
  try {
    const backup = pipelineBackup(dir);
    const before = verifyDatabase(backup);
    expect(before.problems).toEqual([]);
    expect(before.ok).toBe(true);
    expect(before.counts.items).toBe(2);
    expect(before.counts.deliveries).toBe(1);

    const restored = join(dir, "restored", "newspulse.sqlite");
    expect(restoreCli(backup, restored).exitCode).toBe(0);
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
    expect(report.counts.items).toBe(before.counts.items);
    expect(report.counts.content_versions).toBe(before.counts.content_versions);
    expect(report.counts.deliveries).toBe(1);
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../drizzle/meta/_journal.json", import.meta.url),
        ),
        "utf8",
      ),
    ).entries.length as number;
    expect(report.migrations).toBe(journal);

    // Restart: reopening runs no new migrations. Re-polling the same feed must
    // not duplicate items, versions or processing work, and the prepared
    // outbox row survives.
    const store = new Store(restored);
    const ids: string[] = [];
    try {
      const source = store.sources()[0]!;
      store.enqueueDue(DAY0 + DAY_MS, true);
      const poll = store.claim(DAY0 + DAY_MS)!;
      store.complete(
        poll,
        { items: parseFeed(FEED, source.url) },
        DAY0 + DAY_MS,
      );
      ids.push(...store.search("Alpha").map((item) => item.id));
      // The operator reconciles the restored database: the provider had
      // accepted the send before the crash, so the pending outbox row is
      // suppressed with a payload-bound confirmation and never resent.
      const context = { sender };
      const action = {
        editionDate: date,
        recipient,
        providerId: "re_accepted_rehearsal",
      };
      const asOf = DAY0 + DAY_MS + 1000;
      const preview = previewDeliverySuppression(
        store.sqlite,
        action,
        context,
        asOf,
      );
      expect(preview.outcome).toBe("suppressed_pending");
      confirmDeliverySuppression(
        store.sqlite,
        action,
        context,
        asOf,
        preview.confirmation.hash,
        asOf + 1,
      );
      const acknowledgment = previewDeliveryRestoreAcknowledgment(
        restored,
        asOf,
      );
      confirmDeliveryRestoreAcknowledgment(
        restored,
        asOf,
        acknowledgment.confirmation.hash,
        asOf,
      );
      expect(() => assertDeliveryRestoreAcknowledged(restored)).not.toThrow();
      const sends: string[] = [];
      const provider: DeliveryEmailProvider = {
        async send(_message, key) {
          sends.push(key);
          return { id: "should-not-send" };
        },
      };
      const deliveries = new DeliveryStore(store.sqlite);
      await new DeliveryWorker(deliveries, provider, () => asOf + 2).send(
        asOf + 2,
      );
      expect(sends).toEqual([]);
      expect(
        store.sqlite
          .query<{ status: string; provider_id: string }, [string]>(
            "SELECT status,provider_id FROM deliveries WHERE edition_date=?",
          )
          .get(date),
      ).toEqual({ status: "sent", provider_id: "re_accepted_rehearsal" });
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM delivery_suppressions",
          )
          .get()!.n,
      ).toBe(1);
    } finally {
      store.close();
    }
    expect(count(restored, "SELECT count(*) n FROM items")).toBe(2);
    expect(
      count(
        restored,
        "SELECT count(*) n FROM (SELECT source_id,native_id FROM item_sources GROUP BY 1,2 HAVING count(*)>1)",
      ),
    ).toBe(0);
    const restarted = verifyDatabase(restored);
    expect(restarted.ftsConsistent).toBe(true);
    expect(restarted.problems).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore rehearsal: retention purge on the restored database keeps verification passing", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-rehearsal-purge-"));
  try {
    const backup = pipelineBackup(dir);
    const restored = join(dir, "restored.sqlite");
    expect(restoreCli(backup, restored).exitCode).toBe(0);
    const before = verifyDatabase(restored);
    expect(before.counts.items).toBe(2);
    const store = new Store(restored);
    try {
      // The restored items carry scored, settled feed text, so the real
      // retention pass purges it on the restored copy.
      const report = store.retention(
        retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }),
        { dryRun: false, now: DAY0 + 5 * DAY_MS },
      );
      expect(report.purged.feed_text).toBe(2);
      expect(store.search("rehearsalword")).toHaveLength(0);
      expect(store.search("Alpha")).toHaveLength(1);
      // A re-poll of the unchanged feed stays tombstoned: no text is restored
      // and no new extraction generation is queued.
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM content_versions WHERE text_fingerprint IS NULL",
          )
          .get()!.n,
      ).toBe(0);
      const source = store.sources()[0]!;
      store.enqueueDue(DAY0 + 6 * DAY_MS, true);
      const poll = store.claim(DAY0 + 6 * DAY_MS)!;
      store.complete(
        poll,
        { items: parseFeed(FEED, source.url) },
        DAY0 + 6 * DAY_MS,
      );
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM processing_jobs WHERE stage='extract' AND generation>1",
          )
          .get()!.n,
      ).toBe(0);
      expect(
        store.sqlite
          .query<{ text: string }, [string]>(
            "SELECT text FROM content WHERE item_id=?",
          )
          .get(store.search("Alpha")[0]!.id)!.text,
      ).toBe("");
    } finally {
      store.close();
    }
    const after = verifyDatabase(restored);
    expect(after.problems).toEqual([]);
    expect(after.ftsConsistent).toBe(true);
    expect(after.counts.retention_purges).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
