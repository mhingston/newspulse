import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { parseFeed, RssAdapter, HttpError } from "../src/adapters/rss";
import { parseOpml, exportOpml } from "../src/adapters/opml";
import { identity } from "../src/domain";
import { Worker } from "../src/worker";
import { createApp } from "../src/http";
import { Resend } from "resend";
import { rss, atom, opml } from "./fixtures";
function temp() {
  return mkdtempSync(join(tmpdir(), "newspulse-"));
}
test("RSS and Atom normalize and deduplicate identities; URL-less items stay valid", () => {
  const a = parseFeed(rss, "https://example.com/feed");
  const b = parseFeed(atom, "https://example.org/atom");
  expect(a).toHaveLength(2);
  expect(a[0]!.url).toBe("https://example.com/models");
  expect(a[0]!.text).toBe("Small models improve robotics.");
  expect(identity(a[0]!, "a")).toBe(identity(b[0]!, "b"));
  expect(a[1]!.url).toBeUndefined();
  expect(identity(a[1]!, "a")).toBe("source:a:private-message");
  expect(() =>
    parseFeed("<html>error</html>", "https://example.com"),
  ).toThrow();
  expect(() =>
    parseFeed("<!DOCTYPE foo><rss/>", "https://example.com"),
  ).toThrow();
});
test("nested Miniflux-compatible OPML round-trips and rejects unsafe URLs", () => {
  const feeds = parseOpml(opml("https://example.com/feed"));
  expect(feeds).toEqual([
    { url: "https://example.com/feed", title: "Engineering" },
  ]);
  expect(parseOpml(exportOpml(feeds))).toEqual(feeds);
  expect(() => parseOpml(opml("file:///etc/passwd"))).toThrow();
});
test("digest fan-out preserves parent and provenance without duplicate articles", () => {
  const store = new Store(":memory:");
  try {
    const s = store.addSource("https://example.com/feed");
    store.enqueueDue(100);
    const job = store.claim(100)!;
    const links = Array.from(
      { length: 6 },
      (_, i) => `<a href="https://publisher${i % 3}.com/${i}">Article ${i}</a>`,
    ).join("");
    const parsed = parseFeed(
      `<rss><channel><item><guid>digest</guid><title>Weekly digest</title><description><![CDATA[${links}]]></description></item></channel></rss>`,
      s.url,
    );
    expect(parsed[0]!.children).toHaveLength(6);
    store.complete(job, { items: parsed }, 101);
    expect(store.search("Article")).toHaveLength(7); // Six candidates plus their preserved digest.
    expect(
      store.sqlite
        .query("SELECT * FROM item_sources WHERE parent_item_id IS NOT NULL")
        .all(),
    ).toHaveLength(6);
  } finally {
    store.close();
  }
});
test("restart recovery fences old leases; ingestion is atomic and cross-source idempotent", () => {
  const dir = temp();
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    const s = store.addSource("https://example.com/rss");
    store.enqueueDue(1000);
    expect(store.enqueueDue(1000)).toBe(0);
    const stale = store.claim(1000)!;
    store.close();
    store = new Store(path);
    expect(store.claim(2000)).toBeNull();
    const recovered = store.claim(62000)!;
    expect(recovered.attempts).toBe(2);
    expect(store.complete(stale, { items: parseFeed(rss, s.url) }, 62001)).toBe(
      false,
    );
    expect(
      store.complete(recovered, { items: parseFeed(rss, s.url) }, 62001),
    ).toBe(true);
    expect(store.search("robotics")).toHaveLength(1);
    expect(store.search("information")).toHaveLength(1);
    const s2 = store.addSource("https://example.org/atom");
    store.enqueueDue(63000);
    const j2 = store.claim(63000)!;
    store.complete(j2, { items: parseFeed(atom, s2.url) }, 63001);
    expect(store.search("models")).toHaveLength(1);
    expect(
      store.getItem(store.search("models")[0]!.id)!.references,
    ).toHaveLength(2);
    store.enqueueDue(64000, true);
    let j;
    while ((j = store.claim(64000)))
      store.complete(j, { items: parseFeed(rss, s.url) }, 64001);
    expect(store.search("models")).toHaveLength(1);
    expect(store.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("rate limits and retries survive restart and terminate after five attempts", () => {
  const dir = temp();
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    store.addSource("https://example.com/rss");
    let now = 1000;
    store.enqueueDue(now);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const job = store.claim(now)!;
      expect(job.attempts).toBe(attempt);
      store.fail(job, "429", 120_000, now);
      expect(store.claim(now + 1000)).toBeNull();
      store.close();
      store = new Store(path);
      now += Math.max(120000, 30000 * 2 ** (attempt - 1));
    }
    expect(store.claim(now)).toBeNull();
    expect(store.sqlite.query("SELECT status FROM jobs").get()).toEqual({
      status: "failed",
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("polling sends validators, handles 304, rejects HTTP errors and oversized bodies", async () => {
  let seen: Headers | undefined;
  const adapter = new RssAdapter(async (_input, init) => {
    seen = new Headers(init?.headers);
    return new Response(null, { status: 304 });
  });
  const result = await adapter.poll("https://example.com", {
    etag: '"v1"',
    lastModified: "yesterday",
  });
  expect(seen!.get("if-none-match")).toBe('"v1"');
  expect(seen!.get("if-modified-since")).toBe("yesterday");
  expect(result.notModified).toBe(true);
  const bad = new RssAdapter(
    async () =>
      new Response("", { status: 429, headers: { "retry-after": "120" } }),
  );
  try {
    await bad.poll("https://example.com", {});
    throw new Error("Expected rejection");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).retryAfterMs).toBe(120000);
  }
  const huge = new RssAdapter(async () => new Response("x".repeat(5_000_001)));
  await expect(huge.poll("https://example.com", {})).rejects.toThrow("budget");
});
test("one source failure does not stop healthy sources", async () => {
  const store = new Store(":memory:");
  try {
    store.addSource("https://bad.example/feed");
    store.addSource("https://good.example/feed");
    store.enqueueDue();
    const worker = new Worker(store, {
      async poll(url) {
        if (url.includes("bad.")) throw new Error("offline");
        return { items: parseFeed(rss, url) };
      },
    });
    expect(await worker.drain()).toBe(2);
    expect(store.search("models")).toHaveLength(1);
    expect(
      store.sources().find((s) => s.url.includes("bad."))?.last_error,
    ).toBe("offline");
  } finally {
    store.close();
  }
});
test("backup is consistent and can reopen with FTS and provenance", () => {
  const dir = temp();
  const store = new Store(join(dir, "db.sqlite"));
  let restored: Store | undefined;
  try {
    const s = store.addSource("https://example.com");
    store.enqueueDue();
    store.complete(store.claim()!, { items: parseFeed(rss, s.url) });
    const dest = join(dir, "backup.sqlite");
    store.backup(dest);
    restored = new Store(dest);
    expect(restored.search("robotics")).toHaveLength(1);
    expect(() => store.backup(dest)).toThrow();
  } finally {
    restored?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTP rejects missing auth, disallowed hosts and browser origins", async () => {
  const store = new Store(":memory:");
  const token = "x".repeat(32);
  const app = createApp(store, {
    token,
    allowedHosts: ["localhost"],
    allowedOrigins: [],
  });
  try {
    expect((await app.request("http://localhost/health")).status).toBe(401);
    expect(
      (
        await app.request("http://evil.example/health", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("http://localhost/health", {
          headers: {
            authorization: `Bearer ${token}`,
            origin: "https://evil.example",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("http://localhost/health", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
  } finally {
    store.close();
  }
});
test("pinned Resend SDK loads under Bun and exposes required future APIs", () => {
  const resend = new Resend("re_test");
  expect(typeof resend.emails.receiving.get).toBe("function");
  expect(typeof resend.emails.receiving.list).toBe("function");
  expect(typeof resend.emails.send).toBe("function");
  expect(typeof resend.webhooks.verify).toBe("function");
});

test("a later feed body enriches a digest placeholder and remains searchable", () => {
  const store = new Store(":memory:");
  try {
    const first = store.addSource("https://digest.example/feed");
    store.enqueueDue(100);
    store.complete(
      store.claim(100)!,
      {
        items: [
          {
            nativeId: "digest",
            title: "Digest",
            text: "Links",
            children: [
              { url: "https://example.com/story", title: "Placeholder" },
            ],
          },
        ],
      },
      101,
    );
    const second = store.addSource("https://publisher.example/feed");
    store.enqueueDue(102);
    store.complete(
      store.claim(102)!,
      {
        items: [
          {
            nativeId: "article",
            title: "Detailed robotics article",
            url: "https://example.com/story",
            text: "Fresh substantive robotics findings",
          },
        ],
      },
      103,
    );
    const matches = store.search("substantive");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.title).toBe("Detailed robotics article");
    expect(store.getItem(matches[0]!.id)!.references).toHaveLength(2);
    expect(store.search("robotics", 20, second.id, 103)).toHaveLength(0);
    expect(store.search("robotics", 20, second.id, 100)).toHaveLength(1);
    expect(store.search("robotics", 20, first.id)).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("failed ingestion rolls back items, FTS, validators and completion together", () => {
  const store = new Store(":memory:");
  try {
    store.addSource("https://example.com/feed");
    store.enqueueDue(100);
    const job = store.claim(100)!;
    expect(() =>
      store.complete(
        job,
        {
          etag: "bad-state",
          items: [
            { nativeId: "ok", title: "Robotics", text: "rollback marker" },
            {
              nativeId: "bad",
              title: "Bad URL",
              url: "file:///etc/passwd",
              text: "",
            },
          ],
        },
        101,
      ),
    ).toThrow();
    expect(store.search("Robotics")).toHaveLength(0);
    expect(store.state(job.source_id).etag).toBeUndefined();
    expect(store.complete(job, { etag: "good-state", items: [] }, 102)).toBe(
      true,
    );
  } finally {
    store.close();
  }
});

test("scheduler shutdown finishes the active poll without claiming the remaining queue", async () => {
  const { schedule } = await import("../src/worker");
  const store = new Store(":memory:");
  let finishPoll!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finishPoll = resolve;
  });
  let calls = 0;
  try {
    store.addSource("https://first.example/feed");
    store.addSource("https://second.example/feed");
    const worker = new Worker(store, {
      async poll() {
        calls++;
        await blocked;
        return { items: [] };
      },
    });
    const scheduler = schedule(store, worker);
    expect(calls).toBe(1);
    const stopped = scheduler.stop();
    finishPoll();
    await stopped;
    expect(calls).toBe(1);
    expect(
      store.sqlite
        .query("SELECT count(*) AS count FROM jobs WHERE status='pending'")
        .get(),
    ).toEqual({ count: 1 });
    expect(await worker.drain()).toBe(1);
  } finally {
    finishPoll();
    store.close();
  }
});
