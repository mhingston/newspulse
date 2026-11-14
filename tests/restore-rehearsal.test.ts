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
import {
  HttpContentExtractor,
  extractionHandler,
} from "../src/adapters/extraction";
import { OpenAICompatibleAnalysis } from "../src/adapters/analysis";
import { analysisHandler } from "../src/analysis-service";
import { AnalysisBudget } from "../src/analysis-budget";
import { scoringHandler } from "../src/scoring-service";
import { ProcessingWorker } from "../src/worker";
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

const headline = (title: string, link: string) =>
  `<item><title>${title}</title><link>${link}</link><guid>${link}</guid><description>Acme released the Atlas 2 robotics model today.</description></item>`;
const FEEDS: [string, string][] = [
  [
    "https://news-one.example/rss",
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed One</title>${headline(
      "Acme releases Atlas 2 robotics model",
      "https://articles.example/alpha",
    )}</channel></rss>`,
  ],
  [
    "https://news-two.example/rss",
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed Two</title>${headline(
      "Atlas 2 robotics model launched by Acme",
      "https://articles.example/beta",
    )}</channel></rss>`,
  ],
];

/** Runs one poll for a specific source, skipping any other due source first. */
function pollSource(
  store: Store,
  source: { id: string; url: string },
  xml: string,
  now: number,
) {
  store.enqueueDue(now, true);
  let job = store.claim(now);
  while (job && job.source_id !== source.id) {
    store.complete(job, { items: [] }, now);
    job = store.claim(now);
  }
  store.complete(job!, { items: parseFeed(xml, source.url) }, now);
}

/**
 * Builds a populated backup by driving the real pipeline: polls feed parsed
 * items through the store, the processing stages run through the real
 * handlers from src/main.ts with the external providers faked at their
 * boundary (a scripted HTTP transport for extraction, a scripted LLM response
 * for analysis), the edition is frozen and its outbox row prepared through the
 * real digest and delivery stores, and the operator-facing backup command
 * snapshots the result. No hand-written schema SQL anywhere.
 */
