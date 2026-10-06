import { describe, expect, test } from "bun:test";
import { defaultHostedWhen, hostedSchedule, hostedWhenOf, routineLimitLine } from "./hostedSchedule";

const DAY = 24 * 60 * 60 * 1000;
// A Wednesday, 10:30 local.
const now = new Date(2026, 9, 7, 10, 30).getTime();

describe("hosted routine schedule", () => {
  test("a new routine defaults to every day at 9:00, which every plan allows", () => {
    const when = defaultHostedWhen(now);
    const sched = hostedSchedule(when, now)!;
    expect(sched.schedule_type).toBe("recurring");
    expect(sched.interval_ms).toBe(DAY);
    // 9:00 has passed today, so the first run is tomorrow at 9:00.
    expect(new Date(sched.run_at)).toEqual(new Date(2026, 9, 8, 9, 0));
  });

  test("every Monday at 9 runs on the next Monday", () => {
    const sched = hostedSchedule({ repeat: "weekly", weekday: 1, time: "09:00", date: "" }, now)!;
    expect(new Date(sched.run_at)).toEqual(new Date(2026, 9, 12, 9, 0));
    expect(sched.interval_ms).toBe(7 * DAY);
  });

  test("once on a date runs then, and a past time is refused", () => {
    expect(hostedSchedule({ repeat: "once", weekday: 0, time: "14:15", date: "2026-10-09" }, now)).toEqual({ schedule_type: "once", run_at: new Date(2026, 9, 9, 14, 15).getTime() });
    expect(hostedSchedule({ repeat: "once", weekday: 0, time: "08:00", date: "2026-10-07" }, now)).toBeNull();
  });

  test("a stored daily, weekly or one-off routine reads back as a choice; anything else does not", () => {
    expect(hostedWhenOf({ schedule_type: "recurring", interval_ms: DAY, run_at: new Date(2026, 9, 8, 7, 5).getTime() }, now)).toMatchObject({ repeat: "daily", time: "07:05" });
    expect(hostedWhenOf({ schedule_type: "recurring", interval_ms: 3 * 60 * 60 * 1000, run_at: now }, now)).toBeNull();
  });

  test("the plan's limits read as one sentence", () => {
    expect(routineLimitLine({ label: "Free", routines: { max: 3 } }, DAY)).toBe("Free plan: up to 3 routines, each at most once a day.");
    expect(routineLimitLine({ label: "Pro", routines: { max: null } }, 60 * 60 * 1000)).toBe("Pro plan: each at most once an hour.");
  });
});
