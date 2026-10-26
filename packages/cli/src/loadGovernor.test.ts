import { describe, expect, test } from "bun:test";
import { GOVERNOR_STATE_STALE_MS, LoadGovernor, OVER_HOLD_MS, RELEASE_HOLD_MS, RELEASE_STEP_MS, busyBetween, cloudFirstReason, type CageCandidate, type GovernorState } from "./loadGovernor";

const feed = (g: LoadGovernor, from: number, to: number, busy: number, loadPerCore = 1, candidates: readonly CageCandidate[] = []) => {
  for (let at = from; at <= to; at += 5_000) g.observe({ at, busy, loadPerCore }, candidates);
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

describe("confinement", () => {
  // 16 cores: 100 points of cpu is one core, so the whole machine is 1600.
  const fleet: CageCandidate[] = [
    { id: "heavy", cpu: 800 },
    { id: "mid", cpu: 400 },
    { id: "light", cpu: 50 },
    { id: "idle", cpu: 0 },
  ];

  test("pinned CPUs confine the heaviest sessions until their CPU covers the excess, then wait a hold before the next", () => {
    const g = new LoadGovernor(16);
    // 95% busy is 320 points over the 75% target: the heaviest session alone covers it.
    expect(feed(g, 0, OVER_HOLD_MS, 0.95, 1, fleet)).toBe("over");
    expect(g.confined).toEqual(["heavy"]);
    feed(g, OVER_HOLD_MS + 5_000, 2 * OVER_HOLD_MS - 5_000, 0.95, 1, fleet);
    expect(g.confined).toEqual(["heavy"]);
    feed(g, 2 * OVER_HOLD_MS, 2 * OVER_HOLD_MS, 0.95, 1, fleet);
    expect(g.confined).toEqual(["heavy", "mid"]);
  });

  test("a deep run queue on busy CPUs confines every unattended session at once", () => {
    const g = new LoadGovernor(16);
    expect(g.observe({ at: 0, busy: 0.9, loadPerCore: 25 }, fleet)).toBe("over");
    expect(g.confined.sort()).toEqual(["heavy", "idle", "light", "mid"]);
  });

  test("CPUs with room let confined work out even while its backlog keeps the load average high", () => {
    const g = new LoadGovernor(16);
    g.observe({ at: 0, busy: 0.95, loadPerCore: 25 }, fleet);
    // Confined, the fleet gets scraps of the efficiency cores: 40% busy with the person's own work, and the runnable backlog holds load at 9 per core.
    const t = 5_000;
    feed(g, t, t + RELEASE_STEP_MS - 5_000, 0.4, 9, fleet);
    expect(g.confined).toHaveLength(4);
    // 35% of 16 cores under the 75% target is 560 points of room: the three lightest fit, the heavy one waits a step.
    feed(g, t + RELEASE_STEP_MS, t + RELEASE_STEP_MS, 0.4, 9, fleet);
    expect(g.confined).toEqual(["heavy"]);
    expect(g.level).toBe("over");
    feed(g, t + RELEASE_STEP_MS + 5_000, t + 2 * RELEASE_STEP_MS, 0.4, 9, fleet);
    expect(g.confined).toEqual([]);
    expect(feed(g, t + 2 * RELEASE_STEP_MS + 5_000, t + 2 * RELEASE_STEP_MS + RELEASE_HOLD_MS, 0.4, 9, fleet)).toBe("calm");
  });

  test("a step always lets at least one session out, even one heavier than the room", () => {
    const g = new LoadGovernor(16);
    g.observe({ at: 0, busy: 0.95, loadPerCore: 25 }, [{ id: "heavy", cpu: 1500 }]);
    feed(g, 5_000, 5_000 + RELEASE_STEP_MS, 0.25, 9, [{ id: "heavy", cpu: 1500 }]);
    expect(g.confined).toEqual([]);
  });

  test("CPUs between the target and pinned hold the confined set where it is", () => {
    const g = new LoadGovernor(16);
    g.observe({ at: 0, busy: 0.95, loadPerCore: 25 }, fleet);
    expect(feed(g, 5_000, 5_000 + 3 * RELEASE_HOLD_MS, 0.8, 9, fleet)).toBe("over");
    expect(g.confined).toHaveLength(4);
  });

  test("a spike resets the room timer, so a release waits a full step after it", () => {
    const g = new LoadGovernor(16);
    g.observe({ at: 0, busy: 0.95, loadPerCore: 25 }, fleet);
    feed(g, 5_000, RELEASE_STEP_MS - 5_000, 0.25, 9, fleet);
    g.observe({ at: RELEASE_STEP_MS, busy: 0.9, loadPerCore: 1 }, fleet);
    feed(g, RELEASE_STEP_MS + 5_000, 2 * RELEASE_STEP_MS, 0.25, 9, fleet);
    expect(g.confined).toHaveLength(4);
    feed(g, 2 * RELEASE_STEP_MS + 5_000, 2 * RELEASE_STEP_MS + 5_000, 0.25, 9, fleet);
    expect(g.confined).toEqual(["heavy"]);
  });

  test("a session a person picked up leaves confinement on the next sample", () => {
    const g = new LoadGovernor(16);
    g.observe({ at: 0, busy: 0.95, loadPerCore: 25 }, fleet);
    g.observe({ at: 5_000, busy: 0.95, loadPerCore: 25 }, fleet.filter((c) => c.id !== "mid"));
    expect(g.confined).not.toContain("mid");
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
