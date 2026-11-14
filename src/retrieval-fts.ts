import { Database } from "bun:sqlite";
import { join } from "node:path";
import type {
  RetrievalCorpus,
  RetrievalFilters,
  RetrievalIndexFootprint,
} from "./retrieval-evaluation";

/**
 * Offline FTS5 executor for the retrieval-gap evaluation. It reproduces the
 * production index shape (items_fts with title/text plus item metadata pasted
 * through a join table) on a throwaway database, so recorded queries are
 * replayed against real FTS5 behavior without touching a deployment database.
 */

export interface RetrievalFtsDatabase {
  db: Database;
  /** Runs one match with production-style bm25 ordering and returns item ids. */
  search(
    match: string,
    filters: RetrievalFilters | undefined,
    k: number,
  ): string[];
  countRows(): number;
  deleteItem(id: string): void;
}

export function createRetrievalFtsDatabase(
  corpus: RetrievalCorpus,
  mode: ":memory:" | { path: string } = ":memory:",
  options: { create?: boolean } = {},
): RetrievalFtsDatabase {
  const db =
    mode === ":memory:" ? new Database(":memory:") : new Database(mode.path);
  if (options.create === false) {
    return buildSearchInterface(db);
  }
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE retrieval_items (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      published_at INTEGER,
      source_kind TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE items_fts USING fts5(title, text);
  `);
  const insert = db.query(
    "INSERT INTO retrieval_items(rowid, id, published_at, source_kind) VALUES (?, ?, ?, ?)",
  );
  const insertFts = db.query(
    "INSERT INTO items_fts(rowid, title, text) VALUES (?, ?, ?)",
  );
  corpus.items.forEach((item, index) => {
    const rowid = index + 1;
    insert.run(rowid, item.id, item.publishedAt, item.sourceKind);
    const text = item.unavailable ? "" : item.text;
    insertFts.run(rowid, item.title, text);
  });
  return buildSearchInterface(db);
}

function buildSearchInterface(db: Database): RetrievalFtsDatabase {
  return {
    db,
    search(match, filters, k) {
      return db
        .query<
          { id: string },
          [
            string,
            number | null,
            number | null,
            number | null,
            number | null,
            string | null,
            string | null,
            number,
          ]
        >(
          `SELECT r.id FROM items_fts JOIN retrieval_items r ON r.rowid = items_fts.rowid
       WHERE items_fts MATCH ?
       AND (? IS NULL OR r.published_at >= ?)
       AND (? IS NULL OR r.published_at < ?)
       AND (? IS NULL OR r.source_kind = ?)
       ORDER BY bm25(items_fts), r.id
       LIMIT ?`,
        )
        .all(
          match,
          filters?.from ?? null,
          filters?.from ?? null,
          filters?.to ?? null,
          filters?.to ?? null,
          filters?.sourceKind ?? null,
          filters?.sourceKind ?? null,
          Math.max(1, Math.min(100, k)),
        )
        .map((row) => row.id);
    },
    countRows() {
      return db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM items_fts")
        .get()!.count;
    },
    deleteItem(id: string) {
      db.query(
        "DELETE FROM items_fts WHERE rowid = (SELECT rowid FROM retrieval_items WHERE id = ?)",
      ).run(id);
    },
  };
}

/**
 * Measures the on-disk cost of the FTS index against the same items stored
 * without FTS. Committed page counts are deterministic for identical rows,
 * so the difference is reported as the index overhead.
 */
export function measureIndexFootprint(
  corpus: RetrievalCorpus,
  dir: string,
): RetrievalIndexFootprint {
  const stem = join(dir, "retrieval-footprint");
  const withoutFts = `${stem}-plain.sqlite`;
  const withFts = `${stem}-fts.sqlite`;
  const plain = new Database(withoutFts);
  plain.exec(
    "CREATE TABLE retrieval_items (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, text TEXT NOT NULL, published_at INTEGER, source_kind TEXT NOT NULL);",
  );
  const insertPlain = plain.query(
    "INSERT INTO retrieval_items(rowid, id, title, text, published_at, source_kind) VALUES (?, ?, ?, ?, ?, ?)",
  );
  corpus.items.forEach((item, index) => {
    insertPlain.run(
      index + 1,
      item.id,
      item.title,
      item.unavailable ? "" : item.text,
      item.publishedAt,
      item.sourceKind,
    );
  });
  const pages = (path: string) => {
    const file = new Database(path, { readonly: true });
    const size =
      file.query<{ page_count: number }, []>("PRAGMA page_count").get()!
        .page_count *
      file.query<{ page_size: number }, []>("PRAGMA page_size").get()!
        .page_size;
    file.close();
    return size;
  };
  const itemsOnlyBytes = pages(withoutFts);
  plain.close();
  const ftsDb = createRetrievalFtsDatabase(corpus, { path: withFts });
  ftsDb.db.close();
  const ftsBytes = pages(withFts);
  return {
    itemsOnlyBytes,
    ftsBytes,
    ftsOverheadBytes: ftsBytes - itemsOnlyBytes,
  };
}
