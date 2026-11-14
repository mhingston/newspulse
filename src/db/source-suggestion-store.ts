import type { Database } from "bun:sqlite";
import type { SourceSuggestion } from "../source-suggestions";

export type SourceSuggestionState =
  "proposed" | "accepted" | "dismissed" | "muted";

export interface SourceSuggestionRecord extends SourceSuggestion {
  state: SourceSuggestionState;
  acceptedSourceId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StateChange {
  state: SourceSuggestionState;
  /** False on a replay of the same decision; also resets an accepted-source link. */
  changed: boolean;
  acceptedSourceId: string | null;
}

const states: ReadonlySet<string> = new Set([
  "proposed",
  "accepted",
  "dismissed",
  "muted",
]);

function parseExploration(explanation: string): SourceSuggestion {
  return JSON.parse(explanation) as SourceSuggestion;
}

/**
 * Persistence for explicit source suggestions. Regeneration upserts evidence
 * idempotently and never resets an operator decision; state transitions are
 * recorded once, so replaying the same accept/dismiss/mute is a no-op.
 */
export class SourceSuggestionStore {
  constructor(private readonly db: Database) {}

  /** Insert or refresh suggestions; ordered deterministically by caller. */
  upsert(
    suggestions: readonly SourceSuggestion[],
    now: number,
  ): {
    saved: number;
    refreshed: number;
  } {
    if (suggestions.length === 0) return { saved: 0, refreshed: 0 };
    return this.db.transaction(() => {
      let saved = 0;
      let refreshed = 0;
      const get = this.db.query<{ explanation: string }, [string]>(
        "SELECT explanation FROM source_suggestions WHERE id=?",
      );
      const insert = this.db.query(
        `INSERT INTO source_suggestions
          (id,kind,domain,url,title,score,state,explanation,accepted_source_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?, 'proposed', ?, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind=excluded.kind, domain=excluded.domain, url=excluded.url,
          title=excluded.title, score=excluded.score, explanation=excluded.explanation,
          updated_at=excluded.updated_at`,
      );
      for (const suggestion of suggestions) {
        const previous = get.get(suggestion.id);
        insert.run(
          suggestion.id,
          suggestion.kind,
          suggestion.domain,
          suggestion.url,
          suggestion.title,
          suggestion.score,
          JSON.stringify(suggestion),
          now,
          now,
        );
        if (previous) {
          const before = parseExploration(previous.explanation);
          // Evidence refresh is only a change when content actually moved,
          // so regeneration replay stays idempotent end to end.
          if (JSON.stringify(before) !== JSON.stringify(suggestion))
            refreshed++;
        } else saved++;
      }
      return { saved, refreshed };
    })();
  }

  list(state?: SourceSuggestionState): SourceSuggestionRecord[] {
    if (state !== undefined && !states.has(state))
      throw new Error("Invalid suggestion state");
    const rows = state
      ? this.db
          .query<Row, [string]>(
            "SELECT * FROM source_suggestions WHERE state=? ORDER BY score DESC, id",
          )
          .all(state)
      : this.db
          .query<Row, []>(
            "SELECT * FROM source_suggestions ORDER BY score DESC, id",
          )
          .all();
    return rows.map(hydrate);
  }

  get(id: string): SourceSuggestionRecord | undefined {
    const row = this.db
      .query<Row, [string]>("SELECT * FROM source_suggestions WHERE id=?")
      .get(id);
    return row ? hydrate(row) : undefined;
  }

  /**
   * Apply an explicit state decision. Transitions are idempotent: repeating
   * the current decision changes nothing and records no extra event. Accepting
   * a dismissed suggestion is allowed; a muted suggestion must be unmuted
   * explicitly so a muted suggestion can never be silently followed.
   */
  setState(
    id: string,
    to: Exclude<SourceSuggestionState, "proposed"> | "proposed",
    now: number,
    acceptedSourceId?: string,
  ): StateChange {
    const current = this.get(id);
    if (!current) throw new Error("Unknown source suggestion");
    if (!states.has(to)) throw new Error("Invalid suggestion state");
    if (current.state === to) {
      if (
        to === "accepted" &&
        acceptedSourceId &&
        current.acceptedSourceId !== acceptedSourceId
      )
        throw new Error("Accepted suggestion cannot change sources");
      return {
        state: current.state,
        changed: false,
        acceptedSourceId: current.acceptedSourceId,
      };
    }
    if (current.state === "accepted" && to !== "muted")
      throw new Error(
        "Accepted suggestion cannot be re-decided except to mute",
      );
    if (current.state === "muted" && to === "accepted")
      throw new Error("Muted suggestion cannot be accepted");
    this.db.transaction(() => {
      const from = current.state;
      this.db
        .query(
          "UPDATE source_suggestions SET state=?, accepted_source_id=?, updated_at=? WHERE id=?",
        )
        .run(
          to,
          to === "accepted" ? (acceptedSourceId ?? null) : null,
          now,
          id,
        );
      this.db
        .query(
          "INSERT INTO source_suggestion_events(suggestion_id,from_state,to_state,at) VALUES(?,?,?,?)",
        )
        .run(id, from, to, now);
    })();
    return {
      state: to,
      changed: true,
      acceptedSourceId: to === "accepted" ? (acceptedSourceId ?? null) : null,
    };
  }
}

interface Row {
  id: string;
  kind: string;
  domain: string;
  url: string;
  title: string;
  score: number;
  state: string;
  explanation: string;
  accepted_source_id: string | null;
  created_at: number;
  updated_at: number;
}

function hydrate(row: Row): SourceSuggestionRecord {
  if (!states.has(row.state)) throw new Error("Corrupt suggestion state");
  return {
    ...parseExploration(row.explanation),
    // Persisted columns win over stale captured JSON.
    id: row.id,
    kind: row.kind as SourceSuggestion["kind"],
    domain: row.domain,
    url: row.url,
    title: row.title,
    score: row.score,
    state: row.state as SourceSuggestionState,
    acceptedSourceId: row.accepted_source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
