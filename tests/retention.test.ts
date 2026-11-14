import { afterEach, describe, expect, test } from "bun:test";
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
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db/store";
import { DAY_MS, retentionPolicy } from "../src/retention";
import { verifyDatabase } from "../src/recovery";
import { parseFeed } from "../src/adapters/rss";
import { DigestStore } from "../src/db/digest-store";
import { OpenAICompatibleAnalysis } from "../src/adapters/analysis";
import { AnalysisBudget } from "../src/analysis-budget";
import { analysisHandler } from "../src/analysis-service";
import { ProcessingWorker } from "../src/worker";
import { scoreItem } from "../src/scoring";

const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-retention-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const DAY0 = Date.UTC(2026, 10, 1);

const feed = (title: string, text: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
<item><title>${title}</title><link>https://example.test/${title.replace(/\W+/g, "-")}</link><guid>${title}</guid><description>${text}</description></item>
</channel></rss>`;

/** Ingests one feed item, completes extraction with payload text and an analysis summary, and scores it. */
function populatedItem(
  store: Store,
  title: string,
  summaryWord: string,
  now: number,
) {
  const source = store.addSource(`https://example.test/${title}.xml`, title);
  store.enqueueDue(now);
  const poll = store.claim(now)!;
  store.complete(
    poll,
    { items: parseFeed(feed(title, "baseline body"), source.url) },
    now,
  );
  const item = store.search(title)[0]!;
  store.enqueueProcessing("extract", item.id, now);
  const extract = store.claimProcessing("extract", now)!;
  store.completeProcessing(
    extract,
    "extracted",
    now,
    JSON.stringify({
      status: "extracted",
      text: `payload ${summaryWord} body`,
    }),
  );
  // Grouping reads extraction text, so the real pipeline settles it before purge.
  const group = store.claimProcessing("group", now)!;
  store.completeProcessing(group, "grouped", now);
  store.enqueueProcessing("analyse", item.id, now, extract.generation);
  const analyse = store.claimProcessing("analyse", now)!;
  store.completeAnalysis(
    analyse,
    {
      inputHash: `hash-${title}`,
      provider: "fake",
      model: "fake",
      promptVersion: "v1",
      profiles: [],
      analysis: { summary: `summary ${summaryWord}` },
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: 0,
    },
    now,
  );
  const score = store.claimProcessing("score", now)!;
  store.completeProcessing(score, "scored", now);
  return item.id;
}

describe("retention policy", () => {
  test("defaults retain everything and invalid windows fail closed", () => {
    expect(retentionPolicy({})).toEqual({
      extractedPayloadDays: undefined,
      analysisSummaryDays: undefined,
    });
    expect(() =>
      retentionPolicy({ RETENTION_EXTRACTED_PAYLOAD_DAYS: "0" }),
    ).toThrow();
    expect(() =>
      retentionPolicy({ RETENTION_ANALYSIS_SUMMARY_DAYS: "abc" }),
    ).toThrow();
    expect(() =>
      retentionPolicy({ RETENTION_ANALYSIS_SUMMARY_DAYS: "99999" }),
    ).toThrow();
    expect(
      retentionPolicy({
        RETENTION_EXTRACTED_PAYLOAD_DAYS: "30",
        RETENTION_ANALYSIS_SUMMARY_DAYS: "90",
      }),
    ).toEqual({ extractedPayloadDays: 30, analysisSummaryDays: 90 });
  });
});

