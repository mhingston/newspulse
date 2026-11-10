import { test, expect } from "bun:test";
import { Store } from "../src/db/store";
import { RssAdapter } from "../src/adapters/rss";

test("source update, disable, enable and removal fence pending and in-flight work while retaining citations", () => {
  const s = new Store(":memory:");
  const source = s.addSource("https://example.test/feed");
  s.updateSource(source.id, { title: "Updated", pollSeconds: 120 });
  expect(s.source(source.id)?.title).toBe("Updated");
  expect(s.source(source.id)?.poll_seconds).toBe(120);
  s.enqueueDue(1);
  const job = s.claim(1)!;
  s.updateSource(source.id, { enabled: false });
  expect(
    s.complete(
      job,
      { items: [{ nativeId: "a", title: "discard", text: "no" }] },
      2,
    ),
  ).toBe(false);
  expect(s.claim(2)).toBeNull();
  s.updateSource(source.id, { enabled: true });
  s.enqueueDue(3, true);
  const next = s.claim(3)!;
  s.complete(next, { items: [{ nativeId: "a", title: "A", text: "body" }] }, 4);
  const item = s.search("body")[0]!;
  s.removeSource(source.id);
  expect(s.sources()).toHaveLength(0);
  expect(s.getItem(item.id)?.references).toHaveLength(1);
  expect(s.enqueueDue(5, true)).toBe(0);
  s.close();
});

test("publisher corrections preserve versions and requeue only on actual change", () => {
  const s = new Store(":memory:");
  const source = s.addSource("https://example.test/feed");
  function ingest(text: string, now: number) {
    s.enqueueDue(now, true);
    const job = s.claim(now)!;
    s.complete(
      job,
      {
        items: [
          { nativeId: "a", url: "https://example.test/a", title: "A", text },
        ],
      },
      now + 1,
    );
  }
  ingest("original", 1);
  ingest("corrected", 3);
  const item = s.search("corrected")[0]!;
  expect(s.search("original")).toHaveLength(0);
  expect(s.getItem(item.id)?.content_versions).toHaveLength(2);
  expect(
    s.getItem(item.id)?.processing.filter((x) => x.stage === "extract"),
  ).toHaveLength(2);
  ingest("corrected", 5);
  expect(s.getItem(item.id)?.content_versions).toHaveLength(2);
  s.close();
});

test("feed budgets report truncation and reject oversized streams", async () => {
  const body =
    "<rss><channel>" +
    [1, 2, 3]
      .map((i) => `<item><guid>${i}</guid><title>Entry ${i}</title></item>`)
      .join("") +
    "</channel></rss>";
  const adapter = new RssAdapter(async () => new Response(body), {
    maxEntries: 2,
    maxBytes: 10000,
  });
  const r = await adapter.poll("https://example.test/feed", {});
  expect(r.items).toHaveLength(2);
  expect(r.truncated).toBe(true);
  expect(r.entryCount).toBe(3);
  const small = new RssAdapter(async () => new Response(body), {
    maxEntries: 2,
    maxBytes: 20,
  });
  await expect(small.poll("https://example.test/feed", {})).rejects.toThrow(
    "budget",
  );
});

test("feed truncation diagnostics persist across 304 and source reimport does not enable a disabled source", async () => {
  const s = new Store(":memory:");
  const source = s.addSource("https://example.test/feed");
  s.enqueueDue(1);
  s.complete(s.claim(1)!, { items: [], entryCount: 3, truncated: true }, 2);
  s.enqueueDue(3, true);
  s.complete(s.claim(3)!, { items: [], notModified: true }, 4);
  const health = s.status().sources[0]!.feed_diagnostics as {
    entry_count: number;
    truncated: number;
  };
  expect(health).toEqual({ entry_count: 3, truncated: 1 });
  s.updateSource(source.id, { enabled: false });
  s.addSource(source.url);
  expect(s.source(source.id)?.enabled).toBe(0);
  s.close();
});

