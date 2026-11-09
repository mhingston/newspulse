/** Calendar arithmetic for daily publication. No process-local timezone is used. */
export interface PublicationSchedule {
  timezone: string;
  hour: number;
  minute: number;
}

function formatter(timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error("Invalid publication timezone");
  }
}

function calendar(timestamp: number, format: Intl.DateTimeFormat) {
  const parts = format.formatToParts(new Date(timestamp));
  const get = (name: string) =>
    Number(parts.find((p) => p.type === name)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function parseDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("Invalid edition date");
  const value = Date.parse(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(value) ||
    new Date(value).toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid edition date");
  return value;
}

export function localPublicationDate(now: number, timezone: string): string {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid publication time");
  const c = calendar(now, formatter(timezone));
  return `${String(c.year).padStart(4, "0")}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
}

/** The first occurrence of a repeated local time wins. A nonexistent time moves
 * forward to the first valid minute on that same calendar day. A wholly skipped
 * local day has no occurrence. */
export function publicationInstant(
  date: string,
  schedule: PublicationSchedule,
): number | null {
  const midnight = parseDate(date);
  if (
    !Number.isInteger(schedule.hour) ||
    schedule.hour < 0 ||
    schedule.hour > 23 ||
    !Number.isInteger(schedule.minute) ||
    schedule.minute < 0 ||
    schedule.minute > 59
  )
    throw new Error("Invalid publication clock time");
  const format = formatter(schedule.timezone);
  // All timezone offsets in force around this date, including either side of a transition.
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const at = midnight + h * 3_600_000;
    const c = calendar(at, format);
    offsets.add(Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute) - at);
  }
  const target = schedule.hour * 60 + schedule.minute;
  for (let minute = target; minute < 1440; minute++) {
    const wall = midnight + minute * 60_000;
    const candidates: number[] = [];
    for (const offset of offsets) {
      const instant = wall - offset;
      const c = calendar(instant, format);
      if (Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute) === wall)
        candidates.push(instant);
    }
    if (candidates.length) return Math.min(...candidates);
  }
  return null;
}

/** Enumerate due calendar identities in order. Persist each completed identity
 * before advancing the cursor; null instants represent skipped civil dates. */
export function duePublications(
  firstDate: string,
  now: number,
  schedule: PublicationSchedule,
  limit = 31,
): { date: string; dueAt: number | null }[] {
  const first = parseDate(firstDate);
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 366
  )
    throw new Error("Invalid publication scan");
  const today = localPublicationDate(now, schedule.timezone);
  const result: { date: string; dueAt: number | null }[] = [];
  for (let day = first; result.length < limit; day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (date > today) break;
    const dueAt = publicationInstant(date, schedule);
    if (dueAt !== null && dueAt > now) break;
    result.push({ date, dueAt });
  }
  return result;
}

export type PreparationResult = "prepared" | "empty" | "processing" | "skipped";
export interface PublicationRunOptions extends PublicationSchedule {
  /** First date to consider on first enablement; defaults to the current local date. */
  firstDate?: string;
  limit?: number;
}

/**
 * Advances the durable calendar in short immediate transactions. `prepare` must
 * be synchronous, database-only work, and atomically freeze/enqueue an edition
 * on this same connection. It must not contact a provider. An unfinished draft
 * leaves the cursor in place for the next wake-up. Historical dates must only
 * prepare an already-frozen edition; the callback records other dates skipped.
 */
export function runPublicationSchedule(
  db: import("bun:sqlite").Database,
  options: PublicationRunOptions,
  prepare: (
    date: string,
    now: number,
    isHistorical: boolean,
  ) => PreparationResult,
  now = Date.now(),
): { date: string; status: "prepared" | "empty" | "processing" | "skipped" }[] {
  const today = localPublicationDate(now, options.timezone);
  // Validate before persisting the configuration, even when nothing is due.
  publicationInstant(today, options);
  const firstDate = options.firstDate ?? today;
  parseDate(firstDate);
  const limit = options.limit ?? 31;
  if (!Number.isInteger(limit) || limit < 1 || limit > 366)
    throw new Error("Invalid publication scan");
  const events: {
    date: string;
    status: "prepared" | "empty" | "processing" | "skipped";
  }[] = [];
  for (let i = 0; i < limit; i++) {
    const event = db
      .transaction(() => {
        db.query(
          `INSERT OR IGNORE INTO publication_schedule_state
        (id,next_date,timezone,hour,minute,updated_at) VALUES(1,?,?,?,?,?)`,
        ).run(firstDate, options.timezone, options.hour, options.minute, now);
        const state = db
          .query<{ next_date: string }, []>(
            "SELECT next_date FROM publication_schedule_state WHERE id=1",
          )
          .get()!;
        const due = duePublications(state.next_date, now, options, 1)[0];
        db.query(
          "UPDATE publication_schedule_state SET timezone=?,hour=?,minute=?,updated_at=? WHERE id=1",
        ).run(options.timezone, options.hour, options.minute, now);
        if (!due) return null;
        const status =
          due.dueAt === null
            ? ("skipped" as const)
            : prepare(due.date, now, due.date !== today);
        if (status === "processing") return { date: due.date, status };
        if (status !== "skipped" && status !== "empty" && status !== "prepared")
          throw new Error("Invalid publication preparation result");
        db.query(
          "INSERT INTO publication_schedule_history(date,due_at,status,recorded_at) VALUES(?,?,?,?)",
        ).run(due.date, due.dueAt, status, now);
        const nextDate = new Date(parseDate(due.date) + 86_400_000)
          .toISOString()
          .slice(0, 10);
        db.query(
          "UPDATE publication_schedule_state SET next_date=?,updated_at=? WHERE id=1",
        ).run(nextDate, now);
        return { date: due.date, status };
      })
      .immediate();
    if (!event) break;
    events.push(event);
    if (event.status === "processing") break;
  }
  return events;
}