describe("content retention", () => {
  test("default policy purges nothing even when everything is old", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      populatedItem(store, "Alpha", "alphaword", DAY0);
      const report = store.retention(retentionPolicy({}), {
        dryRun: false,
        now: DAY0 + 3650 * DAY_MS,
      });
      expect(report.eligible).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
        feed_text: 0,
      });
      expect(store.search("alphaword")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("clock-advanced expiry removes derived content while identity, history and FTS remain consistent", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      const before = {
        items: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM items")
          .get()!.n,
        versions: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM content_versions")
          .get()!.n,
        sources: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM item_sources")
          .get()!.n,
      };
      const policy = retentionPolicy({
        RETENTION_EXTRACTED_PAYLOAD_DAYS: "7",
        RETENTION_ANALYSIS_SUMMARY_DAYS: "7",
      });

      const early = store.retention(policy, {
        dryRun: true,
        now: DAY0 + 6 * DAY_MS,
      });
      expect(early.eligible).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
        feed_text: 0,
      });

      const dry = store.retention(policy, {
        dryRun: true,
        now: DAY0 + 8 * DAY_MS,
      });
      expect(dry.eligible).toEqual({
        extracted_payload: 1,
        analysis_summary: 1,
        feed_text: 0,
      });
      expect(dry.purged).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
        feed_text: 0,
      });
      expect(store.search("alphaword")).toHaveLength(1);

      const applied = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 8 * DAY_MS,
      });
      expect(applied.purged).toEqual({
        extracted_payload: 1,
        analysis_summary: 1,
        feed_text: 0,
      });

      const item = store.getItem(itemId)!;
      expect(item.extraction).toEqual({
        status: "purged",
        reason: "retention",
      });
      expect(item.summary).toBeNull();
      expect(item.analysis?.result).toEqual({ purged: true, summary: null });
      expect(item.retention.map((row) => row.class).sort()).toEqual([
        "analysis_summary",
        "extracted_payload",
      ]);
      expect(item.references.length).toBeGreaterThan(0);
      expect(item.content_versions.length).toBeGreaterThan(0);

      // Purged summary and payload text must not stay searchable.
      expect(store.search("alphaword")).toHaveLength(0);
      expect(store.search("baseline")).toHaveLength(1);

      const after = {
        items: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM items")
          .get()!.n,
        versions: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM content_versions")
          .get()!.n,
        sources: store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM item_sources")
          .get()!.n,
      };
      expect(after).toEqual(before);
    } finally {
      store.close();
    }
  });

  test("repeat cleanup is idempotent and does not change counts or FTS", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      populatedItem(store, "Alpha", "alphaword", DAY0);
      populatedItem(store, "Beta", "betaword", DAY0);
      const policy = retentionPolicy({
        RETENTION_EXTRACTED_PAYLOAD_DAYS: "1",
        RETENTION_ANALYSIS_SUMMARY_DAYS: "1",
      });
      const now = DAY0 + 5 * DAY_MS;
      const first = store.retention(policy, { dryRun: false, now });
      expect(first.purged).toEqual({
        extracted_payload: 2,
        analysis_summary: 2,
        feed_text: 0,
      });
      const second = store.retention(policy, {
        dryRun: false,
        now: now + DAY_MS,
      });
      expect(second.eligible).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
        feed_text: 0,
      });
      expect(second.purged).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
        feed_text: 0,
      });
      const audit = store.sqlite
        .query<{ n: number }, []>("SELECT count(*) n FROM retention_purges")
        .get()!.n;
      expect(audit).toBe(4);
      expect(verifyDatabase(join(dir, "db.sqlite")).ftsConsistent).toBe(true);
    } finally {
      store.close();
    }
  });

  test("unsettled items, pending stages and in-flight analysis reservations are never purged", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      // A newer extraction generation is pending, so the old one must not be purged.
      store.sqlite
        .query(
          "INSERT INTO processing_jobs(id,stage,item_id,generation,status,attempts,available_at,queued_at,created_at) VALUES('pending-ext',?,?,2,'pending',0,?,?,?)",
        )
        .run("extract", itemId, DAY0, DAY0, DAY0);
      const policy = retentionPolicy({
        RETENTION_EXTRACTED_PAYLOAD_DAYS: "1",
        RETENTION_ANALYSIS_SUMMARY_DAYS: "1",
      });
      const report = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 10 * DAY_MS,
      });
      expect(report.purged).toEqual({
        extracted_payload: 0,
        analysis_summary: 0,
        feed_text: 0,
      });
      expect(report.deferred).toBeGreaterThanOrEqual(1);
      expect(
        store.sqlite
          .query<{ result: string }, [string]>(
            "SELECT result FROM processing_jobs WHERE item_id=? AND stage='extract' AND generation=1",
          )
          .get(itemId)!.result,
      ).toContain("payload alphaword body");

      // Remove the pending work; now an in-flight analysis reservation blocks summary purges.
      store.sqlite
        .query("DELETE FROM processing_jobs WHERE id='pending-ext'")
        .run();
      store.sqlite
        .query(
          "INSERT INTO analysis_reservations(key,tokens,micros,status) VALUES('ambiguous',1,1,'reserved')",
        )
        .run();
      const blocked = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 10 * DAY_MS,
      });
      expect(blocked.analysisReservationsActive).toBe(true);
      expect(blocked.purged.analysis_summary).toBe(0);
      expect(blocked.purged.extracted_payload).toBe(1);

      store.sqlite
        .query("DELETE FROM analysis_reservations WHERE key='ambiguous'")
        .run();
      const resumed = store.retention(policy, {
        dryRun: false,
        now: DAY0 + 10 * DAY_MS,
      });
      expect(resumed.purged.analysis_summary).toBe(1);
    } finally {
      store.close();
    }
  });

  test("bounded passes keep the deferred diagnostic outside the write lock", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      store.sqlite
        .query(
          "INSERT INTO processing_jobs(id,stage,item_id,generation,status,attempts,available_at,queued_at,created_at) VALUES('pending-ext-2','extract',?,2,'pending',0,?,?,?)",
        )
        .run(itemId, DAY0, DAY0, DAY0);
      const report = store.retention(
        retentionPolicy({ RETENTION_EXTRACTED_PAYLOAD_DAYS: "1" }),
        { dryRun: false, limit: 1, now: DAY0 + 10 * DAY_MS },
      );
      expect(report.purged.extracted_payload).toBe(0);
      expect(report.deferred).toBeGreaterThanOrEqual(1);
      expect(report.complete).toBe(true);
    } finally {
      store.close();
    }
  });

  test("frozen digests, deliveries and feedback survive retention untouched", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      new DigestStore(store.sqlite).freeze(
        {
          date: "2026-11-01",
          timezone: "Europe/London",
          subject: "Discovery",
          html: "<p>alphaword</p>",
          text: "alphaword",
          decisionSnapshot: {},
          items: [
            {
              itemId,
              groupId: null,
              scoreId: null,
              snapshot: {
                title: "Alpha",
                citations: [{ url: "https://example.test/a" }],
              },
            },
          ],
        },
        DAY0,
      );
      store.sqlite
        .query(
          "INSERT INTO item_feedback(id,item_id,useful,source,created_at) VALUES('f1',?,1,'mcp',?)",
        )
        .run(itemId, DAY0);
      store.retention(
        retentionPolicy({
          RETENTION_EXTRACTED_PAYLOAD_DAYS: "1",
          RETENTION_ANALYSIS_SUMMARY_DAYS: "1",
        }),
        { dryRun: false, now: DAY0 + 10 * DAY_MS },
      );
      expect(
        store.sqlite
          .query<{ html: string }, []>("SELECT html FROM digests")
          .get()!.html,
      ).toBe("<p>alphaword</p>");
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM item_feedback")
          .get()!.n,
      ).toBe(1);
      expect(
        store.sqlite
          .query<{ n: number }, []>("SELECT count(*) n FROM digest_items")
          .get()!.n,
      ).toBe(1);
      expect(
        store.retention(
          retentionPolicy({ RETENTION_EXTRACTED_PAYLOAD_DAYS: "1" }),
          { dryRun: true, now: DAY0 + 10 * DAY_MS },
        ).eligible.extracted_payload,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("populated prior-version database migrates and retains canonical identity, references and search", () => {
    const dir = temp();
    const old = join(dir, "prior-migrations");
    const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
    mkdirSync(old, { recursive: true });
    for (const file of readdirSync(migrations)) {
      if (
        file.endsWith(".sql") &&
        !file.startsWith("0047_") &&
        !file.startsWith("0049_") &&
        !file.startsWith("0048_") &&
        !file.startsWith("0050_")
      )
        copyFileSync(join(migrations, file), join(old, file));
    }
    const journal = JSON.parse(
      readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
    );
    journal.entries = journal.entries.filter(
      (entry: { tag: string }) =>
        !entry.tag.startsWith("0047_") &&
        !entry.tag.startsWith("0048_") &&
        !entry.tag.startsWith("0049_") &&
        !entry.tag.startsWith("0050_"),
    );
    mkdirSync(join(old, "meta"), { recursive: true });
    writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
    for (const file of readdirSync(join(migrations, "meta"))) {
      if (
        file.endsWith("_snapshot.json") &&
        !file.startsWith("0047") &&
        !file.startsWith("0048") &&
        !file.startsWith("0049") &&
        !file.startsWith("0050")
      )
        copyFileSync(join(migrations, "meta", file), join(old, "meta", file));
    }
    const path = join(dir, "prior.sqlite");
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA foreign_keys=ON");
    migrate(drizzle(db), { migrationsFolder: old });
    db.query(
      "INSERT INTO sources(id,kind,url,title,enabled) VALUES('s1','rss','https://example.test/prior.xml','Prior',1)",
    ).run();
    db.query(
      "INSERT INTO items(id,identity,url,title,ingested_at,status) VALUES('canon-1','url:https://example.test/a','https://example.test/a','Legacy survived',1,'extracted')",
    ).run();
    db.query(
      "INSERT INTO item_sources(item_id,source_id,native_id,url) VALUES('canon-1','s1','native-a','https://example.test/a')",
    ).run();
    db.query(
      "INSERT INTO content(item_id,text) VALUES('canon-1','legacy payload')",
    ).run();
    db.query(
      "INSERT INTO processing_jobs(id,stage,item_id,generation,status,outcome,attempts,available_at,queued_at,created_at,result) VALUES('px','extract','canon-1',1,'done','extracted',0,1,1,1,?)",
    ).run(JSON.stringify({ status: "extracted", text: "legacy payload" }));
    db.close();

    const store = new Store(path);
    try {
      expect(store.getItem("canon-1")?.title).toBe("Legacy survived");
      expect(store.search("legacy")).toHaveLength(1);
      const report = store.retention(
        retentionPolicy({ RETENTION_EXTRACTED_PAYLOAD_DAYS: "1" }),
        { dryRun: false, now: 10 * DAY_MS },
      );
      expect(report.purged.extracted_payload).toBe(0);
      expect(store.getItem("canon-1")?.references).toHaveLength(1);
    } finally {
      store.close();
    }
    const verified = verifyDatabase(path);
    expect(verified.ok).toBe(true);
    expect(verified.migrations).toBe(
      JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"))
        .entries.length,
    );
  });
});