test("CLI manages subscriptions and nested OPML round trips", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "newspulse-sources-"));
  const db = join(dir, "db.sqlite");
  const run = async (...args: string[]) => {
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
  };
  try {
    const opml = join(dir, "input.opml");
    writeFileSync(
      opml,
      `<opml version="2.0"><body><outline text="group"><outline text="Feed" xmlUrl="https://example.test/feed" /></outline></body></opml>`,
    );
    await run("import-opml", opml);
    const sources = JSON.parse(await run("list-sources")) as {
      id: string;
      poll_seconds: number;
      enabled: number;
    }[];
    const id = sources[0]!.id;
    await run(
      "update-source",
      id,
      "title=Changed",
      "poll-seconds=120",
      "max-entries=5",
    );
    await run("disable-source", id);
    expect(
      (JSON.parse(await run("list-sources")) as typeof sources)[0]!.enabled,
    ).toBe(0);
    await run("enable-source", id);
    const after = JSON.parse(await run("list-sources")) as typeof sources;
    expect(after[0]!.poll_seconds).toBe(120);
    expect(after[0]!.enabled).toBe(1);
    expect(await run("export-opml")).toContain("https://example.test/feed");
    await run("remove-source", id);
    expect(JSON.parse(await run("list-sources"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("disable cancels pending poll, reenabling does not revive a cancelled retry", () => {
  const s = new Store(":memory:");
  const source = s.addSource("https://example.test/feed");
  s.enqueueDue(1);
  s.updateSource(source.id, { enabled: false });
  expect(s.claim(2)).toBeNull();
  s.updateSource(source.id, { enabled: true });
  expect(s.claim(3)).toBeNull();
  expect(s.enqueueDue(3, true)).toBe(1);
  expect(s.claim(3)?.source_id).toBe(source.id);
  s.close();
});

test("a correction fences older extraction and carries source history", () => {
  const s = new Store(":memory:");
  const source = s.addSource("https://example.test/feed");
  const ingest = (text: string, now: number) => {
    s.enqueueDue(now, true);
    expect(
      s.complete(
        s.claim(now)!,
        { items: [{ nativeId: "a", title: "A", text }] },
        now + 1,
      ),
    ).toBe(true);
  };
  ingest("original", 1);
  const item = s.search("original")[0]!;
  const stale = s.claimProcessing("extract", 3)!;
  ingest("corrected", 4);
  expect(
    s.completeProcessing(
      stale,
      "extracted",
      6,
      JSON.stringify({ text: "old extraction" }),
    ),
  ).toBe(true);
  expect(s.getItem(item.id)?.status).toBe("ingested");
  expect(s.search("old extraction")).toHaveLength(0);
  expect(s.getItem(item.id)?.content_versions.map((v) => v.text)).toEqual([
    "original",
    "corrected",
  ]);
  s.close();
});

test("RSS 1.0 RDF retains native identity and resolved citation", async () => {
  const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel rdf:about="https://example.test/"><title>Feed</title><link>https://example.test/</link><description>Feed</description></channel><item rdf:about="https://example.test/native-id"><title>RDF entry</title><link>https://example.test/a?utm_source=feed#original</link><description>Body &amp; more</description></item></rdf:RDF>`;
  const result = await new RssAdapter(async () => new Response(xml)).poll(
    "https://example.test/feed",
    {},
  );
  expect(result.items[0]?.nativeId).toBe("https://example.test/native-id");
  expect(result.items[0]?.sourceUrl).toBe(
    "https://example.test/a?utm_source=feed#original",
  );
  expect(result.items[0]?.text).toBe("Body & more");
});

test("RDF preserves non-HTTP native identifiers across article link corrections", async () => {
  const xml = (link: string) =>
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><item rdf:about="urn:uuid:example-article"><title>Article</title><link>${link}</link><description>Body</description></item></rdf:RDF>`;
  const original = await new RssAdapter(
    async () => new Response(xml("https://example.test/old")),
  ).poll("https://example.test/feed", {});
  const corrected = await new RssAdapter(
    async () => new Response(xml("https://example.test/new")),
  ).poll("https://example.test/feed", {});
  expect(original.items[0]?.nativeId).toBe("urn:uuid:example-article");
  expect(corrected.items[0]?.nativeId).toBe(original.items[0]?.nativeId);
  expect(corrected.items[0]?.sourceUrl).toBe("https://example.test/new");

  const store = new Store(":memory:");
  store.addSource("https://example.test/feed");
  for (const [i, result] of [original, corrected].entries()) {
    const now = i * 2 + 1;
    store.enqueueDue(now, true);
    expect(store.complete(store.claim(now)!, result, now + 1)).toBe(true);
  }
  const rows = store.search("Article");
  expect(rows).toHaveLength(1);
  expect(store.getItem(rows[0]!.id)?.content_versions).toHaveLength(2);
  store.close();
});

test("raising truncated feed entry budget clears validators so omitted entries can be recovered", () => {
  const s = new Store(":memory:");
  const source = s.addSource("https://example.test/feed");
  s.updateSource(source.id, { maxEntries: 1 });
  s.enqueueDue(1);
  s.complete(
    s.claim(1)!,
    {
      items: [],
      entryCount: 2,
      truncated: true,
      etag: "v1",
      lastModified: "yesterday",
    },
    2,
  );
  expect(s.state(source.id).etag).toBe("v1");
  s.updateSource(source.id, { maxEntries: 2 });
  expect(s.state(source.id).etag).toBeUndefined();
  expect(s.state(source.id).lastModified).toBeUndefined();
  s.close();
});

test("title-only corrections update title search without erasing body and create one new generation", () => {
  const s = new Store(":memory:");
  s.addSource("https://example.test/feed");
  const ingest = (title: string, text: string, now: number) => {
    s.enqueueDue(now, true);
    s.complete(
      s.claim(now)!,
      { items: [{ nativeId: "a", title, text }] },
      now + 1,
    );
  };
  ingest("Oldtitle", "preserved body", 1);
  ingest("Newtitle", "", 3);
  const item = s.search("Newtitle")[0]!;
  expect(item).toBeDefined();
  expect(s.search("Oldtitle")).toHaveLength(0);
  expect(s.getItem(item.id)?.text).toBe("preserved body");
  expect(s.getItem(item.id)?.content_versions).toHaveLength(2);
  expect(
    s.getItem(item.id)?.processing.filter((j) => j.stage === "extract"),
  ).toHaveLength(2);
  ingest("Newtitle", "", 5);
  expect(s.getItem(item.id)?.content_versions).toHaveLength(2);
  s.close();
});

test("changed citation preserves original and latest source URL without changing canonical identity", () => {
  const s = new Store(":memory:");
  s.addSource("https://example.test/feed");
  const ingest = (sourceUrl: string, now: number) => {
    s.enqueueDue(now, true);
    s.complete(
      s.claim(now)!,
      {
        items: [
          {
            nativeId: "a",
            url: "https://example.test/a",
            sourceUrl,
            title: "Article",
            text: "body",
          },
        ],
      },
      now + 1,
    );
  };
  ingest("https://example.test/a?utm_source=one", 1);
  ingest("https://example.test/a?utm_source=two", 3);
  const item = s.search("Article")[0]!;
  const versions = s.getItem(item.id)!.content_versions;
  expect(versions.map((v) => v.url)).toEqual([
    "https://example.test/a?utm_source=one",
    "https://example.test/a?utm_source=two",
  ]);
  const refs = s.getItem(item.id)!.references as { url: string }[];
  expect(refs[0]!.url).toBe("https://example.test/a?utm_source=two");
  expect(item.url).toBe("https://example.test/a");
  s.close();
});

test("shortening source interval reschedules its next poll", () => {
  const s = new Store(":memory:");
  const source = s.addSource("https://example.test/feed", "Feed", 31536000);
  const now = Date.now();
  s.enqueueDue(now);
  s.complete(s.claim(now)!, { items: [] }, now + 1);
  s.updateSource(source.id, { pollSeconds: 60 });
  expect(s.source(source.id)!.next_poll).toBeLessThanOrEqual(
    Date.now() + 61_000,
  );
  s.close();
});

test("changing feed budgets fences an old in-flight response", () => {
  const s = new Store(":memory:");
  const source = s.addSource("https://example.test/feed");
  s.enqueueDue(1);
  const old = s.claim(1)!;
  s.updateSource(source.id, { maxEntries: 2000 });
  expect(
    s.complete(
      old,
      {
        items: [{ nativeId: "stale", title: "stale", text: "stale" }],
        etag: "old",
        entryCount: 1001,
        truncated: true,
      },
      2,
    ),
  ).toBe(false);
  expect(s.search("stale")).toHaveLength(0);
  expect(s.state(source.id).etag).toBeUndefined();
  s.enqueueDue(3);
  expect(s.claim(3)?.source_id).toBe(source.id);
  s.close();
});

test("restoring an unchanged body after title-only observation does not trigger reprocessing", () => {
  const s = new Store(":memory:");
  s.addSource("https://example.test/feed");
  const ingest = (title: string, text: string, n: number) => {
    s.enqueueDue(n, true);
    s.complete(s.claim(n)!, { items: [{ nativeId: "a", title, text }] }, n + 1);
  };
  ingest("Old", "body", 1);
  ingest("New", "", 3);
  ingest("New", "body", 5);
  const item = s.search("body")[0]!;
  expect(
    s.getItem(item.id)!.processing.filter((j) => j.stage === "extract"),
  ).toHaveLength(2);
  s.close();
});

test("repeat digest observations fan out new children idempotently with parent attribution", () => {
  const s = new Store(":memory:");
  s.addSource("https://example.test/feed");
  const ingest = (
    children: { url: string; sourceUrl: string; title: string }[],
    n: number,
  ) => {
    s.enqueueDue(n, true);
    s.complete(
      s.claim(n)!,
      {
        items: [
          { nativeId: "digest", title: "Digest", text: "newsletter", children },
        ],
      },
      n + 1,
    );
  };
  const a = {
    url: "https://a.test/story",
    sourceUrl: "https://a.test/story?utm_source=mail",
    title: "Alpha child",
  };
  const b = {
    url: "https://b.test/story",
    sourceUrl: "https://b.test/story?utm_source=mail",
    title: "Bravo child",
  };
  ingest([a], 1);
  ingest([a, b], 3);
  ingest([a, b], 5);
  const parent = s.search("Digest")[0]!;
  const child = s.search("Bravo")[0]!;
  expect(child).toBeDefined();
  const refs = s.getItem(child.id)!.references as {
    parent_item_id: string;
    url: string;
  }[];
  expect(refs).toHaveLength(1);
  expect(refs[0]!.parent_item_id).toBe(parent.id);
  expect(refs[0]!.url).toBe(b.sourceUrl);
  expect(s.search("Alpha")).toHaveLength(1);
  s.close();
});

test("concurrent source updates cannot silently overwrite one another", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "newspulse-concurrent-"));
  const path = join(dir, "db.sqlite");
  const first = new Store(path);
  const source = first.addSource("https://example.test/feed");
  const second = new Store(path);
  try {
    second.sqlite.exec("PRAGMA busy_timeout=0");
    let blocked = false;
    const original = first.source.bind(first);
    let once = true;
    first.source = (id: string) => {
      const snapshot = original(id);
      if (once) {
        once = false;
        try {
          second.updateSource(id, { pollSeconds: 120 });
        } catch (e) {
          if (!String(e).includes("locked")) throw e;
          blocked = true;
        }
      }
      return snapshot;
    };
    first.updateSource(source.id, { title: "Changed" });
    if (blocked) second.updateSource(source.id, { pollSeconds: 120 });
    expect(first.source(source.id)?.title).toBe("Changed");
    expect(first.source(source.id)?.poll_seconds).toBe(120);
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a URL-less native item that gains a URL is fetched without changing its identity", async () => {
  const { extractionHandler } = await import("../src/adapters/extraction");
  const s = new Store(":memory:");
  s.addSource("https://example.test/feed");
  const ingest = (url: string | undefined, n: number) => {
    s.enqueueDue(n, true);
    s.complete(
      s.claim(n)!,
      {
        items: [
          { nativeId: "a", title: "Item", text: "body", url, sourceUrl: url },
        ],
      },
      n + 1,
    );
  };
  ingest(undefined, 1);
  const item = s.search("body")[0]!;
  const identity = item.identity;
  ingest("https://example.test/article", 3);
  const jobs = s
    .getItem(item.id)!
    .processing.filter((j) => j.stage === "extract");
  expect(jobs).toHaveLength(2);
  let target = "";
  const extractor = {
    extract: async (url: string) => {
      target = url;
      return { status: "extracted" as const, text: "page", method: "http" };
    },
  };
  const old = s.claimProcessing("extract", 5)!;
  s.completeProcessing(old, "unavailable", 6);
  const current = s.claimProcessing("extract", 7)!;
  await extractionHandler(s, extractor)(current, new AbortController().signal);
  expect(target).toBe("https://example.test/article");
  expect(s.getItem(item.id)?.identity).toBe(identity);
  expect(s.getItem(item.id)?.url).toBe("https://example.test/article");
  s.close();
});

test("correction extraction uses the source that supplied that generation", async () => {
  const { extractionHandler } = await import("../src/adapters/extraction");
  const s = new Store(":memory:");
  const a = s.addSource("https://a.test/feed");
  const b = s.addSource("https://b.test/feed");
  function ingest(
    sourceId: string,
    text: string,
    reference: string,
    n: number,
  ) {
    s.enqueueDue(n, true);
    let job = s.claim(n)!;
    if (job.source_id !== sourceId) {
      s.complete(job, { items: [] }, n + 1);
      job = s.claim(n + 2)!;
    }
    expect(job.source_id).toBe(sourceId);
    s.complete(
      job,
      {
        items: [
          {
            nativeId: "same",
            url: "https://article.test/canonical",
            sourceUrl: reference,
            title: "Article",
            text,
          },
        ],
      },
      n + 3,
    );
  }
  ingest(a.id, "first", "https://a.test/original", 1);
  ingest(b.id, "same", "https://b.test/original", 10);
  ingest(b.id, "corrected", "https://b.test/correction", 20);
  const first = s.claimProcessing("extract", 30)!;
  s.completeProcessing(first, "unavailable", 31);
  const next = s.claimProcessing("extract", 32)!;
  let target = "";
  const extractor = {
    extract: async (url: string) => {
      target = url;
      return { status: "extracted" as const, text: "page", method: "http" };
    },
  };
  await extractionHandler(s, extractor)(next, new AbortController().signal);
  expect(target).toBe("https://b.test/correction");
  const item = s.search("corrected")[0]!;
  expect(item.url).toBe("https://article.test/canonical");
  expect(s.getItem(item.id)!.references).toHaveLength(2);
  s.close();
});

test("cross-feed URL alias deduplicates a URL-less native item after link correction", () => {
  const store = new Store(":memory:");
  const a = store.addSource("https://a.test/rss");
  const b = store.addSource("https://b.test/rss");
  const ingest = (
    source: string,
    candidate: { nativeId: string; title: string; text: string; url?: string },
    at: number,
  ) => {
    store.enqueueDue(at, true);
    for (let job = store.claim(at); job; job = store.claim(at)) {
      expect(
        store.complete(
          job,
          { items: job.source_id === source ? [candidate] : [] },
          at + 1,
        ),
      ).toBe(true);
    }
  };
  ingest(
    a.id,
    { nativeId: "local-guid", title: "Story", text: "initial text" },
    1,
  );
  const original = store.search("initial")[0]!.id;
  ingest(
    a.id,
    {
      nativeId: "local-guid",
      title: "Story",
      text: "updated text",
      url: "https://example.test/story?utm_source=x",
    },
    5,
  );
  ingest(
    b.id,
    {
      nativeId: "different-guid",
      title: "Story",
      text: "updated text",
      url: "https://example.test/story",
    },
    10,
  );
  const item = store.search("updated")[0]!;
  expect(item.id).toBe(original);
  expect(store.search("updated")).toHaveLength(1);
  expect(store.getItem(original)!.references).toHaveLength(2);
  expect(
    store.getItem(original)!.content_versions.length,
  ).toBeGreaterThanOrEqual(3);
  expect(
    store.sqlite.query("SELECT count(*) AS n FROM item_url_aliases").get(),
  ).toEqual({ n: 1 });
  store.close();
});

test("URL alias reconciliation preserves both existing item IDs, history and generations", () => {
  const store = new Store(":memory:");
  const a = store.addSource("https://a.test/rss");
  const b = store.addSource("https://b.test/rss");
  const ingest = (
    source: string,
    candidate: { nativeId: string; title: string; text: string; url?: string },
    at: number,
  ) => {
    store.enqueueDue(at, true);
    for (let job = store.claim(at); job; job = store.claim(at)) {
      store.complete(
        job,
        { items: job.source_id === source ? [candidate] : [] },
        at + 1,
      );
    }
  };
  ingest(a.id, { nativeId: "a", title: "Story", text: "first body" }, 1);
  const nativeId = store.search("first")[0]!.id;
  ingest(
    b.id,
    {
      nativeId: "b",
      title: "Story",
      text: "second body",
      url: "https://example.test/story",
    },
    5,
  );
  const urlId = store.search("second")[0]!.id;
  expect(nativeId).not.toBe(urlId);
  ingest(
    a.id,
    {
      nativeId: "a",
      title: "Story",
      text: "corrected body",
      url: "https://example.test/story",
    },
    10,
  );
  const item = store.getItem(urlId)!;
  expect(store.getItem(nativeId)?.id).toBe(urlId);
  expect(item.references).toHaveLength(2);
  expect(item.content_versions.length).toBeGreaterThanOrEqual(3);
  expect(
    new Set(
      item.processing
        .filter((x) => x.stage === "extract")
        .map((x) => x.generation),
    ).size,
  ).toBeGreaterThanOrEqual(2);
  expect(store.search("corrected")).toHaveLength(1);
  expect(store.sqlite.query("SELECT count(*) AS n FROM items").get()).toEqual({
    n: 1,
  });
  expect(store.sqlite.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
  store.close();
});
