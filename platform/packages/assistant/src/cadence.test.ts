// Wall-clock routines: the time of day holds across daylight saving, weekday
// sets skip the days they leave out, and the words match the runs.
import { describe, expect, test } from "bun:test";
import { cadenceAt, cadenceOf, clockMinutes, firstCadenceRun, nextCadenceRun, plainCadence, plainDays, weekdayNumbers } from "./cadence";
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

describe("firstCadenceRun", () => {
  // Wednesday, October 7, 2026, 8:35 AM in New York.
  const now = Date.parse("2026-10-07T12:35:00Z");
  test("a weekly day and time starts at the next such day, found here rather than by the model", () => {
    expect(iso(firstCadenceRun(cadenceOf(9 * 60, NY, weekdayNumbers(["sat"])), now))).toBe("2026-10-10T13:00:00.000Z");
    expect(iso(firstCadenceRun(cadenceOf(18 * 60, NY, weekdayNumbers(["fri"])), now))).toBe("2026-10-09T22:00:00.000Z");
    expect(iso(firstCadenceRun(cadenceOf(8 * 60, NY, weekdayNumbers(["mon"])), now))).toBe("2026-10-12T12:00:00.000Z");
  });
  test("today counts while its time is still ahead, and not once it has passed", () => {
    expect(iso(firstCadenceRun(cadenceOf(17 * 60, NY, weekdayNumbers(["wed"])), now))).toBe("2026-10-07T21:00:00.000Z");
    expect(iso(firstCadenceRun(cadenceOf(7 * 60, NY, weekdayNumbers(["wed"])), now))).toBe("2026-10-14T11:00:00.000Z");
  });
  test("a later start date waits for the first listed day on or after it; an earlier one changes nothing", () => {
    expect(iso(firstCadenceRun(cadenceOf(10 * 60, NY, weekdayNumbers(["tue"])), now, "2026-11-03"))).toBe("2026-11-03T15:00:00.000Z");
    expect(iso(firstCadenceRun(cadenceOf(10 * 60, NY, weekdayNumbers(["tue"])), now, "2026-11-01"))).toBe("2026-11-03T15:00:00.000Z");
    expect(iso(firstCadenceRun(cadenceOf(9 * 60, NY, weekdayNumbers(["sat"])), now, "2026-01-01"))).toBe("2026-10-10T13:00:00.000Z");
  });
  test("clock times", () => {
    expect(clockMinutes("18:30")).toBe(18 * 60 + 30);
    expect(clockMinutes("9:05")).toBe(9 * 60 + 5);
    expect(clockMinutes("24:00")).toBeNull();
    expect(clockMinutes("6pm")).toBeNull();
  });
  test("the card says the same first day the routine makes", () => {
    const md = approvalContext({ instruction: "Remind you to water the plants", days: ["sat"], time: "09:00" }, { timezone: NY, now });
    expect(md).toContain("**When:** Every Saturday at 9:00 AM, starting Saturday, October 10");
    expect(md).not.toContain("Time");
    const later = approvalContext({ instruction: "Remind you to submit your timesheet", days: ["tue"], time: "10:00", starts_on: "2026-11-01" }, { timezone: NY, now });
    expect(later).toContain("**When:** Every Tuesday at 10:00 AM, starting Tuesday, November 3");
    expect(later).not.toContain("Starts on");
  });
});
