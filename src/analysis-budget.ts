import type { Database } from "bun:sqlite";
export class AnalysisBudget {
  constructor(
    private db: Database,
    private limits: {
      maxTokens: number;
      maxMicros: number;
      maxConcurrent: number;
    },
  ) {
    if (
      ![limits.maxTokens, limits.maxMicros, limits.maxConcurrent].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    )
      throw new Error("Invalid budget limits");
  }
  reserve(key: string, tokens: number, micros: number): boolean {
    if (
      !key ||
      ![tokens, micros].every((n) => Number.isSafeInteger(n) && n > 0)
    )
      throw new Error("Invalid budget reservation");
    return this.db
      .transaction(() => {
        const totals = this.db
          .query<{ tokens: number; micros: number; active: number }, []>(
            "SELECT coalesce(sum(tokens),0) tokens,coalesce(sum(micros),0) micros,coalesce(sum(status='reserved'),0) active FROM analysis_reservations",
          )
          .get()!;
        if (
          totals.tokens + tokens > this.limits.maxTokens ||
          totals.micros + micros > this.limits.maxMicros ||
          totals.active >= this.limits.maxConcurrent
        )
          return false;
        return (
          this.db
            .query(
              "INSERT OR IGNORE INTO analysis_reservations(key,tokens,micros,status) VALUES(?,?,?,'reserved')",
            )
            .run(key, tokens, micros).changes === 1
        );
      })
      .immediate();
  }
  settle(key: string, usage: { tokens: number; micros: number }): boolean {
    if (
      ![usage.tokens, usage.micros].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw new Error("Invalid usage");
    return (
      this.db
        .query(
          "UPDATE analysis_reservations SET tokens=?,micros=?,status='settled' WHERE key=? AND status='reserved' AND tokens>=? AND micros>=?",
        )
        .run(usage.tokens, usage.micros, key, usage.tokens, usage.micros)
        .changes === 1
    );
  }
}