describe("recovery verification", () => {
  test("backup verifies, restore accepts it, and a corrupt backup is rejected", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      populatedItem(store, "Alpha", "alphaword", DAY0);
      const backup = join(dir, "backup.sqlite");
      store.backup(backup);
      const report = verifyDatabase(backup);
      expect(report.ok).toBe(true);
      expect(report.counts.items).toBe(1);
      expect(report.ftsConsistent).toBe(true);
    } finally {
      store.close();
    }
    const corrupt = join(dir, "corrupt.sqlite");
    writeFileSync(corrupt, "not a database");
    expect(verifyDatabase(corrupt).ok).toBe(false);
  });

  test("verification flags a missing search index row and foreign key violations", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    populatedItem(store, "Alpha", "alphaword", DAY0);
    store.close();
    const path = join(dir, "db.sqlite");
    const db = new Database(path, { strict: true });
    db.exec("PRAGMA foreign_keys=OFF");
    db.query("DELETE FROM items_fts").run();
    db.query(
      "INSERT INTO item_sources(item_id,source_id,native_id) VALUES('ghost','s-missing','x')",
    ).run();
    db.close();
    const report = verifyDatabase(path);
    expect(report.ok).toBe(false);
    expect(report.ftsConsistent).toBe(false);
    expect(report.foreignKeyViolations).toBeGreaterThan(0);
  });
});

