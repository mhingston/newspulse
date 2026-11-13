import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
] as const;

/** Tables introduced by a migration; required only once that migration is applied. */
const TABLES_BY_MIGRATION: { tag: string; tables: readonly string[] }[] = [
  { tag: "0047_retention_purges", tables: ["retention_purges"] },
  { tag: "0048_delivery_suppressions", tables: ["delivery_suppressions"] },
];

/** Migrations in bundle order, read from the checked-in Drizzle journal. */
const JOURNAL = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
      "utf8",
    ),
  ) as { entries: { tag: string; when: number }[] }
).entries;

/** Search text composition before analysis summaries were indexed (0013). */
const ANALYSIS_SEARCH_TAG = "0013_analysis_fts";

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

/** The applied migrations must be a prefix of the bundled journal, in order. */
function appliedVersion(db: Database): { count: number; problem?: string } {
  const journal = db
    .query<{ created_at: number | null }, []>(
      "SELECT created_at FROM __drizzle_migrations ORDER BY id",
    )
    .all();
  if (journal.length === 0)
    return { count: 0, problem: "migration journal is empty" };
  for (let i = 0; i < journal.length; i += 1) {
    if (journal[i]!.created_at !== JOURNAL[i]?.when)
      return {
        count: journal.length,
        problem: "migration journal does not match a supported version",
      };
  }
  return { count: journal.length };
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

  const version = appliedVersion(db);
  if (version.problem) problems.push(version.problem);
  const applied = JOURNAL.slice(0, version.count).map((entry) => entry.tag);

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
  if (ftsConsistent && version.count > 0 && !version.problem) {
    const searchProblems = searchIndexProblems(
      db,
      applied.includes(ANALYSIS_SEARCH_TAG),
    );
    if (searchProblems.length > 0) {
      ftsConsistent = false;
      problems.push(...searchProblems);
    }
  }

  const migrations = version.count;
  const counts: Record<string, number> = {};
  const required = [
    ...TABLES,
    ...TABLES_BY_MIGRATION.filter(({ tag }) => applied.includes(tag)).flatMap(
      ({ tables }) => tables,
    ),
  ];
  for (const table of required) {
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
    migrations,
    counts,
    problems,
  };
}

/**
 * Checks every item has exactly one index row with the same rowid and that the
 * indexed title/text equal what the triggers would produce for the current
 * content, extraction and (when applicable) summary. Equal counts alone are
 * not sufficient: a stale row or a missing row balanced by an orphan proves nothing.
 */
function searchIndexProblems(db: Database, withSummary: boolean): string[] {
  const summary = withSummary
    ? `coalesce((SELECT json_extract(a.result,'$.summary') FROM analyses a WHERE a.item_id=i.id AND a.generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=i.id AND stage='extract') ORDER BY a.created_at DESC LIMIT 1),'')`
    : `''`;
  // Triggers only write text once a content row exists; before that it stays ''.
  const expectedText = `CASE WHEN c.item_id IS NULL THEN '' ELSE c.text || char(10) || coalesce((SELECT CASE WHEN json_valid(p.result) THEN json_extract(p.result,'$.text') ELSE NULL END FROM processing_jobs p WHERE p.item_id=i.id AND p.stage='extract' AND p.status='done' AND p.outcome='extracted' AND p.generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=i.id AND stage='extract')),'') || char(10) || ${summary} END`;
  const problems: string[] = [];
  const missing = db
    .query<{ n: number }, []>(
      "SELECT count(*) n FROM items i WHERE NOT EXISTS (SELECT 1 FROM items_fts f WHERE f.rowid=i.rowid)",
    )
    .get()!.n;
  if (missing > 0) problems.push(`${missing} items missing from search index`);
  const orphaned = db
    .query<{ n: number }, []>(
      "SELECT count(*) n FROM items_fts f WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.rowid=f.rowid)",
    )
    .get()!.n;
  if (orphaned > 0) problems.push(`${orphaned} orphaned search index rows`);
  const stale = db
    .query<{ n: number }, []>(
      `SELECT count(*) n FROM items i JOIN items_fts f ON f.rowid=i.rowid LEFT JOIN content c ON c.item_id=i.id
        WHERE f.title IS NOT i.title OR f.text IS NOT (${expectedText})`,
    )
    .get()!.n;
  if (stale > 0) problems.push(`${stale} search index rows are stale`);
  return problems;
}
