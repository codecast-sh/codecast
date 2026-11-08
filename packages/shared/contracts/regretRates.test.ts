import { describe, expect, test } from "bun:test";
import { passedChecks, regretSummary, regretted, roleLineRate, settled, windowFromLags, type RegretChange } from "./regretRates";

const DAY = 86_400_000;
const now = 100 * DAY;
const change = (o: Partial<RegretChange>): RegretChange => ({
  sha: "a", landed_at: 50 * DAY, live_at: null, fixes: [], reopened_at: [], role_id: "r1", role_handle: "agent-quality",
  flow: "agentwatch", through: "line", checks: [], ...o,
});

describe("regret", () => {
  test("a fix inside the window after live regrets the change; one after the window does not", () => {
    expect(regretted(change({ live_at: 52 * DAY, fixes: [{ at: 60 * DAY, top: true }] }), 14)).toBe(true);
    expect(regretted(change({ live_at: 52 * DAY, fixes: [{ at: 67 * DAY, top: true }] }), 14)).toBe(false);
    // A fix before the change landed repaired something else.
    expect(regretted(change({ fixes: [{ at: 40 * DAY, top: true }] }), 14)).toBe(false);
  });

  test("only a fix's top introducer regrets; the other links stay stored and count nothing", () => {
    expect(regretted(change({ fixes: [{ at: 55 * DAY, top: false }] }), 14)).toBe(false);
  });

  test("a reopen in watch regrets it", () => {
    expect(regretted(change({ reopened_at: [55 * DAY] }), 14)).toBe(true);
  });

  test("the window runs from live, else from landing; an open window is partial", () => {
    expect(settled(change({ landed_at: 90 * DAY }), 14, now)).toBe(false);
    expect(settled(change({ landed_at: 88 * DAY, live_at: null }), 14, now)).toBe(false);
    expect(settled(change({ landed_at: 70 * DAY, live_at: 90 * DAY }), 14, now)).toBe(false);
    expect(settled(change({ landed_at: 70 * DAY }), 14, now)).toBe(true);
    // Regretted is settled at once.
    expect(settled(change({ landed_at: 95 * DAY, fixes: [{ at: 96 * DAY, top: true }] }), 14, now)).toBe(true);
  });
});

describe("regretSummary", () => {
  test("rates per role, flow and author, partial ones counted apart", () => {
    const s = regretSummary([
      change({ sha: "1" }),
      change({ sha: "2", fixes: [{ at: 55 * DAY, top: true }] }),
      change({ sha: "3", landed_at: 95 * DAY }),
      change({ sha: "4", role_id: null, role_handle: null, flow: "", through: "outside" }),
    ], { now, windowDays: 14 });
    const line = s.changes.find((r) => r.through === "line")!;
    expect(line).toMatchObject({ merged: 3, settled: 2, regretted: 1, partial: 1, rate: 0.5 });
    expect(s.changes.find((r) => r.through === "outside")).toMatchObject({ merged: 1, settled: 1, regretted: 0, rate: 1 });
    expect(roleLineRate(s, "r1")).toEqual({ settled: 2, regretted: 1, partial: 1, rate: 0.5, window_days: 14 });
    expect(roleLineRate(s, "nobody").rate).toBeNull();
  });

  test("a station's miss rate is the regretted share of the settled changes it passed", () => {
    const s = regretSummary([
      change({ sha: "1", checks: ["change/check__check"] }),
      change({ sha: "2", checks: ["change/check__check"], fixes: [{ at: 55 * DAY, top: true }] }),
      change({ sha: "3", checks: ["change/check__check"], landed_at: 95 * DAY }),
    ], { now, windowDays: 14 });
    expect(s.stations).toEqual([{ flow: "change", node_id: "check__check", label: "Check", passed: 3, settled: 2, regretted: 1, miss_rate: 0.5 }]);
  });
});

describe("passedChecks", () => {
  test("check-phase stations that completed with success, and the judge when the run went out low", () => {
    const nodes = [
      { node_id: "start", status: "completed", outcome: "success" },
      { node_id: "check__check", status: "completed", outcome: "success" },
      { node_id: "review__review", status: "completed", outcome: "failure" },
      { node_id: "judge__judge", status: "completed", outcome: "success" },
      { node_id: "judge__low", status: "completed", outcome: "success" },
      { node_id: "build", status: "completed", outcome: "success" },
    ];
    expect(passedChecks("change", nodes)).toEqual(["change/check__check", "change/judge__judge"]);
    expect(passedChecks("change", nodes.filter((n) => n.node_id !== "judge__low"))).toEqual(["change/check__check"]);
  });
});

describe("windowFromLags", () => {
  test("covers three quarters of the top links' lag from live, at most 30 days; 14 with none", () => {
    const lagged = (days: number[]) => days.map((d, i) => change({ sha: String(i), landed_at: 10 * DAY, live_at: 12 * DAY, fixes: [{ at: (12 + d) * DAY, top: true }, { at: 13 * DAY, top: false }] }));
    expect(windowFromLags(lagged([1, 2, 3, 9]))).toEqual({ days: 3, links: 4 });
    expect(windowFromLags(lagged([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({ days: 6, links: 8 });
    expect(windowFromLags(lagged([40, 50, 60, 70]))).toEqual({ days: 30, links: 4 });
    expect(windowFromLags([change({})])).toEqual({ days: 14, links: 0 });
    expect(regretSummary(lagged([1, 2, 3, 9]), { now }).window_days).toBe(3);
  });
});