describe("recovery CLI", () => {
  const cli = (args: string[], env: Record<string, string | undefined>) =>
    Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
      env: {
        ...process.env,
        MCP_TOKEN: "abcdefghijklmnopqrstuvwxyz123456",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

  test("restore rejects a corrupt backup without creating a live database", () => {
    const dir = temp();
    const corrupt = join(dir, "corrupt.sqlite");
    writeFileSync(corrupt, "definitely not sqlite");
    const target = join(dir, "restored.sqlite");
    const result = cli(["restore", corrupt], { DB_PATH: target });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  test("backup verifies its output and restore verifies the restored copy", () => {
    const dir = temp();
    const live = join(dir, "live.sqlite");
    const store = new Store(live);
    populatedItem(store, "Alpha", "alphaword", DAY0);
    store.close();
    const backup = join(dir, "backup.sqlite");
    const created = cli(["backup", backup], { DB_PATH: live });
    expect(created.exitCode).toBe(0);
    expect(created.stdout.toString()).toContain("verified");
    expect(verifyDatabase(backup).ok).toBe(true);

    const target = join(dir, "restored.sqlite");
    const restored = cli(["restore", backup], { DB_PATH: target });
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout.toString()).toContain("verified");
    const check = new Store(target);
    try {
      expect(check.search("alphaword")).toHaveLength(1);
    } finally {
      check.close();
    }
  });

  test("retention CLI previews without changing content by default", () => {
    const dir = temp();
    const live = join(dir, "live.sqlite");
    const store = new Store(live);
    populatedItem(store, "Alpha", "alphaword", DAY0);
    store.close();
    const preview = cli(["retention-preview"], {
      DB_PATH: live,
      RETENTION_EXTRACTED_PAYLOAD_DAYS: "1",
    });
    expect(preview.exitCode).toBe(0);
    const report = JSON.parse(preview.stdout.toString());
    expect(report.dryRun).toBe(true);
    const after = new Store(live);
    try {
      expect(after.search("alphaword")).toHaveLength(1);
    } finally {
      after.close();
    }
  });
});

test("restored upgraded database keeps identity: re-polling and reprocessing do not duplicate items", () => {
  const dir = temp();
  const live = join(dir, "live.sqlite");
  const feedXml = feed("Gamma", "gamma body");
  const store = new Store(live);
  const source = store.addSource("https://example.test/gamma.xml", "gamma");
  store.enqueueDue(DAY0);
  store.complete(
    store.claim(DAY0)!,
    { items: parseFeed(feedXml, source.url) },
    DAY0,
  );
  const itemId = store.search("Gamma")[0]!.id;
  store.close();

  const backup = join(dir, "backup.sqlite");
  const created = Bun.spawnSync(
    [process.execPath, "src/cli.ts", "backup", backup],
    {
      env: {
        ...process.env,
        DB_PATH: live,
        MCP_TOKEN: "abcdefghijklmnopqrstuvwxyz123456",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(created.exitCode).toBe(0);

  const restoredPath = join(dir, "restored.sqlite");
  const restored = Bun.spawnSync(
    [process.execPath, "src/cli.ts", "restore", backup],
    {
      env: {
        ...process.env,
        DB_PATH: restoredPath,
        MCP_TOKEN: "abcdefghijklmnopqrstuvwxyz123456",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(restored.exitCode).toBe(0);

  const reopened = new Store(restoredPath);
  try {
    expect(
      reopened.sqlite
        .query<{ n: number }, []>("PRAGMA foreign_key_check")
        .all(),
    ).toHaveLength(0);
    reopened.enqueueDue(DAY0 + 60_000, true);
    const poll = reopened.claim(DAY0 + 60_000)!;
    reopened.complete(
      poll,
      { items: parseFeed(feedXml, source.url) },
      DAY0 + 60_000,
    );
    expect(reopened.getItem(itemId)?.id).toBe(itemId);
    expect(
      reopened.sqlite
        .query<{ n: number }, []>("SELECT count(*) n FROM items")
        .get()!.n,
    ).toBe(1);
    expect(reopened.search("gamma")).toHaveLength(1);
  } finally {
    reopened.close();
  }
});

describe("retention review hardening", () => {
  const analysisSettings = {
    endpoint: "https://api.example.test/v1/chat/completions",
    model: "fake",
    apiKey: "secret-key",
    maxInputChars: 1000,
    maxOutputTokens: 200,
    timeoutMs: 1000,
  };
  const analysisReply = () =>
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              summary: "fresh regenerated summary",
              classification: "paper",
              claims: [],
              uncertainty: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  const summaryOnly = retentionPolicy({ RETENTION_ANALYSIS_SUMMARY_DAYS: "1" });

  test("pending or running grouping blocks payload purge until it settles", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      store.sqlite
        .query(
          "INSERT INTO processing_jobs(id,stage,item_id,generation,status,attempts,available_at,queued_at,created_at) VALUES('pending-group','group',?,2,'pending',0,?,?,?)",
        )
        .run(itemId, DAY0, DAY0, DAY0);
      const deferred = store.retention(
        retentionPolicy({ RETENTION_EXTRACTED_PAYLOAD_DAYS: "1" }),
        { dryRun: false, now: DAY0 + 10 * DAY_MS },
      );
      expect(deferred.purged.extracted_payload).toBe(0);
      expect(deferred.deferred).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
    }
  });

  test("a purged summary is unavailable to a real rescore instead of throwing", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      store.retention(summaryOnly, { dryRun: false, now: DAY0 + 10 * DAY_MS });
      // Simulate a profile/feedback-driven rescore of the same generation.
      store.sqlite
        .query(
          "UPDATE processing_jobs SET status='pending',attempts=0,available_at=?,queued_at=?,lease_token=NULL,lease_until=NULL WHERE item_id=? AND stage='score'",
        )
        .run(DAY0 + 11 * DAY_MS, DAY0 + 11 * DAY_MS, itemId);
      const job = store.claimProcessing("score", DAY0 + 11 * DAY_MS)!;
      const snapshot = store.scoringSnapshot(job, DAY0 + 11 * DAY_MS)!;
      expect(snapshot.input.analysis).toBeNull();
      expect(() => scoreItem(snapshot.input)).not.toThrow();
      expect(scoreItem(snapshot.input).uncertainty).toContain(
        "analysis_unavailable",
      );
    } finally {
      store.close();
    }
  });

  test("reanalysis after summary purge regenerates a summary instead of reusing the tombstone", async () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      // Drop the fixture's analysis so the real handler produces the summary,
      // whose input hash then matches what reanalysis computes.
      store.sqlite.query("DELETE FROM analyses").run();
      store.sqlite.query("DELETE FROM analysis_reservations").run();
      store.sqlite
        .query(
          "UPDATE processing_jobs SET status='pending',attempts=0,available_at=?,queued_at=?,lease_token=NULL,lease_until=NULL,result=NULL,outcome=NULL WHERE item_id=? AND stage='analyse'",
        )
        .run(DAY0, DAY0, itemId);
      let calls = 0;
      const client = new OpenAICompatibleAnalysis(
        analysisSettings,
        async () => {
          calls += 1;
          return analysisReply();
        },
      );
      const budget = new AnalysisBudget(store.sqlite, {
        maxTokens: 1000,
        maxMicros: 1000,
        maxConcurrent: 1,
      });
      const worker = new ProcessingWorker(store, {
        analyse: analysisHandler(store, client, budget, {
          provider: "fake",
          model: "fake",
          promptVersion: "v1",
          reserveTokens: 100,
          reserveMicros: 100,
        }),
      });
      expect(await worker.drain("analyse")).toBe(1);
      expect(calls).toBe(1);
      expect(store.getItem(itemId)?.summary).toBe("fresh regenerated summary");

      // The handler stamps wall-clock time, so the retention clock is advanced from it.
      // The new analysis invalidated the score; settle it as the pipeline would.
      const score = store.claimProcessing("score")!;
      store.completeProcessing(score, "scored", Date.now());
      const later = Date.now() + 10 * DAY_MS;
      const purged = store.retention(summaryOnly, {
        dryRun: false,
        now: later,
      });
      expect(purged.purged.analysis_summary).toBe(1);
      expect(store.getItem(itemId)?.summary).toBeNull();
      expect(store.requestReanalysis(itemId)).toBe(true);
      expect(await worker.drain("analyse")).toBe(1);
      expect(calls).toBe(2);
      expect(store.getItem(itemId)?.summary).toBe("fresh regenerated summary");
    } finally {
      store.close();
    }
  });

  test("no summary payload remains in analyse results or settled reservations after purge", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const itemId = populatedItem(store, "Alpha", "alphaword", DAY0);
      store.sqlite
        .query(
          "INSERT INTO analysis_reservations(key,tokens,micros,status,result) VALUES('k-alpha',1,1,'settled',?)",
        )
        .run(
          JSON.stringify({
            inputHash: "hash-Alpha",
            provider: "fake",
            model: "fake",
            promptVersion: "v1",
            analysis: { summary: "summary alphaword" },
          }),
        );
      store.sqlite
        .query(
          "UPDATE processing_jobs SET result=? WHERE item_id=? AND stage='analyse'",
        )
        .run(
          JSON.stringify({
            inputHash: "hash-Alpha",
            analysis: { summary: "summary alphaword" },
          }),
          itemId,
        );
      store.retention(summaryOnly, { dryRun: false, now: DAY0 + 10 * DAY_MS });
      const dump = JSON.stringify([
        store.sqlite
          .query("SELECT result FROM processing_jobs WHERE item_id=?")
          .all(itemId),
        store.sqlite.query("SELECT result FROM analysis_reservations").all(),
        store.sqlite.query("SELECT result FROM analyses").all(),
      ]);
      expect(dump).not.toContain("summary alphaword");
      expect(dump).not.toContain("inputHash");
      expect(
        store.sqlite
          .query<{ status: string; tokens: number }, []>(
            "SELECT status,tokens FROM analysis_reservations",
          )
          .get(),
      ).toEqual({ status: "settled", tokens: 1 });
    } finally {
      store.close();
    }
  });

  test("merging items moves purge audits to the surviving item", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    try {
      const loserId = populatedItem(store, "Alpha", "alphaword", DAY0);
      const winnerId = populatedItem(store, "Beta", "betaword", DAY0);
      store.retention(summaryOnly, { dryRun: false, now: DAY0 + 10 * DAY_MS });
      const loserAudits = store.getItem(loserId)!.retention.length;
      const winnerAudits = store.getItem(winnerId)!.retention.length;
      expect(loserAudits).toBeGreaterThan(0);
      (
        store as unknown as { mergeItems(w: string, l: string): void }
      ).mergeItems(winnerId, loserId);
      const merged = store.getItem(winnerId)!;
      expect(merged.retention.map((row) => row.class)).toContain(
        "analysis_summary",
      );
      expect(merged.retention.length).toBe(loserAudits + winnerAudits);
      expect(
        store.sqlite
          .query<{ n: number }, [string]>(
            "SELECT count(*) n FROM retention_purges WHERE item_id=?",
          )
          .get(loserId)!.n,
      ).toBe(0);
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM (SELECT item_id,generation,class FROM retention_purges GROUP BY 1,2,3 HAVING count(*)>1)",
          )
          .get()!.n,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("verification accepts an unmigrated prior-version (0046) backup without modifying it", () => {
    const dir = temp();
    const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const old = join(dir, "prior-migrations");
    mkdirSync(join(old, "meta"), { recursive: true });
    for (const file of readdirSync(migrations)) {
      if (
        file.endsWith(".sql") &&
        !file.startsWith("0047_") &&
        !file.startsWith("0049_") &&
        !file.startsWith("0048_") &&
        !file.startsWith("0050_")
      )
        copyFileSync(join(migrations, file), join(old, file));
    }
    const journal = JSON.parse(
      readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
    );
    journal.entries = journal.entries.filter(
      (entry: { tag: string }) =>
        !entry.tag.startsWith("0047_") &&
        !entry.tag.startsWith("0048_") &&
        !entry.tag.startsWith("0049_") &&
        !entry.tag.startsWith("0050_"),
    );
    writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
    for (const file of readdirSync(join(migrations, "meta"))) {
      if (
        file.endsWith("_snapshot.json") &&
        !file.startsWith("0047") &&
        !file.startsWith("0048") &&
        !file.startsWith("0049") &&
        !file.startsWith("0050")
      )
        copyFileSync(join(migrations, "meta", file), join(old, "meta", file));
    }
    const path = join(dir, "prior.sqlite");
    const db = new Database(path, { create: true, strict: true });
    migrate(drizzle(db), { migrationsFolder: old });
    db.close();
    const before = readFileSync(path);
    const report = verifyDatabase(path);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.migrations).toBe(journal.entries.length);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("verification rejects an empty migration journal", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    populatedItem(store, "Alpha", "alphaword", DAY0);
    store.close();
    const path = join(dir, "db.sqlite");
    const db = new Database(path, { strict: true });
    db.query("DELETE FROM __drizzle_migrations").run();
    db.close();
    const report = verifyDatabase(path);
    expect(report.ok).toBe(false);
    expect(report.migrations).toBe(0);
    expect(report.problems.join(" ")).toContain("migration journal is empty");
  });

  test("verification accepts a populated, purged database with consistent search rows", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    populatedItem(store, "Alpha", "alphaword", DAY0);
    store.retention(
      retentionPolicy({
        RETENTION_EXTRACTED_PAYLOAD_DAYS: "1",
        RETENTION_ANALYSIS_SUMMARY_DAYS: "1",
      }),
      { dryRun: false, now: DAY0 + 10 * DAY_MS },
    );
    store.close();
    const report = verifyDatabase(join(dir, "db.sqlite"));
    expect(report.problems).toEqual([]);
    expect(report.ftsConsistent).toBe(true);
  });

  test("verification rejects stale indexed text balanced by nothing", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    populatedItem(store, "Alpha", "alphaword", DAY0);
    store.close();
    const path = join(dir, "db.sqlite");
    const db = new Database(path, { strict: true });
    db.query("UPDATE items_fts SET text='stale words only'").run();
    db.close();
    const report = verifyDatabase(path);
    expect(report.ftsConsistent).toBe(false);
    expect(report.problems.join(" ")).toContain("stale");
  });

  test("verification rejects a missing item row balanced by an orphan search row", () => {
    const dir = temp();
    const store = new Store(join(dir, "db.sqlite"));
    populatedItem(store, "Alpha", "alphaword", DAY0);
    store.close();
    const path = join(dir, "db.sqlite");
    const db = new Database(path, { strict: true });
    db.query("UPDATE items_fts SET rowid=9999").run();
    db.close();
    const report = verifyDatabase(path);
    expect(report.ftsConsistent).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toContain("missing from search index");
    expect(report.problems.join(" ")).toContain("orphaned search index");
  });
});
