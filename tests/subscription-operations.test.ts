import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { RssAdapter } from "../src/adapters/rss";
import { healthReport } from "../src/health";

async function cli(db: string, ...args: string[]) {
  const p = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    env: { ...process.env, DB_PATH: db },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const error = await new Response(p.stderr).text();
  expect(await p.exited).toBe(0);
  if (error) throw new Error(error);
  return out;
}

test("CLI round-trip: interval, disable during pending work, re-enable, nested OPML and removal keep history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-ops-"));
  const db = join(dir, "db.sqlite");
  try {
    const opml = join(dir, "nested.opml");
    writeFileSync(
      opml,
      `<opml version="2.0"><body><outline text="Tech"><outline text="Deep"><outline text="Feed" xmlUrl="https://example.test/feed" /></outline></outline><outline text="Top" xmlUrl="https://example.test/top" /></body></opml>`,
    );
    const first = await cli(db, "import-opml", opml);
    expect(first.trim()).toBe(
      "Imported 2 feeds: 2 added, 0 already subscribed",
    );
    const again = await cli(db, "import-opml", opml);
    expect(again.trim()).toBe(
      "Imported 2 feeds: 0 added, 2 already subscribed",
    );
    const sources = JSON.parse(await cli(db, "list-sources")) as {
      id: string;
      url: string;
      poll_seconds: number;
      enabled: number;
    }[];
    expect(sources).toHaveLength(2);
    const feed = sources.find((s) => s.url === "https://example.test/feed")!;

    await cli(db, "update-source", feed.id, "poll-seconds=300");
    await cli(db, "disable-source", feed.id);
    expect(
      (JSON.parse(await cli(db, "list-sources")) as typeof sources).find(
        (s) => s.id === feed.id,
      )!.enabled,
    ).toBe(0);
    await cli(db, "enable-source", feed.id);
    await cli(db, "update-source", feed.id, "enabled=false");
    const disabled = (
      JSON.parse(await cli(db, "list-sources")) as typeof sources
    ).find((s) => s.id === feed.id)!;
    expect(disabled.enabled).toBe(0);
    await cli(db, "update-source", feed.id, "enabled=true");
    const reenabled = (
      JSON.parse(await cli(db, "list-sources")) as typeof sources
    ).find((s) => s.id === feed.id)!;
    expect(reenabled.enabled).toBe(1);
    expect(reenabled.poll_seconds).toBe(300);

    const exported = await cli(db, "export-opml");
    expect(exported).toContain("https://example.test/feed");
    expect(exported).toContain("https://example.test/top");

    await cli(db, "remove-source", feed.id);
    expect(
      (JSON.parse(await cli(db, "list-sources")) as typeof sources).map(
        (s) => s.id,
      ),
    ).not.toContain(feed.id);
    const removedRow = new Store(db);
    try {
      expect(
        removedRow.sqlite
          .query("SELECT removed FROM sources WHERE id=?")
          .get(feed.id),
      ).toEqual({ removed: 1 });
    } finally {
      removedRow.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("removal cancels pending polls, reports the count and keeps item provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-remove-"));
  const db = join(dir, "db.sqlite");
  try {
    const store = new Store(db);
    const source = store.addSource("https://example.test/feed", "Feed");
    store.enqueueDue(1, true);
    store.complete(
      store.claim(1)!,
      {
        items: [
          {
            nativeId: "a",
            url: "https://example.test/a",
            title: "Retained article",
            text: "persistent history body",
          },
        ],
      },
      2,
    );
    const itemId = store.search("persistent")[0]!.id;
    store.enqueueDue(3, true);
    store.close();

    const out = await cli(db, "remove-source", source.id);
    expect(out.trim()).toBe(
      "Source removed; history retained; 1 queued or running poll cancelled",
    );

    const after = new Store(db);
    try {
      expect(after.sources()).toHaveLength(0);
      expect(after.getItem(itemId)?.references).toHaveLength(1);
      expect(after.search("persistent")).toHaveLength(1);
      expect(
        after.sqlite
          .query("SELECT count(*) AS n FROM jobs WHERE status='pending'")
          .get(),
      ).toEqual({ n: 0 });
      expect(after.sqlite.query("PRAGMA foreign_key_check").all()).toHaveLength(
        0,
      );
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("entry-budget truncation is reported as a health diagnostic until a complete poll clears it", () => {
  const s = new Store(":memory:");
  const source = s.addSource("https://example.test/feed");
  s.updateSource(source.id, { maxEntries: 1 });
  s.enqueueDue(1);
  s.complete(s.claim(1)!, { items: [], entryCount: 3, truncated: true }, 2);
  let report = healthReport(s.sqlite, 3);
  expect(report.truncated_sources).toEqual([
    {
      source_id: source.id,
      title: "https://example.test/feed",
      entry_count: 3,
      max_entries: 1,
    },
  ]);
  expect(report.warnings).toContain("truncated_sources");
  expect(report.ready).toBe(false);

  s.updateSource(source.id, { enabled: false });
  report = healthReport(s.sqlite, 3);
  expect(report.truncated_sources).toEqual([]);
  s.close();
});

test("a feed above the entry budget is truncated and only the budgeted entries are ingested", async () => {
  const xml =
    `<rss><channel>` +
    [1, 2, 3, 4]
      .map(
        (i) =>
          `<item><guid>g${i}</guid><title>Budget entry ${i}</title><link>https://example.test/${i}</link></item>`,
      )
      .join("") +
    `</channel></rss>`;
  const s = new Store(":memory:");
  const source = s.addSource("https://example.test/feed");
  s.updateSource(source.id, { maxEntries: 2 });
  const adapter = new RssAdapter(async () => new Response(xml));
  s.enqueueDue(1);
  const result = await adapter.poll(source.url, s.state(source.id), {
    maxEntries: 2,
    maxBytes: 5_000_000,
  });
  expect(result.truncated).toBe(true);
  expect(result.entryCount).toBe(4);
  s.complete(s.claim(1)!, result, 2);
  expect(s.search("Budget")).toHaveLength(2);
  expect(healthReport(s.sqlite, 3).truncated_sources).toHaveLength(1);
  s.close();
});

test("changed native-ID content is searchable, keeps history and re-polling identical content is idempotent", () => {
  const s = new Store(":memory:");
  s.addSource("https://example.test/feed");
  const ingest = (text: string, now: number) => {
    s.enqueueDue(now, true);
    s.complete(
      s.claim(now)!,
      {
        items: [
          {
            nativeId: "story-1",
            url: "https://example.test/story",
            title: "Story",
            text,
          },
        ],
      },
      now + 1,
    );
  };
  ingest("originalterm body", 1);
  ingest("correctedterm body", 3);
  const item = s.search("correctedterm")[0]!;
  expect(item).toBeDefined();
  expect(s.search("originalterm")).toHaveLength(0);
  const versions = s.getItem(item.id)!.content_versions;
  expect(versions.map((v) => v.text)).toEqual([
    "originalterm body",
    "correctedterm body",
  ]);
  const generationsBefore = s
    .getItem(item.id)!
    .processing.filter((j) => j.stage === "extract").length;
  ingest("correctedterm body", 5);
  ingest("correctedterm body", 7);
  expect(s.getItem(item.id)!.content_versions).toHaveLength(2);
  expect(
    s.getItem(item.id)!.processing.filter((j) => j.stage === "extract"),
  ).toHaveLength(generationsBefore);
  expect(s.search("correctedterm")).toHaveLength(1);
  s.close();
});

test("namespaced Atom XHTML with xml:base and legacy encoding keeps native IDs and resolved citations", async () => {
  const xml = `<?xml version="1.0" encoding="ISO-8859-1"?><a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="https://example.test/blog/"><a:entry><a:id>tag:example.test,2026:caf</a:id><a:title>Caf\xe9 &amp; robotics</a:title><a:link rel="alternate" href="story?utm_source=feed#top"/><a:content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">R\xe9sum\xe9 <a href="../news/1">read</a></div></a:content><a:updated>2026-11-08T09:00:00Z</a:updated></a:entry></a:feed>`;
  const bytes = Buffer.from(xml, "latin1");
  const result = await new RssAdapter(
    async () =>
      new Response(bytes, {
        headers: { "content-type": "application/atom+xml" },
      }),
  ).poll("https://example.test/feed", {});
  const [entry] = result.items;
  expect(entry!.nativeId).toBe("tag:example.test,2026:caf");
  expect(entry!.title).toBe("Café & robotics");
  expect(entry!.text).toContain("Résumé");
  expect(entry!.sourceUrl).toBe(
    "https://example.test/blog/story?utm_source=feed#top",
  );
});
