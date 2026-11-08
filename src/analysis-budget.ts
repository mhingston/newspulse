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
        if (
          this.db
            .query(
              "SELECT 1 FROM analysis_control WHERE id=1 AND envelope_breach=1",
            )
            .get()
        )
          return false;
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
  result(key: string): string | null {
    return (
      this.db
        .query<{ result: string | null }, [string]>(
          "SELECT result FROM analysis_reservations WHERE key=? AND status='settled'",
        )
        .get(key)?.result ?? null
    );
  }
  finish(key: string, result: string, tokens: number | null): boolean {
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0))
      throw new Error("Invalid usage");
    return this.db
      .transaction(() => {
        const reservation = this.db
          .query<{ tokens: number }, [string]>(
            "SELECT tokens FROM analysis_reservations WHERE key=? AND status='reserved'",
          )
          .get(key);
        if (!reservation) return false;
        if (tokens !== null && tokens > reservation.tokens)
          this.db
            .query(
              "INSERT INTO analysis_control(id,envelope_breach) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET envelope_breach=1",
            )
            .run();
        return (
          this.db
            .query(
              "UPDATE analysis_reservations SET tokens=coalesce(?,tokens),status='settled',result=? WHERE key=? AND status='reserved'",
            )
            .run(tokens, result, key).changes === 1
        );
      })
      .immediate();
  }
  acknowledgeEnvelopeBreach(): boolean {
    return (
      this.db
        .query(
          "UPDATE analysis_control SET envelope_breach=0 WHERE id=1 AND envelope_breach=1",
        )
        .run().changes === 1
    );
  }
  reconcile(key: string): boolean {
    return (
      this.db
        .query(
          "UPDATE analysis_reservations SET key=?,status='reconciled' WHERE key=? AND status='reserved'",
        )
        .run(`${key}:reconciled:${crypto.randomUUID()}`, key).changes === 1
    );
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
