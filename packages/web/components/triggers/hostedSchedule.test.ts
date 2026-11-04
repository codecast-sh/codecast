import { describe, expect, test } from "bun:test";
import { describeHostedCadence, hostedNextWords } from "./hostedSchedule";

const DAY = 24 * 60 * 60 * 1000;
// A Wednesday, 10:30 local.

describe("hosted routine schedule", () => {
  test("a stored routine reads as a sentence: the day or weekday and the time, or a repeat in words", () => {
    const nine = new Date(2026, 9, 12, 9, 0).getTime();
    const time = new Date(nine).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(describeHostedCadence({ schedule_type: "recurring", interval_ms: DAY, run_at: nine })).toBe(`Every day at ${time}`);
    expect(describeHostedCadence({ schedule_type: "recurring", interval_ms: 7 * DAY, run_at: nine })).toBe(`Every Monday at ${time}`);
    expect(describeHostedCadence({ schedule_type: "recurring", interval_ms: 30 * 60_000 })).toBe("Every 30 minutes");
    expect(describeHostedCadence({ schedule_type: "recurring", interval_ms: 3 * 60 * 60_000 })).toBe("Every 3 hours");
    expect(describeHostedCadence({ schedule_type: "recurring", interval_ms: 90 * 60_000 })).toBe("Every 1 hour 30 minutes");
    expect(describeHostedCadence({ schedule_type: "once", run_at: nine })).toMatch(/^Once, Oct 12 at /);
    expect(describeHostedCadence({ schedule_type: "event" })).toBeNull();
    // A wall-clock routine says its own clock's time and days, whatever run_at the browser sees.
    expect(describeHostedCadence({ schedule_type: "recurring", interval_ms: DAY, run_at: nine, cadence: { zone: "America/New_York", minutes: 480, weekdays: [1, 2, 3, 4, 5] } })).toBe("Weekdays at 8:00 AM");
    expect(describeHostedCadence({ schedule_type: "recurring", interval_ms: 7 * DAY, run_at: nine, cadence: { zone: "America/New_York", minutes: 1080, weekdays: [0] } })).toBe("Every Sunday at 6:00 PM");
  });

  test("the next run is said only where the schedule does not already say it", () => {
    const now = new Date(2026, 9, 12, 8, 0).getTime();
    const nine = new Date(2026, 9, 12, 9, 30).getTime();
    const tomorrow = nine + DAY;
    expect(hostedNextWords({ schedule_type: "recurring", interval_ms: DAY, run_at: nine }, now)).toBe("today");
    expect(hostedNextWords({ schedule_type: "recurring", interval_ms: DAY, run_at: tomorrow }, now)).toBe("tomorrow");
    expect(hostedNextWords({ schedule_type: "recurring", interval_ms: 7 * DAY, run_at: nine + 3 * DAY }, now)).toBeNull();
    expect(hostedNextWords({ schedule_type: "once", run_at: tomorrow }, now)).toBeNull();
    expect(hostedNextWords({ schedule_type: "recurring", interval_ms: DAY, run_at: now + 25 * 60_000 }, now)).toBe("in 25 min");
    expect(hostedNextWords({ schedule_type: "recurring", interval_ms: 3 * 60 * 60_000, run_at: nine }, now)).toMatch(/^next today at /);
  });
});
