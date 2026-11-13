import { Database } from "bun:sqlite";

export interface RecoveryReport {
  ok: boolean;
  integrity: string;
  foreignKeyViolations: number;
  ftsConsistent: boolean;
  migrations: number;
  counts: Record<string, number>;
  problems: string[];
}

const TABLES = [
  "items",
  "item_sources",
  "content_versions",
  "processing_jobs",
  "analyses",
  "item_scores",
  "digests",
  "digest_items",
  "deliveries",
  "item_feedback",
  "retention_purges",
] as const;

/**
 * Verifies a Newspulse SQLite file without changing it. It is used on backups
 * before restore and on the restored copy before switching DB_PATH. A failed
 * report means the file must not be used.
 */
export function verifyDatabase(path: string): RecoveryReport {
  const unreadable = (error: unknown): RecoveryReport => ({
    ok: false,
    integrity: "unreadable",
    foreignKeyViolations: 0,
    ftsConsistent: false,
    migrations: 0,
    counts: {},
    problems: [`unreadable database: ${String(error)}`],
  });
  let db: Database;
  try {
    db = new Database(path, { readonly: true, strict: true });
  } catch (error) {
    return unreadable(error);
  }
  try {
    return inspect(db);
  } catch (error) {
    return unreadable(error);
  } finally {
    db.close();
  }
}

function inspect(db: Database): RecoveryReport {
  const problems: string[] = [];
  const integrity =
    db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
      ?.integrity_check ?? "missing";
  if (integrity !== "ok") problems.push("integrity_check failed");
  const foreignKeyViolations = db
    .query<unknown, []>("PRAGMA foreign_key_check")
    .all().length;
  if (foreignKeyViolations > 0)
    problems.push(`${foreignKeyViolations} foreign key violations`);
  let ftsConsistent = true;
  try {
    // Read-only probe; a corrupt FTS5 shadow table fails here.
    db.query(
      "SELECT rowid FROM items_fts WHERE items_fts MATCH 'a OR b' LIMIT 1",
    ).all();
  } catch {
    ftsConsistent = false;
    problems.push("search index is not readable");
  }
  const ftsRows = db
    .query<{ n: number }, []>("SELECT count(*) n FROM items_fts")
    .get()?.n;
  const itemRows = db
    .query<{ n: number }, []>("SELECT count(*) n FROM items")
    .get()?.n;
  if (ftsRows !== itemRows) {
    ftsConsistent = false;
    problems.push("search index row count does not match items");
  }
  const migrations = db
    .query<{ n: number }, []>("SELECT count(*) n FROM __drizzle_migrations")
    .get()?.n;
  if (migrations === undefined) problems.push("migration journal missing");
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const exists = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(table);
    if (!exists) {
      problems.push(`missing table ${table}`);
      continue;
    }
    counts[table] = db
      .query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`)
      .get()!.n;
  }
  return {
    ok: problems.length === 0,
    integrity,
    foreignKeyViolations,
    ftsConsistent,
    migrations: migrations ?? 0,
    counts,
    problems,
  };
}
