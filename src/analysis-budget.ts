import type { Database } from "bun:sqlite";
import { PURGED_ANALYSIS } from "./retention";

export class AnalysisBudget {
  constructor(
    private db: Database,
    private limits: {
      maxTokens: number;
      maxMicros: number;
      maxDailyMicros?: number | null;
      maxConcurrent: number;
    },
    private clock: () => number = Date.now,
  ) {
    if (
      ![limits.maxTokens, limits.maxMicros, limits.maxConcurrent].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      (limits.maxDailyMicros != null &&
        !(
          Number.isSafeInteger(limits.maxDailyMicros) &&
          limits.maxDailyMicros > 0
        ))
    )
      throw new Error("Invalid budget limits");
  }
  /** UTC day index used for the per-day ceiling, matching discovery's budget_day. */
  private day(): number {
    return Math.floor(this.clock() / 86_400_000);
  }
  reserve(key: string, tokens: number, micros: number): boolean {
    if (
      !key ||
      ![tokens, micros].every((n) => Number.isSafeInteger(n) && n > 0)
    )
      throw new Error("Invalid budget reservation");
    const day = this.day();
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
        if (this.limits.maxDailyMicros != null) {
          const today = this.db
            .query<{ micros: number }, [number]>(
              "SELECT coalesce(sum(micros),0) micros FROM analysis_reservations WHERE budget_day=?",
            )
            .get(day)!;
          if (today.micros + micros > this.limits.maxDailyMicros) return false;
        }
        return (
          this.db
            .query(
              "INSERT OR IGNORE INTO analysis_reservations(key,tokens,micros,status,budget_day) VALUES(?,?,?,'reserved',?)",
            )
            .run(key, tokens, micros, day).changes === 1
        );
      })
      .immediate();
  }
  /** Read-only UTC-day usage for the current day; zero when no daily ceiling is configured. */
  dailyUsage(): { day: number; micros: number } {
    const day = this.day();
    const row = this.db
      .query<{ micros: number }, [number]>(
        "SELECT coalesce(sum(micros),0) micros FROM analysis_reservations WHERE budget_day=?",
      )
      .get(day)!;
    return { day, micros: row.micros };
  }
  /** A purged (retention-removed) result is not a cache entry and is never returned. */
  result(key: string): string | null {
    const result =
      this.db
        .query<{ result: string | null }, [string]>(
          "SELECT result FROM analysis_reservations WHERE key=? AND status='settled'",
        )
        .get(key)?.result ?? null;
    return result === null || result === PURGED_ANALYSIS ? null : result;
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
