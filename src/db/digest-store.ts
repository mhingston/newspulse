import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface FrozenDigestInput {
  date: string;
  timezone: string;
  subject: string;
  html: string;
  text: string;
  decisionSnapshot: unknown;
  items: {
    itemId: string;
    groupId: string | null;
    scoreId: string | null;
    snapshot: unknown;
  }[];
}

/** A frozen edition records a prepared artifact, never delivery or readership. */
export class DigestStore {
  constructor(private readonly db: Database) {}
  freeze(input: FrozenDigestInput, now = Date.now()) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date)
      ? new Date(input.date + "T00:00:00Z")
      : new Date(NaN);
    if (
      !Number.isFinite(date.valueOf()) ||
      date.toISOString().slice(0, 10) !== input.date
    )
      throw new Error("Invalid edition date");
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    } catch {
      throw new Error("Invalid edition timezone");
    }
    if (
      !input.subject.trim() ||
      input.subject.length > 1000 ||
      input.html.length > 5_000_000 ||
      input.text.length > 5_000_000 ||
      !Number.isSafeInteger(now) ||
      input.items.length < 1 ||
      input.items.length > 1000
    )
      throw new Error("Invalid frozen edition");
    if (
      new Set(input.items.map((item) => item.itemId)).size !==
        input.items.length ||
      input.items.some(
        (item) =>
          !item.itemId ||
          (item.groupId !== null && !item.groupId) ||
          (item.scoreId !== null && !item.scoreId),
      )
    )
      throw new Error("Invalid or duplicate digest item");
    const encoded = JSON.stringify(input);
    if (
      encoded === undefined ||
      encoded.length > 10_000_000 ||
      input.decisionSnapshot === undefined ||
      input.items.some((item) => item.snapshot === undefined)
    )
      throw new Error("Invalid digest snapshot");
    const fingerprint = createHash("sha256").update(encoded).digest("hex");
    return this.db
      .transaction(() => {
        const prior = this.db
          .query<{ fingerprint: string }, [string]>(
            "SELECT fingerprint FROM digests WHERE edition_date=? AND sealed=1",
          )
          .get(input.date);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new Error(
              "Edition date already frozen with different content",
            );
          return this.get(input.date)!;
        }
        const id = crypto.randomUUID();
        this.db
          .query(
            "INSERT INTO digests(id,edition_date,timezone,subject,html,plain_text,decisions,fingerprint,frozen_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            input.date,
            input.timezone,
            input.subject,
            input.html,
            input.text,
            JSON.stringify(input.decisionSnapshot),
            fingerprint,
            now,
          );
        const insert = this.db.query(
          "INSERT INTO digest_items(digest_id,position,item_id,group_id,score_id,snapshot) VALUES(?,?,?,?,?,?)",
        );
        for (const [position, item] of input.items.entries())
          insert.run(
            id,
            position,
            item.itemId,
            item.groupId,
            item.scoreId,
            JSON.stringify(item.snapshot),
          );
        this.db.query("UPDATE digests SET sealed=1 WHERE id=?").run(id);
        return this.get(input.date)!;
      })
      .immediate();
  }
  get(date: string) {
    const row = this.db
      .query<
        {
          id: string;
          edition_date: string;
          timezone: string;
          subject: string;
          html: string;
          plain_text: string;
          decisions: string;
          fingerprint: string;
          frozen_at: number;
        },
        [string]
      >(
        "SELECT id,edition_date,timezone,subject,html,plain_text,decisions,fingerprint,frozen_at FROM digests WHERE edition_date=? AND sealed=1",
      )
      .get(date);
    if (!row) return null;
    const items = this.db
      .query<
        {
          position: number;
          item_id: string;
          group_id: string | null;
          score_id: string | null;
          snapshot: string;
        },
        [string]
      >(
        "SELECT position,item_id,group_id,score_id,snapshot FROM digest_items WHERE digest_id=? ORDER BY position",
      )
      .all(row.id)
      .map((item) => ({
        ...item,
        snapshot: JSON.parse(item.snapshot) as unknown,
      }));
    return { ...row, decisions: JSON.parse(row.decisions) as unknown, items };
  }
}
