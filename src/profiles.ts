import type { Database } from "bun:sqlite";
import { z } from "zod";
import { invalidateScores } from "./db/score-queue";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const label = z.string().trim().min(1).max(500);
const labels = z.array(label).max(100);
const base = {
  id,
  version: z.number().int().positive().safe(),
  description: label,
};
export const interestSchema = z
  .strictObject({
    kind: z.literal("interest"),
    ...base,
    entities: labels,
    keywords: labels,
    priority: z.number().int().min(1).max(5),
    positive: labels,
    negative: labels,
    queries: z.array(z.string().trim().min(1).max(500)).max(20),
    lifetime: z.enum(["temporary", "persistent"]),
    expiresAt: z.number().int().positive().safe().optional(),
    feedbackRefs: z.array(id).max(1000),
  })
  .refine(
    (p) =>
      p.lifetime === "temporary"
        ? p.expiresAt !== undefined
        : p.expiresAt === undefined,
    "Temporary interests require an expiry; persistent interests must not expire",
  );
export const editorialSchema = z.strictObject({
  kind: z.literal("editorial"),
  ...base,
  contentTypes: z
    .array(
      z.enum([
        "technical_article",
        "paper",
        "release",
        "news",
        "essay",
        "discussion",
      ]),
    )
    .min(1)
    .max(6),
  criteria: z
    .array(
      z.strictObject({
        dimension: id,
        weight: z.number().finite().min(0).max(100),
      }),
    )
    .min(1)
    .max(50),
  presentation: labels,
});
export const profileSchema = z.discriminatedUnion("kind", [
  interestSchema,
  editorialSchema,
]);
export type Profile = z.infer<typeof profileSchema>;
export type Interest = z.infer<typeof interestSchema>;
export class ProfileStore {
  constructor(private db: Database) {}
  import(input: unknown): Profile[] {
    const parsed = z.array(profileSchema).parse(input);
    return this.db
      .transaction(() => {
        let changed = false;
        for (const p of parsed) {
          const existing = this.get(p.kind, p.id, p.version);
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(p))
              throw new Error("Profile version is immutable");
            continue;
          }
          const row = this.db
            .query<{ version: number }, [string, string]>(
              "SELECT max(version) AS version FROM profiles WHERE kind=? AND id=?",
            )
            .get(p.kind, p.id);
          if (p.version !== (row?.version ?? 0) + 1)
            throw new Error("Profile versions must be consecutive");
          this.db
            .query(
              "INSERT INTO profiles(kind,id,version,document) VALUES(?,?,?,?)",
            )
            .run(p.kind, p.id, p.version, JSON.stringify(p));
          changed = true;
        }
        if (changed) invalidateScores(this.db, Date.now());
        return parsed;
      })
      .immediate();
  }
  get(kind: Profile["kind"], id: string, version: number): Profile | null {
    const row = this.db
      .query<{ document: string }, [string, string, number]>(
        "SELECT document FROM profiles WHERE kind=? AND id=? AND version=?",
      )
      .get(kind, id, version);
    return row ? profileSchema.parse(JSON.parse(row.document)) : null;
  }
  export(): Profile[] {
    return this.db
      .query<{ document: string }, []>(
        "SELECT document FROM profiles ORDER BY kind,id,version",
      )
      .all()
      .map((row) => profileSchema.parse(JSON.parse(row.document)));
  }
  latestEditorial(): z.infer<typeof editorialSchema>[] {
    return this.db
      .query<{ document: string }, []>(
        "SELECT p.document FROM profiles p WHERE p.kind='editorial' AND p.version=(SELECT max(q.version) FROM profiles q WHERE q.kind=p.kind AND q.id=p.id) ORDER BY p.id",
      )
      .all()
      .map((row) => editorialSchema.parse(JSON.parse(row.document)));
  }
  activeInterests(now = Date.now()): Interest[] {
    return this.db
      .query<{ document: string }, []>(
        "SELECT p.document FROM profiles p WHERE p.kind='interest' AND p.version=(SELECT max(q.version) FROM profiles q WHERE q.kind=p.kind AND q.id=p.id) ORDER BY p.id",
      )
      .all()
      .map((row) => interestSchema.parse(JSON.parse(row.document)))
      .filter((p) => p.lifetime === "persistent" || p.expiresAt! > now);
  }
}