async function pipelineBackup(
  dir: string,
): Promise<{ backup: string; sources: { id: string; xml: string }[] }> {
  const dbPath = join(dir, "source.sqlite");
  const store = new Store(dbPath);
  const sources: { id: string; xml: string }[] = [];
  for (const [url, xml] of FEEDS) {
    const source = store.addSource(url, "Feed");
    pollSource(store, source, xml, DAY0);
    sources.push({ id: source.id, xml });
  }
  const extractor = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async (url) => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<article>_UNTRUSTED_ article body for ${url.pathname}</article>`,
    }),
  );
  const analysisClient = new OpenAICompatibleAnalysis(
    {
      endpoint: "https://analysis.example/v1/chat/completions",
      model: "model",
      apiKey: "test-key",
      maxInputChars: 16000,
      maxOutputTokens: 1000,
      timeoutMs: 45000,
    },
    async () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                summary: "Acme released the Atlas 2 robotics model.",
                classification: "product release",
                claims: [],
                uncertainty: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
  );
  // The same handlers main.ts wires, with faked providers at the boundary.
  const worker = new ProcessingWorker(store, {
    extract: extractionHandler(store, extractor),
    group: async () => {
      const result = store.stories.reconcile();
      if (result.stale) throw new Error("Story inputs changed during grouping");
      return { status: "grouped", result: JSON.stringify(result) };
    },
    analyse: analysisHandler(
      store,
      analysisClient,
      new AnalysisBudget(store.sqlite, {
        maxTokens: 1_000_000,
        maxMicros: 1_000_000_000,
        maxConcurrent: 1,
      }),
      {
        provider: "https://analysis.example",
        model: "model",
        promptVersion: "1",
        reserveTokens: 1000,
        reserveMicros: 1000,
      },
    ),
    score: scoringHandler(store),
  });
  expect(await worker.drain("extract")).toBe(2);
  expect(await worker.drain("group")).toBe(2);
  expect(await worker.drain("analyse")).toBe(2);
  expect(await worker.drain("score")).toBe(2);

  const items = store.search("Atlas").map((item) => item.id);
  expect(items).toHaveLength(2);
  const digests = new DigestStore(store.sqlite);
  digests.freeze(
    {
      date,
      timezone: "Europe/London",
      subject: "News",
      html: "<p>Atlas 2</p>",
      text: "Atlas 2",
      decisionSnapshot: {},
      items: items.map((itemId) => ({
        itemId,
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
  return { backup, sources };
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
    const { backup, sources } = await pipelineBackup(dir);
    const before = verifyDatabase(backup);
    expect(before.problems).toEqual([]);
    expect(before.ok).toBe(true);
    expect(before.counts.items).toBe(2);
    expect(before.counts.item_scores).toBe(2);
    expect(before.counts.analyses).toBe(2);
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
    expect(report.counts.item_scores).toBe(before.counts.item_scores);
    expect(report.counts.analyses).toBe(before.counts.analyses);
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

    // Restart: reopening runs no new migrations. The processed history —
    // scores, analysis summaries and story memberships — survives, and
    // re-polling the same feeds must not duplicate items, versions or work.
    const store = new Store(restored);
    try {
      for (const itemId of store.search("Atlas").map((item) => item.id)) {
        const item = store.getItem(itemId)!;
        expect(item.summary).toBe("Acme released the Atlas 2 robotics model.");
        expect(item.story.current).not.toBeNull();
        const scores = store.scoreHistory(itemId);
        expect(scores).toHaveLength(1);
        expect(scores[0]!.result).toMatchObject({
          eligible: expect.any(Boolean),
        });
      }
      const memberships = store.sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM story_memberships WHERE ended_at IS NULL",
        )
        .get()!.n;
      expect(memberships).toBe(2);
      for (const { id, xml } of sources) {
        store.enqueueDue(DAY0 + DAY_MS, true);
        let poll = store.claim(DAY0 + DAY_MS)!;
        while (poll && poll.source_id !== id) {
          store.complete(poll, { items: [] }, DAY0 + DAY_MS);
          poll = store.claim(DAY0 + DAY_MS)!;
        }
        store.complete(
          poll,
          { items: parseFeed(xml, store.source(id)!.url) },
          DAY0 + DAY_MS,
        );
      }
      expect(count(restored, "SELECT count(*) n FROM items")).toBe(2);
      expect(
        count(
          restored,
          "SELECT count(*) n FROM (SELECT source_id,native_id FROM item_sources GROUP BY 1,2 HAVING count(*)>1)",
        ),
      ).toBe(0);
      expect(count(restored, "SELECT count(*) n FROM item_scores")).toBe(2);
      expect(count(restored, "SELECT count(*) n FROM analyses")).toBe(2);
      expect(count(restored, "SELECT count(*) n FROM story_memberships")).toBe(
        2,
      );

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
    const restarted = verifyDatabase(restored);
    expect(restarted.ftsConsistent).toBe(true);
    expect(restarted.problems).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore rehearsal: retention purge on the restored database keeps verification passing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-rehearsal-purge-"));
  try {
    const { backup, sources } = await pipelineBackup(dir);
    const restored = join(dir, "restored.sqlite");
    expect(restoreCli(backup, restored).exitCode).toBe(0);
    const before = verifyDatabase(restored);
    expect(before.counts.items).toBe(2);
    const store = new Store(restored);
    try {
      // The restored items carry scored, settled feed text, so the real
      // retention pass fingerprints and purges it on the restored copy.
      const report = store.retention(
        retentionPolicy({ RETENTION_FEED_TEXT_DAYS: "1" }),
        { dryRun: false, now: DAY0 + 5 * DAY_MS },
      );
      expect(report.purged.feed_text).toBe(2);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM content_versions WHERE text_fingerprint IS NULL",
          )
          .get()!.n,
      ).toBe(0);
      expect(store.search("Atlas 2")).toHaveLength(2);
      // A re-poll of the unchanged feeds stays tombstoned: no text is restored
      // and no new extraction generation is queued.
      for (const { id, xml } of sources) {
        store.enqueueDue(DAY0 + 6 * DAY_MS, true);
        let poll = store.claim(DAY0 + 6 * DAY_MS)!;
        while (poll && poll.source_id !== id) {
          store.complete(poll, { items: [] }, DAY0 + 6 * DAY_MS);
          poll = store.claim(DAY0 + 6 * DAY_MS)!;
        }
        store.complete(
          poll,
          { items: parseFeed(xml, store.source(id)!.url) },
          DAY0 + 6 * DAY_MS,
        );
      }
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM processing_jobs WHERE stage='extract' AND generation>1",
          )
          .get()!.n,
      ).toBe(0);
      expect(
        store.sqlite
          .query<{ text: string }, []>("SELECT DISTINCT text FROM content")
          .all(),
      ).toEqual([{ text: "" }]);
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
