// Days and wall clocks in a zone: missing and unknown zones, half-hour
// zones, exact edges, and the DST days that run 23 or 25 hours.
import { describe, expect, test } from "bun:test";
import { addDays, dayBounds, normalizeTimezone, wallClockAt, zonedDay } from "./zone";

const HOUR = 60 * 60 * 1000;
const iso = (t: number) => new Date(t).toISOString();

describe("zonedDay", () => {
  test("UTC when the zone is missing or not a real zone", () => {
    for (const zone of [undefined, null, "", "Not/AZone"]) {
      const day = zonedDay(Date.parse("2026-10-02T23:59:59Z"), zone);
      expect(day).toEqual({
        date: "2026-10-02",
        start: Date.parse("2026-10-02T00:00:00Z"),
        end: Date.parse("2026-10-03T00:00:00Z"),
        timezone: "UTC",
      });
    }
    expect(normalizeTimezone("America/Los_Angeles")).toBe("America/Los_Angeles");
  });

  test("an instant west of UTC lands on the local date, with local bounds", () => {
    const day = zonedDay(Date.parse("2026-10-03T03:00:00Z"), "America/Los_Angeles");
    expect(day.date).toBe("2026-10-02");
    expect(iso(day.start)).toBe("2026-10-02T07:00:00.000Z");
    expect(iso(day.end)).toBe("2026-10-03T07:00:00.000Z");
  });

  test("a half-hour zone east of UTC", () => {
    const day = zonedDay(Date.parse("2026-10-02T19:00:00Z"), "Asia/Kolkata");
    expect(day.date).toBe("2026-10-03");
    expect(iso(day.start)).toBe("2026-10-02T18:30:00.000Z");
  });

  test("bounds are exact at the edges: start is in, end is out", () => {
    const { start, end } = dayBounds("2026-10-02", "America/New_York");
    expect(zonedDay(start, "America/New_York").date).toBe("2026-10-02");
    expect(zonedDay(start - 1, "America/New_York").date).toBe("2026-10-01");
    expect(zonedDay(end - 1, "America/New_York").date).toBe("2026-10-02");
    expect(zonedDay(end, "America/New_York").date).toBe("2026-10-03");
  });
});

describe("DST boundaries", () => {
  test("spring forward makes a 23 hour day", () => {
    const day = dayBounds("2026-03-08", "America/New_York");
    expect(iso(day.start)).toBe("2026-03-08T05:00:00.000Z");
    expect(iso(day.end)).toBe("2026-03-09T04:00:00.000Z");
    expect(day.end - day.start).toBe(23 * HOUR);
  });

  test("fall back makes a 25 hour day", () => {
    const day = dayBounds("2026-11-01", "America/New_York");
    expect(iso(day.start)).toBe("2026-11-01T04:00:00.000Z");
    expect(iso(day.end)).toBe("2026-11-02T05:00:00.000Z");
    expect(day.end - day.start).toBe(25 * HOUR);
    // Both 01:30s of the repeated hour belong to the same day.
    expect(zonedDay(Date.parse("2026-11-01T05:30:00Z"), "America/New_York").date).toBe("2026-11-01");
    expect(zonedDay(Date.parse("2026-11-01T06:30:00Z"), "America/New_York").date).toBe("2026-11-01");
  });

  test("a skipped midnight starts the day when the clocks jump", () => {
    // Santiago springs forward at 00:00 on 2026-09-06: local midnight never
    // happens, and the day starts at 01:00 local (04:00Z).
    const day = dayBounds("2026-09-06", "America/Santiago");
    expect(iso(day.start)).toBe("2026-09-06T04:00:00.000Z");
    expect(dayBounds("2026-09-05", "America/Santiago").end).toBe(day.start);
    expect(day.end - day.start).toBe(23 * HOUR);
  });

  test("a repeated hour before midnight makes the previous day 25 hours", () => {
    // Santiago falls back at 24:00 on 2026-04-04 to 23:00, so 23:xx happens
    // twice on the 4th and the 5th starts once, at 04:00Z.
    const before = dayBounds("2026-04-04", "America/Santiago");
    const day = dayBounds("2026-04-05", "America/Santiago");
    expect(iso(day.start)).toBe("2026-04-05T04:00:00.000Z");
    expect(before.end).toBe(day.start);
    expect(before.end - before.start).toBe(25 * HOUR);
  });

  test("consecutive days tile the year with no gap or overlap", () => {
    let date = "2026-01-01";
    let prev = dayBounds(date, "Europe/London");
    for (let i = 0; i < 365; i++) {
      date = addDays(date, 1);
      const next = dayBounds(date, "Europe/London");
      expect(next.start).toBe(prev.end);
      prev = next;
    }
    expect(date).toBe("2027-01-01");
  });
});

describe("wallClockAt", () => {
  test("reads the local date, minutes and weekday, and an unknown zone as UTC", () => {
    // 2026-11-02 08:30Z: Los Angeles is back on UTC-8 by then, so it is 00:30 Monday there.
    expect(wallClockAt(Date.parse("2026-11-02T08:30:00Z"), "America/Los_Angeles")).toEqual({ date: "2026-11-02", minutes: 30, weekday: 1 });
    expect(wallClockAt(Date.parse("2026-10-05T23:15:00Z"), "Asia/Tokyo")).toEqual({ date: "2026-10-06", minutes: 8 * 60 + 15, weekday: 2 });
    expect(wallClockAt(Date.parse("2026-10-05T23:15:00Z"), "Not/AZone")).toEqual({ date: "2026-10-05", minutes: 23 * 60 + 15, weekday: 1 });
  });
});

describe("addDays", () => {
  test("crosses months, years and leap days", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-10-02", -13)).toBe("2026-09-19");
  });
});
