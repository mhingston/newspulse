import { describe, expect, test } from "bun:test";
import {
  duePublications,
  localPublicationDate,
  publicationInstant,
} from "../src/publication-schedule";

const london = { timezone: "Europe/London", hour: 6, minute: 0 };
const time = (s: string) => Date.parse(s);

describe("daily publication calendar", () => {
  test("uses the local timezone across London clock changes", () => {
    expect(publicationInstant("2026-03-28", london)).toBe(
      time("2026-03-28T06:00:00Z"),
    );
    expect(publicationInstant("2026-03-29", london)).toBe(
      time("2026-03-29T05:00:00Z"),
    );
    expect(publicationInstant("2026-10-25", london)).toBe(
      time("2026-10-25T06:00:00Z"),
    );
    expect(
      publicationInstant("2026-03-29", { ...london, hour: 1, minute: 30 }),
    ).toBe(time("2026-03-29T01:00:00Z"));
    expect(
      publicationInstant("2026-10-25", { ...london, hour: 1, minute: 30 }),
    ).toBe(time("2026-10-25T00:30:00Z"));
  });
  test("enumerates bounded downtime catch-up and waits for today's due time", () => {
    expect(
      duePublications(
        "2026-03-28",
        time("2026-03-30T04:59:00Z"),
        london,
        10,
      ).map((x) => x.date),
    ).toEqual(["2026-03-28", "2026-03-29"]);
    expect(
      duePublications(
        "2026-03-28",
        time("2026-03-30T05:00:00Z"),
        london,
        2,
      ).map((x) => x.date),
    ).toEqual(["2026-03-28", "2026-03-29"]);
    expect(
      duePublications("2026-03-30", time("2026-03-30T05:00:00Z"), london),
    ).toEqual([{ date: "2026-03-30", dueAt: time("2026-03-30T05:00:00Z") }]);
  });
  test("supports other zones and skipped civil days", () => {
    expect(
      localPublicationDate(time("2026-01-01T01:00:00Z"), "America/New_York"),
    ).toBe("2025-12-31");
    expect(
      publicationInstant("2011-12-30", {
        timezone: "Pacific/Apia",
        hour: 6,
        minute: 0,
      }),
    ).toBeNull();
    expect(() => publicationInstant("2026-02-30", london)).toThrow();
    expect(() =>
      publicationInstant("2026-01-01", { ...london, timezone: "invalid" }),
    ).toThrow();
  });
});

import { Database } from "bun:sqlite";
import { runPublicationSchedule } from "../src/publication-schedule";

describe("durable publication schedule", () => {
  function database() {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE publication_schedule_state(id INTEGER PRIMARY KEY, next_date TEXT NOT NULL, timezone TEXT NOT NULL, hour INTEGER NOT NULL, minute INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE publication_schedule_history(date TEXT PRIMARY KEY, due_at INTEGER, status TEXT NOT NULL, recorded_at INTEGER NOT NULL);
      CREATE TABLE outbox(date TEXT PRIMARY KEY);`);
    return db;
  }
  test("records downtime without fabricating past editions and retries processing", () => {
    const db = database();
    const opts = { ...london, firstDate: "2026-03-28" };
    const now = time("2026-03-30T05:00:00Z");
    expect(
      runPublicationSchedule(
        db,
        opts,
        (_date, _now, historical) => (historical ? "skipped" : "processing"),
        now,
      ),
    ).toEqual([
      { date: "2026-03-28", status: "skipped" },
      { date: "2026-03-29", status: "skipped" },
      { date: "2026-03-30", status: "processing" },
    ]);
    expect(runPublicationSchedule(db, opts, () => "empty", now)).toEqual([
      { date: "2026-03-30", status: "empty" },
    ]);
    expect(
      runPublicationSchedule(
        db,
        opts,
        () => {
          throw Error("already processed");
        },
        now,
      ),
    ).toEqual([]);
    db.close();
  });
  test("allows a missed date with an existing frozen edition to be prepared", () => {
    const db = database();
    const now = time("2026-03-30T05:00:00Z");
    expect(
      runPublicationSchedule(
        db,
        { ...london, firstDate: "2026-03-29" },
        (date, _now, historical) => {
          if (historical && date === "2026-03-29") return "prepared";
          return "empty";
        },
        now,
      ),
    ).toEqual([
      { date: "2026-03-29", status: "prepared" },
      { date: "2026-03-30", status: "empty" },
    ]);
    db.close();
  });
  test("rolls back a failed preparation and advances atomically with an outbox", () => {
    const db = database();
    const now = time("2026-05-01T06:00:00Z");
    expect(() =>
      runPublicationSchedule(
        db,
        london,
        (date) => {
          db.query("INSERT INTO outbox VALUES(?)").run(date);
          throw Error("crash");
        },
        now,
      ),
    ).toThrow();
    expect(db.query("SELECT * FROM outbox").all()).toEqual([]);
    expect(
      runPublicationSchedule(
        db,
        london,
        (date) => {
          db.query("INSERT INTO outbox VALUES(?)").run(date);
          return "prepared";
        },
        now,
      ),
    ).toEqual([{ date: "2026-05-01", status: "prepared" }]);
    expect(
      runPublicationSchedule(
        db,
        london,
        () => {
          throw Error("duplicate");
        },
        now,
      ),
    ).toEqual([]);
    expect(db.query("SELECT * FROM outbox").all()).toEqual([
      { date: "2026-05-01" },
    ]);
    db.close();
  });
});
