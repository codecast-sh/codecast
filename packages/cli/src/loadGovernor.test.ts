import { describe, expect, test } from "bun:test";
import { GOVERNOR_STATE_STALE_MS, LoadGovernor, OVER_HOLD_MS, RELEASE_HOLD_MS, busyBetween, cloudFirstReason, type GovernorState } from "./loadGovernor";

const feed = (g: LoadGovernor, from: number, to: number, busy: number, loadPerCore = 1, step = 5_000) => {
  for (let at = from; at <= to; at += step) g.observe({ at, busy, loadPerCore });
  return g.level;
};

describe("LoadGovernor", () => {
  test("a short spike is busy, not over", () => {
    const g = new LoadGovernor();
    expect(feed(g, 0, OVER_HOLD_MS - 5_000, 0.95)).toBe("busy");
    expect(g.admit("revive")).toBe(true);
  });

  test("pinned CPUs held past the bar turn over and hold starts", () => {
    const g = new LoadGovernor();
    expect(feed(g, 0, OVER_HOLD_MS, 0.95)).toBe("over");
    for (const kind of ["revive", "workflow_resume", "warm_pool", "trigger"] as const) expect(g.admit(kind)).toBe(false);
  });

  test("a deep run queue on busy CPUs is over at once", () => {
    const g = new LoadGovernor();
    expect(g.observe({ at: 0, busy: 0.9, loadPerCore: 25 })).toBe("over");
  });

  test("a deep run queue on idle CPUs is not over: load counts blocked threads", () => {
    const g = new LoadGovernor();
    expect(feed(g, 0, 60_000, 0.2, 25)).toBe("calm");
  });

  test("leaving over waits out a quiet spell, and a relapse restarts the wait", () => {
    const g = new LoadGovernor();
    feed(g, 0, OVER_HOLD_MS, 0.95);
    const t = OVER_HOLD_MS + 5_000;
    expect(feed(g, t, t + RELEASE_HOLD_MS - 10_000, 0.7)).toBe("over");
    g.observe({ at: t + RELEASE_HOLD_MS, busy: 0.95, loadPerCore: 1 });
    expect(feed(g, t + RELEASE_HOLD_MS + 5_000, t + 2 * RELEASE_HOLD_MS, 0.7)).toBe("over");
    expect(feed(g, t + 2 * RELEASE_HOLD_MS + 5_000, t + 3 * RELEASE_HOLD_MS + 10_000, 0.7)).toBe("busy");
    expect(g.admit("revive")).toBe(true);
    expect(g.admit("warm_pool")).toBe(false);
  });

  test("a throttled machine is not a recovered one: over holds while the run queue is still deep", () => {
    const g = new LoadGovernor();
    feed(g, 0, OVER_HOLD_MS, 0.95, 10);
    const t = OVER_HOLD_MS + 5_000;
    expect(feed(g, t, t + 3 * RELEASE_HOLD_MS, 0.5, 9)).toBe("over");
    expect(feed(g, t + 3 * RELEASE_HOLD_MS + 5_000, t + 4 * RELEASE_HOLD_MS + 10_000, 0.5, 1.5)).toBe("calm");
  });

  test("a deep queue of blocked threads on idle CPUs does not keep over forever", () => {
    const g = new LoadGovernor();
    feed(g, 0, OVER_HOLD_MS, 0.95, 10);
    expect(feed(g, OVER_HOLD_MS + 5_000, OVER_HOLD_MS + RELEASE_HOLD_MS + 10_000, 0.2, 10)).toBe("calm");
  });

  test("calm needs a quiet spell too, and only calm warms the pool", () => {
    const g = new LoadGovernor();
    feed(g, 0, 5_000, 0.7);
    expect(g.level).toBe("busy");
    expect(feed(g, 10_000, 10_000 + RELEASE_HOLD_MS + 5_000, 0.2)).toBe("calm");
    expect(g.admit("warm_pool")).toBe(true);
  });
});

test("busyBetween reads the idle share of the time that passed", () => {
  expect(busyBetween({ idle: 0, total: 0 }, { idle: 25, total: 100 })).toBe(0.75);
  expect(busyBetween({ idle: 10, total: 100 }, { idle: 10, total: 100 })).toBeUndefined();
});

describe("cloudFirstReason", () => {
  const now = 1_000_000;
  const state = (level: GovernorState["level"], unattended: string[] = [], age = 0): GovernorState => ({ at: now - age, level, unattended });
  const base = { unattendedFlag: false, spawnerSession: "s1", sharesSpawnerCheckout: false, mergesBack: false, machineChosen: false, now };

  test("a run nobody watches goes to the cloud unless the machine is calm", () => {
    expect(cloudFirstReason({ ...base, unattendedFlag: true, state: state("busy") })).toContain("unattended run");
    expect(cloudFirstReason({ ...base, unattendedFlag: true, state: state("calm") })).toBeNull();
  });

  test("anything an unattended session starts counts as unattended", () => {
    expect(cloudFirstReason({ ...base, state: state("over", ["s1"]) })).toContain("unattended session");
    expect(cloudFirstReason({ ...base, state: state("over", ["s2"]) })).toBeNull();
  });

  test("a stale or missing state reads as not calm", () => {
    expect(cloudFirstReason({ ...base, unattendedFlag: true, state: state("calm", [], GOVERNOR_STATE_STALE_MS + 1) })).toContain("unknown load");
    expect(cloudFirstReason({ ...base, unattendedFlag: true, state: null })).toContain("unknown load");
  });

  test("work that lands in the spawner's checkout, or a machine chosen by hand, stays put", () => {
    const over = state("over", ["s1"]);
    expect(cloudFirstReason({ ...base, unattendedFlag: true, sharesSpawnerCheckout: true, state: over })).toBeNull();
    expect(cloudFirstReason({ ...base, unattendedFlag: true, mergesBack: true, state: over })).toBeNull();
    expect(cloudFirstReason({ ...base, unattendedFlag: true, machineChosen: true, state: over })).toBeNull();
  });
});
