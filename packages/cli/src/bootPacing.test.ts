import { describe, expect, test } from "bun:test";
import { BOOT_TROUBLE_WINDOW_MS, bootPacingAfter, planBootPacing, type BootPacingPlan } from "./bootPacing.js";

const NORMAL: Omit<BootPacingPlan, "reason"> = {
  tier: "normal",
  reattachConcurrency: 8,
  promptScanSpacingMs: 0,
  startupSyncConcurrency: 4,
  watchdogSyncConcurrency: 20,
  schedulerStartDelayMs: 0,
  fanoutOffsetScale: 1,
  holdMs: 0,
};
const CAUTIOUS: Omit<BootPacingPlan, "reason"> = {
  tier: "cautious",
  reattachConcurrency: 3,
  promptScanSpacingMs: 750,
  startupSyncConcurrency: 2,
  watchdogSyncConcurrency: 6,
  schedulerStartDelayMs: 60_000,
  fanoutOffsetScale: 2,
  holdMs: 15 * 60_000,
};
const SEVERE: Omit<BootPacingPlan, "reason"> = {
  tier: "severe",
  reattachConcurrency: 1,
  promptScanSpacingMs: 1_500,
  startupSyncConcurrency: 1,
  watchdogSyncConcurrency: 3,
  schedulerStartDelayMs: 180_000,
  fanoutOffsetScale: 3,
  holdMs: 30 * 60_000,
};

function bounds(plan: BootPacingPlan): Omit<BootPacingPlan, "reason"> {
  const { reason: _reason, ...rest } = plan;
  return rest;
}

describe("planBootPacing", () => {
  test("no signals at all fails open to normal with the historical bounds", () => {
    const plan = planBootPacing({});
    expect(bounds(plan)).toEqual(NORMAL);
    expect(plan.reason).toBe("no recent trouble");
  });

  test("a quiet machine with no trouble is normal and names the load", () => {
    const plan = planBootPacing({ load1: 4, cpuCount: 16, memoryPressure: "normal", crashCount: 0 });
    expect(bounds(plan)).toEqual(NORMAL);
    expect(plan.reason).toBe("no recent trouble, load 4.0 on 16 cpus");
  });

  test("load just under 2 per cpu is still normal", () => {
    expect(planBootPacing({ load1: 31.9, cpuCount: 16 }).tier).toBe("normal");
  });

  test("a recent hang alone is cautious", () => {
    const plan = planBootPacing({ hangAgeMs: 5 * 60_000, load1: 1, cpuCount: 16 });
    expect(bounds(plan)).toEqual(CAUTIOUS);
    expect(plan.reason).toBe("hang 5m ago");
  });

  test("a watchdog kill names its rule", () => {
    const plan = planBootPacing({ hangAgeMs: 90_000, watchdogRule: "two-passes" });
    expect(plan.tier).toBe("cautious");
    expect(plan.reason).toBe("watchdog killed the previous daemon 2m ago (two-passes)");
  });

  test("a hang older than the trouble window is history", () => {
    expect(planBootPacing({ hangAgeMs: BOOT_TROUBLE_WINDOW_MS, watchdogRule: "two-passes" }).tier).toBe("normal");
    expect(planBootPacing({ hangAgeMs: BOOT_TROUBLE_WINDOW_MS - 1 }).tier).toBe("cautious");
  });

  test("crashes in the window are cautious, singular and plural", () => {
    expect(planBootPacing({ crashCount: 1 }).reason).toBe("1 crash in the last 30m");
    const plan = planBootPacing({ crashCount: 3 });
    expect(bounds(plan)).toEqual(CAUTIOUS);
    expect(plan.reason).toBe("3 crashes in the last 30m");
  });

  test("load between 2 and 6 per cpu with no trouble is cautious", () => {
    const plan = planBootPacing({ load1: 32, cpuCount: 16 });
    expect(bounds(plan)).toEqual(CAUTIOUS);
    expect(plan.reason).toBe("load 32.0 on 16 cpus");
    expect(planBootPacing({ load1: 95.9, cpuCount: 16 }).tier).toBe("cautious");
  });

  test("trouble plus elevated load is severe", () => {
    const plan = planBootPacing({ hangAgeMs: 60_000, crashCount: 2, load1: 48, cpuCount: 16 });
    expect(bounds(plan)).toEqual(SEVERE);
    expect(plan.reason).toBe("hang 1m ago; 2 crashes in the last 30m; load 48.0 on 16 cpus");
  });

  test("load at or above 6 per cpu alone is severe", () => {
    const plan = planBootPacing({ load1: 250, cpuCount: 16 });
    expect(bounds(plan)).toEqual(SEVERE);
    expect(plan.reason).toBe("load 250.0 on 16 cpus");
    expect(planBootPacing({ load1: 96, cpuCount: 16 }).tier).toBe("severe");
  });

  test("critical memory pressure alone is severe", () => {
    const plan = planBootPacing({ memoryPressure: "critical", load1: 1, cpuCount: 16 });
    expect(bounds(plan)).toEqual(SEVERE);
    expect(plan.reason).toBe("memory pressure critical");
  });

  test("elevated and unknown memory pressure are not trouble", () => {
    expect(planBootPacing({ memoryPressure: "elevated" }).tier).toBe("normal");
    expect(planBootPacing({ memoryPressure: "unknown" }).tier).toBe("normal");
  });

  test("a failed or nonsensical signal reads as no trouble", () => {
    expect(planBootPacing({ load1: NaN, cpuCount: 16 }).tier).toBe("normal");
    expect(planBootPacing({ load1: 250, cpuCount: 0 }).tier).toBe("normal");
    expect(planBootPacing({ load1: 250 }).tier).toBe("normal");
    expect(planBootPacing({ hangAgeMs: -5, crashCount: -1 }).tier).toBe("normal");
    expect(planBootPacing({ hangAgeMs: Infinity }).tier).toBe("normal");
  });

  test("repeating work returns to the normal bounds once the hold has passed", () => {
    const severe = planBootPacing({ memoryPressure: "critical" });
    expect(bootPacingAfter(severe, 29 * 60_000)).toBe(severe);
    const settled = bootPacingAfter(severe, 30 * 60_000);
    expect(bounds(settled)).toEqual({ ...NORMAL, tier: "severe", holdMs: 30 * 60_000 });
    expect(settled.reason).toBe(severe.reason);
    const normal = planBootPacing({});
    expect(bootPacingAfter(normal, 0)).toEqual(normal);
  });

  test("the normal tier keeps every bound no stricter than cautious, and cautious than severe", () => {
    const n = planBootPacing({}), c = planBootPacing({ crashCount: 1 }), s = planBootPacing({ memoryPressure: "critical" });
    for (const key of ["reattachConcurrency", "startupSyncConcurrency", "watchdogSyncConcurrency"] as const) {
      expect(n[key]).toBeGreaterThan(c[key]);
      expect(c[key]).toBeGreaterThan(s[key]);
    }
    for (const key of ["promptScanSpacingMs", "schedulerStartDelayMs", "fanoutOffsetScale"] as const) {
      expect(n[key]).toBeLessThan(c[key]);
      expect(c[key]).toBeLessThan(s[key]);
    }
  });
});
