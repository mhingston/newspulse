import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db/store";
import { submitUrl, submissionFor } from "../src/manual";

test("a populated pre-#17 database migrates and keeps identity and search", () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-manual-migration-"));
  const prior = join(dir, "prior-migrations");
  const path = join(dir, "prior.sqlite");
  mkdirSync(join(prior, "meta"), { recursive: true });
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  for (const file of readdirSync(migrations))
    if (file.endsWith(".sql"))
      copyFileSync(join(migrations, file), join(prior, file));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number }[] };
  // Everything before this table was introduced.
  journal.entries = journal.entries.filter((entry) => entry.idx < 44);
  writeFileSync(join(prior, "meta/_journal.json"), JSON.stringify(journal));
  const db = new Database(path);
  migrate(drizzle(db), { migrationsFolder: prior });
  db.exec(`
    INSERT INTO sources(id,kind,url,title) VALUES('s','rss','https://example.com/feed','Feed');
    INSERT INTO items(id,identity,url,title,ingested_at)
      VALUES('existing','url:https://example.com/known','https://example.com/known','Known page',100);
    INSERT INTO content(item_id,text) VALUES('existing','searchable historical body');
    INSERT INTO item_sources(item_id,source_id,native_id,url)
      VALUES('existing','s','known','https://example.com/known');
  `);
  expect(
    db
      .query(
        "SELECT count(*) AS n FROM sqlite_master WHERE name='manual_submissions'",
      )
      .get(),
  ).toEqual({ n: 0 });
  db.close();
  let store: Store | undefined;
  try {
    store = new Store(path);
    // Historical identity and search survive the migration unchanged.
    expect(store.search("historical").map((item) => item.id)).toEqual([
      "existing",
    ]);
    expect(store.getItem("existing")!.url).toBe("https://example.com/known");
    // A manual submission of the known page gains a reference, not a copy.
    const submitted = submitUrl(store, {
      submissionId: "migration-1",
      url: "https://example.com/known?utm_source=bookmark",
      origin: "bookmark",
      now: 500,
    });
    expect(submitted.itemId).toBe("existing");
    const refs = store.getItem("existing")!.references as {
      source_id: string;
    }[];
    expect(refs.map((ref) => ref.source_id).sort()).toEqual([
      "manual:bookmark",
      "s",
    ]);
    expect(submissionFor(store, "existing")).toMatchObject({
      submission_id: "migration-1",
      origin: "bookmark",
    });
  } finally {
    store?.close();
  }
});

test("a historical Reddit item is reconciled by post ID instead of duplicated", () => {
  const store = new Store(":memory:");
  try {
    // Simulate a pre-#17 item whose identity was the full old.reddit URL.
    store.sqlite
      .query(
        "INSERT INTO items(id,identity,url,title,ingested_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "legacy",
        "url:https://old.reddit.com/r/rust/comments/abc123/title/",
        "https://old.reddit.com/r/rust/comments/abc123/title/",
        "Legacy discussion",
        100,
      );
    store.sqlite
      .query("INSERT INTO content(item_id,text) VALUES(?,?)")
      .run("legacy", "legacy body");
    const submitted = submitUrl(store, {
      submissionId: "s1",
      url: "https://redd.it/abc123",
      origin: "manual",
      now: 200,
    });
    expect(submitted.itemId).toBe("legacy");
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM items")
        .get(),
    ).toEqual({ n: 1 });
    // The historical body is preserved, not replaced by the empty submission.
    expect(store.getItem("legacy")!.text).toBe("legacy body");
    // The canonical alias is recorded so later lookups resolve directly.
    expect(
      store.sqlite
        .query<{ item_id: string }, [string]>(
          "SELECT item_id FROM item_url_aliases WHERE canonical_url=?",
        )
        .get("https://www.reddit.com/comments/abc123"),
    ).toEqual({ item_id: "legacy" });
  } finally {
    store.close();
  }
});

test("merging a duplicate repoints manual submission provenance", () => {
  const store = new Store(":memory:");
  try {
    const first = submitUrl(store, {
      submissionId: "s1",
      url: "https://www.reddit.com/r/rust/comments/abc123/title/",
      origin: "manual",
      now: 100,
    });
    // A historical duplicate with its own submission row.
    store.sqlite
      .query(
        "INSERT INTO items(id,identity,url,title,ingested_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "legacy",
        "url:https://old.reddit.com/r/rust/comments/abc123/title/",
        "https://old.reddit.com/r/rust/comments/abc123/title/",
        "Legacy discussion",
        50,
      );
    store.sqlite
      .query(
        "INSERT INTO manual_submissions(id,item_id,url,origin,title,snippet,metadata,submitted_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        "legacy-sub",
        "legacy",
        "https://old.reddit.com/r/rust/comments/abc123/title/",
        "bookmark",
        "Legacy discussion",
        "",
        "{}",
        50,
      );
    const second = submitUrl(store, {
      submissionId: "s2",
      url: "https://redd.it/abc123",
      origin: "bookmark",
      now: 200,
    });
    expect(second.itemId).toBe(first.itemId);
    expect(
      store.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM items")
        .get(),
    ).toEqual({ n: 1 });
    // The loser's provenance now points at the surviving item.
    expect(
      store.sqlite
        .query<{ item_id: string }, []>(
          "SELECT item_id FROM manual_submissions WHERE id='legacy-sub'",
        )
        .get(),
    ).toEqual({ item_id: first.itemId });
    // No submission references a deleted item.
    expect(
      store.sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM manual_submissions WHERE item_id NOT IN (SELECT id FROM items)",
        )
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    store.close();
  }
});
