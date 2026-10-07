// Wall-clock routines: the time of day holds across daylight saving, weekday
// sets skip the days they leave out, and the words match the runs.
import { describe, expect, test } from "bun:test";
import { cadenceAt, nextCadenceRun, plainCadence, plainDays, weekdayNumbers } from "./cadence";
import { zonedInstant, wallClockAt } from "./zone";
import { approvalContext } from "./rules";

const NY = "America/New_York";
const iso = (t: number) => new Date(t).toISOString();

describe("zonedInstant", () => {
  test("a clock time on either side of a change", () => {
    expect(iso(zonedInstant("2026-10-30", 8 * 60, NY))).toBe("2026-10-30T12:00:00.000Z");
    expect(iso(zonedInstant("2026-11-02", 8 * 60, NY))).toBe("2026-11-02T13:00:00.000Z");
  });
  test("a repeated hour answers with its first occurrence, a skipped one after the jump", () => {
    expect(iso(zonedInstant("2026-11-01", 90, NY))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(zonedInstant("2027-03-14", 150, NY))).toBe("2027-03-14T07:30:00.000Z");
  });
  test("half-hour zones and UTC", () => {
    expect(iso(zonedInstant("2026-10-02", 0, "Asia/Kolkata"))).toBe("2026-10-01T18:30:00.000Z");
    expect(iso(zonedInstant("2026-10-02", 61, undefined))).toBe("2026-10-02T01:01:00.000Z");
  });
});

describe("nextCadenceRun", () => {
  test("every day at 8 stays at 8 through the November change", () => {
    const cadence = cadenceAt(Date.parse("2026-10-30T12:00:00Z"), NY);
    let at = Date.parse("2026-10-30T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      at = nextCadenceRun(cadence, at);
      expect(wallClockAt(at, NY).minutes).toBe(8 * 60);
    }
    expect(iso(at)).toBe("2026-11-04T13:00:00.000Z");
  });
  test("weekdays skip Saturday and Sunday", () => {
    const cadence = cadenceAt(Date.parse("2026-10-09T12:00:00Z"), NY, weekdayNumbers(["mon", "tue", "wed", "thu", "fri"]));
    const friday = Date.parse("2026-10-09T12:00:00Z");
    expect(iso(nextCadenceRun(cadence, friday))).toBe("2026-10-12T12:00:00.000Z");
    expect(iso(nextCadenceRun(cadence, friday - 1))).toBe(iso(friday));
  });
  test("a weekly cadence finds the next listed day, today included when its time is ahead", () => {
    const sunday6pm = cadenceAt(Date.parse("2026-10-11T22:00:00Z"), NY, [0]);
    expect(iso(nextCadenceRun(sunday6pm, Date.parse("2026-10-11T15:00:00Z")))).toBe("2026-10-11T22:00:00.000Z");
    expect(iso(nextCadenceRun(sunday6pm, Date.parse("2026-10-11T22:00:00Z")))).toBe("2026-10-18T22:00:00.000Z");
  });
});

describe("words", () => {
  test("days as a person says them", () => {
    expect(plainDays([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(plainDays([1, 2, 3, 4, 5])).toBe("weekdays");
    expect(plainDays([6, 0])).toBe("weekends");
    expect(plainDays([1])).toBe("every Monday");
    expect(plainDays([1, 3, 5])).toBe("Mondays, Wednesdays and Fridays");
    expect(weekdayNumbers(["Monday", "fri", "nope", "mon"])).toEqual([1, 5]);
  });
  test("a cadence line", () => {
    expect(plainCadence({ zone: NY, minutes: 8 * 60, weekdays: [1, 2, 3, 4, 5] })).toBe("weekdays at 8:00 AM");
    expect(plainCadence({ zone: NY, minutes: 18 * 60 + 30, weekdays: [0] })).toBe("every Sunday at 6:30 PM");
    expect(plainCadence({ zone: NY, minutes: 0, weekdays: [] })).toBe("every day at 12:00 AM");
  });
  test("the approval card says the weekdays and the first real run", () => {
    const now = Date.parse("2026-10-07T03:00:00Z");
    const md = approvalContext({ instruction: "Send you a short news summary", first_run: "2026-10-10T08:00:00-04:00", days: ["mon", "tue", "wed", "thu", "fri"] }, { timezone: NY, now });
    expect(md).toContain("**When:** Weekdays at 8:00 AM, starting Monday, October 12");
    expect(md).not.toContain("Days");
  });
});
