import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { DigestStore, type FrozenDigestInput } from "../src/db/digest-store";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const edition: FrozenDigestInput = {
  date: "2026-11-09",
  timezone: "Europe/London",
  subject: "Discovery",
  html: "<p>One</p>",
  text: "One",
  decisionSnapshot: { excluded: [{ id: "other", reason: "low score" }] },
  items: [
    {
      itemId: "historic-item",
      groupId: "historic-group",
      scoreId: "historic-score",
      snapshot: {
        title: "Original",
        citations: [{ url: "https://example.test/article" }],
      },
    },
  ],
};

test("freezing is atomic, idempotent and database-enforced immutable", () => {
  const store = new Store(":memory:");
  try {
    const digests = new DigestStore(store.sqlite);
    store.sqlite
      .query(
        "INSERT INTO items(id,identity,title,ingested_at) VALUES('historic-item','identity','Original',1)",
      )
      .run();
    const original = digests.freeze(edition, 1234);
    store.sqlite
      .query("UPDATE items SET title='Updated title' WHERE id='historic-item'")
      .run();
    expect(digests.freeze(edition, 2000)).toEqual(original);
    expect(() =>
      digests.freeze({ ...edition, subject: "Rewritten" }, 2000),
    ).toThrow();
    expect(() =>
      store.sqlite
        .query("UPDATE digests SET subject='rewritten' WHERE id=?")
        .run(original.id),
    ).toThrow();
    expect(() =>
      store.sqlite.query("DELETE FROM digests WHERE id=?").run(original.id),
    ).toThrow();
    expect(() =>
      store.sqlite
        .query(
          "INSERT OR REPLACE INTO digests(id,edition_date,timezone,subject,html,plain_text,decisions,fingerprint,frozen_at,sealed) VALUES(?,?,?,?,?,?,?,?,?,1)",
        )
        .run(
          original.id,
          edition.date,
          edition.timezone,
          "rewritten",
          "x",
          "x",
          "{}",
          "x",
          1,
        ),
    ).toThrow();
    expect(() =>
      store.sqlite
        .query(
          "INSERT OR REPLACE INTO digests(id,edition_date,timezone,subject,html,plain_text,decisions,fingerprint,frozen_at,sealed) VALUES(?,?,?,?,?,?,?,?,?,1)",
        )
        .run(
          "different",
          edition.date,
          edition.timezone,
          "rewritten",
          "x",
          "x",
          "{}",
          "x",
          1,
        ),
    ).toThrow();
    expect(() =>
      store.sqlite
        .query("UPDATE digest_items SET snapshot='{}' WHERE digest_id=?")
        .run(original.id),
    ).toThrow();
    expect(() =>
      store.sqlite
        .query("DELETE FROM digest_items WHERE digest_id=?")
        .run(original.id),
    ).toThrow();
    expect(() =>
      store.sqlite
        .query(
          "INSERT INTO digest_items(digest_id,position,item_id,snapshot) VALUES(?,1,'extra','{}')",
        )
        .run(original.id),
    ).toThrow();
    expect(digests.get(edition.date)).toEqual(original);
    expect(original.items[0]!.snapshot).toEqual(edition.items[0]!.snapshot);
  } finally {
    store.close();
  }
});

test("invalid dates, duplicate items and empty editions are not frozen", () => {
  const store = new Store(":memory:");
  try {
    const digests = new DigestStore(store.sqlite);
    expect(() => digests.freeze({ ...edition, date: "2026-02-30" })).toThrow();
    expect(() =>
      digests.freeze({ ...edition, timezone: "invalid-zone" }),
    ).toThrow();
    expect(() => digests.freeze({ ...edition, items: [] })).toThrow();
    expect(() =>
      digests.freeze({
        ...edition,
        items: [edition.items[0]!, edition.items[0]!],
      }),
    ).toThrow();
    expect(digests.get(edition.date)).toBeNull();
  } finally {
    store.close();
  }
});

test("frozen edition survives backup and restore without live item references", () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-digest-"));
  const path = join(dir, "primary.sqlite"),
    backup = join(dir, "backup.sqlite");
  let primary: Store | undefined, restored: Store | undefined;
  try {
    primary = new Store(path);
    const expected = new DigestStore(primary.sqlite).freeze(edition, 1234);
    primary.backup(backup);
    restored = new Store(backup);
    expect(new DigestStore(restored.sqlite).get(edition.date)).toEqual(
      expected,
    );
    expect(restored.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
  } finally {
    restored?.close();
    primary?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("populated pre-digest database migrates without losing search or identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-digest-migration-"));
  const dbPath = join(dir, "prior.sqlite"),
    old = join(dir, "migrations");
  mkdirSync(join(old, "meta"), { recursive: true });
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  for (const file of readdirSync(migrations))
    if (file.endsWith(".sql"))
      copyFileSync(join(migrations, file), join(old, file));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx < 29);
  writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
  const db = new Database(dbPath);
  migrate(drizzle(db), { migrationsFolder: old });
  db.exec(
    "INSERT INTO items(id,identity,title,ingested_at) VALUES('id','identity','Searchable baseline',1); INSERT INTO content(item_id,text) VALUES('id','preserved material')",
  );
  db.close();
  let upgraded: Store | undefined;
  try {
    upgraded = new Store(dbPath);
    expect(upgraded.search("preserved")[0]!.id).toBe("id");
    expect(
      new DigestStore(upgraded.sqlite).freeze(edition, 1234).items,
    ).toHaveLength(1);
    expect(upgraded.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
  } finally {
    upgraded?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
