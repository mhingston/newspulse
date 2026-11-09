import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { InboundStore } from "../src/db/inbound";
import { normalizeNewsletter } from "../src/adapters/newsletter";
import type { ReceivedEmail } from "../src/inbound";

function email(id: string, sender: string): ReceivedEmail {
  return {
    metadata: {
      providerId: id,
      receivedAt: 123,
      from: sender,
      to: [],
      subject: `Digest ${id}`,
      messageId: null,
      receivedFor: [],
    },
    text: null,
    html: '<p>Newsletter original unique narrative</p><a href="https://example.com/article?utm_source=email">An unusual article</a>',
  };
}
function complete(store: Store, message: ReceivedEmail) {
  const inbound = new InboundStore(store.sqlite);
  inbound.recordEvent(
    "resend",
    {
      eventId: `event-${message.metadata.providerId}`,
      metadata: message.metadata,
    },
    1,
  );
  const claim = inbound.claimMessage(2)!;
  expect(inbound.completeMessage(claim, message, 3)).toBe(true);
}

test("indexing is atomic, idempotent, searchable and retains each sender across RSS deduplication", () => {
  const store = new Store(":memory:");
  try {
    const feed = store.addSource("https://feed.example/rss", "Feed");
    store.enqueueDue(1, true);
    const job = store.claim(2)!;
    store.complete(
      job,
      {
        items: [
          {
            nativeId: "rss-entry",
            url: "https://example.com/article",
            title: "RSS article",
            text: "Article report",
          },
        ],
      },
      3,
    );
    complete(store, email("one", "One <one@example.com>"));
    complete(store, email("two", "Two <two@example.com>"));
    store.sqlite.exec(
      "CREATE TRIGGER fail_index BEFORE UPDATE OF item_id ON inbound_messages BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    expect(() => store.indexNextNewsletter(normalizeNewsletter, 4)).toThrow();
    expect(store.search("narrative")).toHaveLength(0);
    store.sqlite.exec("DROP TRIGGER fail_index");
    expect(store.indexNextNewsletter(normalizeNewsletter, 4)).toBe(true);
    expect(store.indexNextNewsletter(normalizeNewsletter, 5)).toBe(true);
    expect(store.indexNextNewsletter(normalizeNewsletter, 6)).toBe(false);
    expect(store.search("narrative")).toHaveLength(2);
    const article = store.search("Article report")[0]!;
    const refs = store.getItem(article.id)!.references as {
      source_id: string;
      parent_item_id: string | null;
      newsletter_sender: string | null;
      newsletter_received_at: number | null;
    }[];
    expect(refs.some((ref) => ref.source_id === feed.id)).toBe(true);
    expect(
      refs
        .filter((ref) => ref.parent_item_id)
        .map((ref) => ref.newsletter_sender)
        .sort(),
    ).toEqual(["One <one@example.com>", "Two <two@example.com>"]);
    expect(
      refs
        .filter((ref) => ref.parent_item_id)
        .every((ref) => ref.newsletter_received_at === 123),
    ).toBe(true);
    const original = store.getItem(
      refs.find((ref) => ref.parent_item_id)!.parent_item_id!,
    )!;
    expect(
      (original.references as { newsletter_sender: string }[])[0]!
        .newsletter_sender,
    ).toBeTruthy();
    const source = store.sources().find((value) => value.kind === "inbound")!;
    expect(() => store.updateSource(source.id, { enabled: true })).toThrow();
    expect(() => store.removeSource(source.id)).toThrow();
    expect(store.enqueueDue(7, true)).toBe(1); // only the RSS source is pollable
  } finally {
    store.close();
  }
});

test("official MCP client finds original and child before analysis", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { createApp } = await import("../src/http");
  const store = new Store(":memory:");
  const token = "newsletter-token-at-least-24-characters";
  const app = createApp(store, {
    token,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
  });
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const client = new Client({ name: "newsletter-test", version: "1" });
  try {
    complete(store, email("one", "sender@example.com"));
    store.indexNextNewsletter(normalizeNewsletter, 4);
    await client.connect(
      new StreamableHTTPClientTransport(new URL("mcp", api.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    for (const term of ["narrative", "unusual"]) {
      const result = await client.callTool({
        name: "search_items",
        arguments: { query: term },
      });
      const payload = JSON.parse(
        (result.content as { text: string }[])[0]!.text,
      );
      const match = payload.items.find((item: { url: string | null }) =>
        term === "narrative" ? item.url === null : item.url !== null,
      );
      expect(match).toBeDefined();
      expect(match.analysis_status).toBe("pending");
      const detail = await client.callTool({
        name: "get_item",
        arguments: { id: match.id },
      });
      const item = JSON.parse((detail.content as { text: string }[])[0]!.text);
      expect(item.references[0].newsletter_sender).toBe("sender@example.com");
    }
  } finally {
    await client.close();
    api.stop(true);
    store.close();
  }
});

test("a changed completed body cannot be committed from a stale normalization", () => {
  const store = new Store(":memory:");
  try {
    complete(store, email("one", "sender@example.com"));
    expect(
      store.indexNextNewsletter((value) => {
        const result = normalizeNewsletter(value);
        store.sqlite
          .query("UPDATE inbound_messages SET body=? WHERE provider_id='one'")
          .run(JSON.stringify(email("one", "new@example.com")));
        return result;
      }, 4),
    ).toBe(false);
    expect(store.search("narrative")).toHaveLength(0);
    expect(store.indexNextNewsletter(normalizeNewsletter, 5)).toBe(true);
    const item = store.search("narrative")[0]!;
    expect(
      (
        store.getItem(item.id)!.references as { newsletter_sender: string }[]
      )[0]!.newsletter_sender,
    ).toBe("new@example.com");
  } finally {
    store.close();
  }
});

test("malformed messages do not starve later messages", () => {
  const store = new Store(":memory:");
  try {
    complete(store, email("one", "one@example.com"));
    complete(store, email("two", "two@example.com"));
    store.sqlite
      .query("UPDATE inbound_messages SET body='{}' WHERE provider_id='one'")
      .run();
    expect(store.indexNextNewsletter(normalizeNewsletter, 4)).toBe(true);
    expect(store.indexNextNewsletter(normalizeNewsletter, 5)).toBe(true);
    expect(store.search("narrative")).toHaveLength(1);
    expect(store.status().inbound_indexing).toEqual({
      total: 2,
      pending: 0,
      failed: 1,
    });
  } finally {
    store.close();
  }
});

test("newsletter extraction fetches cleaned URL while retaining original citation", () => {
  const store = new Store(":memory:");
  try {
    complete(store, email("one", "sender@example.com"));
    store.indexNextNewsletter(normalizeNewsletter, 4);
    const child = store.search("unusual").find((item) => item.url)!;
    const item = store.getItem(child.id)!;
    expect((item.references as { url: string }[])[0]!.url).toContain(
      "utm_source=email",
    );
    const job = store.sqlite
      .query<{ origin_url: string }, [string]>(
        "SELECT origin_url FROM processing_jobs WHERE stage='extract' AND item_id=?",
      )
      .get(child.id)!;
    expect(job.origin_url).toBe("https://example.com/article");
  } finally {
    store.close();
  }
});

test("indexed originals and provenance survive backup and restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "newsletter-"));
  const store = new Store(join(dir, "live.sqlite"));
  let restored: Store | undefined;
  try {
    complete(store, email("one", "sender@example.com"));
    store.indexNextNewsletter(normalizeNewsletter, 4);
    const backup = join(dir, "backup.sqlite");
    store.backup(backup);
    restored = new Store(backup);
    expect(restored.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    const item = restored.search("narrative")[0]!;
    expect(
      (
        restored.getItem(item.id)!.references as { newsletter_sender: string }[]
      )[0]!.newsletter_sender,
    ).toBe("sender@example.com");
    expect(restored.indexNextNewsletter(normalizeNewsletter, 5)).toBe(false);
  } finally {
    restored?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrade indexes a completed pre-upgrade message and preserves existing search", async () => {
  const { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } =
    await import("node:fs");
  const { Database } = await import("bun:sqlite");
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "newsletter-migrate-"));
  const prior = join(dir, "migrations"),
    path = join(dir, "old.sqlite");
  mkdirSync(join(prior, "meta"), { recursive: true });
  const root = fileURLToPath(new URL("../drizzle/", import.meta.url));
  for (const name of readdirSync(root))
    if (name.endsWith(".sql"))
      copyFileSync(join(root, name), join(prior, name));
  const journal = JSON.parse(
    readFileSync(join(root, "meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx < 36,
  );
  writeFileSync(join(prior, "meta/_journal.json"), JSON.stringify(journal));
  const db = new Database(path);
  migrate(drizzle(db), { migrationsFolder: prior });
  const message = email("one", "sender@example.com");
  db.query(
    "INSERT INTO inbound_messages(id,provider,provider_id,received_at,metadata,body,status,available_at,updated_at) VALUES(?,?,?,?,?,?,'complete',0,0)",
  ).run(
    "message",
    "resend",
    "one",
    123,
    JSON.stringify(message.metadata),
    JSON.stringify(message),
  );
  db.exec(
    "INSERT INTO items(id,identity,title,ingested_at) VALUES('prior','prior','Prior',1); INSERT INTO content(item_id,text) VALUES('prior','preupgrade searchable')",
  );
  db.close();
  let store: Store | undefined;
  try {
    store = new Store(path);
    expect(store.search("preupgrade")[0]!.id).toBe("prior");
    expect(store.indexNextNewsletter(normalizeNewsletter, 4)).toBe(true);
    expect(store.search("narrative")).toHaveLength(1);
    expect(store.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
