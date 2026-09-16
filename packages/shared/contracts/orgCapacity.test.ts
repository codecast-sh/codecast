import { describe, expect, test } from "bun:test";
import { FLAG_CODES, PERSON_SPAN, ROLE_CAPACITY, STABILITY, capacity, capacityFlags, renderCapacityModel, type RoleSignals } from "./orgCapacity";

// The capacity model (org-staffing.md S2, S3): one module of thresholds with
// a reason each, and the pure flag rule org.health and the analyzer share.

const quietRole = (over: Partial<RoleSignals> = {}): RoleSignals => ({
  kind: "role",
  handle: "growth",
  load: { open_tasks: 3, in_flight: 1, active_plans: 1, live_hands: 1, direct_reports: 0 },
  spend: { wakes_today: 2, wakes_7d_avg: 3, wakes_cap: 40, tokens_today: 10_000, tokens_7d_avg: null, tokens_cap: 400_000, cap_hits_7d: 0 },
  flow: { decisions_7d: 2, median_recommend_min: 2, review_stalls: 0, done_7d: 4, sends_7d: { to: [], from: [] } },
  idle_days: 1,
  age_days: 30,
  has_charter: true,
  ...over,
});
const codes = (flags: { code: string }[]) => flags.map((f) => f.code).sort();

describe("capacity model", () => {
  test("every threshold carries a number, a unit and a reason", () => {
    for (const table of [ROLE_CAPACITY, PERSON_SPAN, STABILITY]) {
      for (const [key, t] of Object.entries(table)) {
        expect(typeof t.value, key).toBe("number");
        expect(t.unit.length, key).toBeGreaterThan(0);
        expect(t.reason.length, key).toBeGreaterThan(10);
      }
    }
    expect(capacity("open_tasks")).toBe(25);
    expect(capacity("live_hands")).toBe(6);
  });

  test("renders every threshold and every flag code into the prompt text", () => {
    const md = renderCapacityModel();
    for (const key of Object.keys(ROLE_CAPACITY)) expect(md).toContain(`- ${key}:`);
    for (const key of Object.keys(PERSON_SPAN)) expect(md).toContain(`- ${key}:`);
    for (const key of Object.keys(STABILITY)) expect(md).toContain(`- ${key}:`);
    for (const code of FLAG_CODES) expect(md).toContain(`- ${code}:`);
    expect(md).toContain("70% of the wake cap");
  });
});

describe("capacityFlags", () => {
  test("a role inside the model raises nothing", () => {
    expect(capacityFlags(quietRole())).toEqual([]);
  });

  test("one load breach warns; two block; the detail names the numbers", () => {
    const one = capacityFlags(quietRole({ load: { open_tasks: 30, in_flight: 2, active_plans: 1, live_hands: 1, direct_reports: 0 } }));
    expect(one).toEqual([{ code: "overloaded", severity: "warn", detail: "@growth holds 30 open tasks (model: 25); first breach on record" }]);
    const two = capacityFlags(quietRole({ load: { open_tasks: 30, in_flight: 9, active_plans: 1, live_hands: 1, direct_reports: 0 } }));
    expect(two[0]).toMatchObject({ code: "overloaded", severity: "blocker" });
    expect(two[0].detail).toContain("9 tasks in flight (model: 8)");
  });

  test("a scope twice the model splits on the first breach; below that line the streak decides", async () => {
    const { overloadRatio, splitsOnFirstBreach, STABILITY } = await import("./orgCapacity");
    const reliability = { open_tasks: 57, in_flight: 43, active_plans: 17, live_hands: 2, direct_reports: 0 };
    expect(overloadRatio(reliability)).toBeCloseTo(43 / 8);
    expect(splitsOnFirstBreach(reliability)).toBe(true);
    const first = capacityFlags(quietRole({ load: reliability, breaches: 0 }));
    expect(first).toEqual([{ code: "overloaded", severity: "blocker", detail: "@growth holds 57 open tasks (model: 25), 43 tasks in flight (model: 8), 17 active plans (model: 4); split now: 5.4 times the model" }]);
    // 1.2 times the model on one count: a warning on the first breach, a blocker on the second.
    const mild = { open_tasks: 30, in_flight: 2, active_plans: 1, live_hands: 1, direct_reports: 0 };
    expect(overloadRatio(mild)).toBeCloseTo(1.2);
    expect(splitsOnFirstBreach(mild)).toBe(false);
    expect(capacityFlags(quietRole({ load: mild, breaches: 0 }))[0]).toMatchObject({ severity: "warn", detail: expect.stringContaining("first breach on record") });
    expect(capacityFlags(quietRole({ load: mild, breaches: 1 }))[0]).toMatchObject({ severity: "blocker", detail: expect.stringContaining("this is breach 2") });
    // Exactly at the line counts as structural.
    expect(splitsOnFirstBreach({ open_tasks: 50, in_flight: 0, active_plans: 0, live_hands: 0, direct_reports: 0 })).toBe(true);
    expect(STABILITY.split_on_first_breach_ratio.value).toBe(2);
  });

  test("span, spend, latency, stalls, idle, chatter and charter each raise their own code", () => {
    const flags = capacityFlags(quietRole({
      load: { open_tasks: 3, in_flight: 1, active_plans: 1, live_hands: 1, direct_reports: 6 },
      spend: { wakes_today: 40, wakes_7d_avg: 3, wakes_cap: 40, tokens_today: 0, tokens_7d_avg: null, tokens_cap: 400_000, cap_hits_7d: 2 },
      flow: { decisions_7d: 3, median_recommend_min: 12, review_stalls: 2, done_7d: 1, sends_7d: { to: [{ handle: "billing", n: 4 }], from: [{ handle: "billing", n: 3 }] } },
      idle_days: 20,
      has_charter: false,
    }));
    expect(codes(flags)).toEqual(["cap_hit", "chatter", "idle", "no_charter", "review_stall", "slow_to_recommend", "wide_span"]);
    expect(flags.find((f) => f.code === "chatter")?.detail).toBe("@growth and @billing exchanged 7 sends this week against 1 task done");
    expect(flags.find((f) => f.code === "slow_to_recommend")?.detail).toContain("12 min (median)");
    expect(flags.find((f) => f.code === "cap_hit")).toMatchObject({ severity: "warn" });
  });

  test("approaching a cap is information, not a hit", () => {
    const flags = capacityFlags(quietRole({ spend: { wakes_today: 30, wakes_7d_avg: 3, wakes_cap: 40, tokens_today: 0, tokens_7d_avg: 340_000, tokens_cap: 400_000, cap_hits_7d: 0 } }));
    expect(flags).toEqual([
      { code: "cap_hit", severity: "info", detail: "@growth is at 75% of its wake cap" },
      { code: "cap_hit", severity: "info", detail: "@growth is at 85% of its token cap" },
    ]);
  });

  test("a new seat with no event yet is not idle; an old one is", () => {
    expect(capacityFlags(quietRole({ idle_days: null, age_days: 3 }))).toEqual([]);
    expect(capacityFlags(quietRole({ idle_days: null, age_days: 20 }))[0]).toMatchObject({ code: "idle", detail: expect.stringContaining("since the role was created 20 days ago") });
  });

  test("chatter needs both volume and more talk than work", () => {
    const busy = { to: [{ handle: "ops", n: 6 }], from: [] };
    expect(capacityFlags(quietRole({ flow: { decisions_7d: 0, median_recommend_min: null, review_stalls: 0, done_7d: 10, sends_7d: busy } }))).toEqual([]);
    expect(codes(capacityFlags(quietRole({ flow: { decisions_7d: 0, median_recommend_min: null, review_stalls: 0, done_7d: 2, sends_7d: busy } })))).toEqual(["chatter"]);
  });

  test("a person past the span raises wide_span; the company flags unowned and uncharted work", () => {
    expect(capacityFlags({ kind: "person", name: "Ada", direct_roles: 7 })).toEqual([]);
    expect(capacityFlags({ kind: "person", name: "Ada", direct_roles: 8 })).toEqual([{ code: "wide_span", severity: "warn", detail: "Ada answers for 8 roles directly (model: 7); propose a layer" }]);
    const company = capacityFlags({
      kind: "company",
      unowned_projects: [{ id: "p1", title: "Billing" }],
      unfiled_tasks: 3,
      plans_without_goal: [{ id: "pl1", title: "Launch" }],
      projects_without_charter: [{ id: "p1", title: "Billing" }],
      unfiled_plans: [{ id: "pl2", title: "Loose", short_id: "pl-2", open_tasks: 4 }],
    });
    expect(company).toEqual([
      { code: "unowned", severity: "warn", detail: 'project "Billing" has no owner role' },
      { code: "no_charter", severity: "info", detail: 'project "Billing" has no goal' },
      { code: "no_charter", severity: "info", detail: 'plan "Launch" has no goal' },
      { code: "unowned", severity: "info", detail: "3 open tasks filed under no project or plan" },
      { code: "unfiled_plan", severity: "info", detail: 'plan "Loose" (pl-2) has 4 open tasks and no project' },
    ]);
  });

  test("stale records are information; a program whose end came warns (S9, S10)", () => {
    const stale = capacityFlags({
      kind: "company", unowned_projects: [], unfiled_tasks: 0, plans_without_goal: [], projects_without_charter: [], unfiled_plans: [],
      stale: {
        plans: [{ short_id: "pl-3", title: "Old push", status: "active", last_task_activity_at: 1, sessions_live: 0, reason: "every task closed" }],
        tasks: [{ short_id: "ct-9", title: "Wire it", status: "in_progress", last_session_activity_at: 1, reason: "commits landed, still open" }],
        projects: [{ id: "p2", title: "Legacy", reason: "no activity 30d" }],
      },
    });
    expect(stale).toEqual([
      { code: "stale_plan", severity: "info", detail: 'plan "Old push" (pl-3) is active but every task closed' },
      { code: "stale_task", severity: "info", detail: 'task "Wire it" (ct-9) is in progress: commits landed, still open' },
      { code: "stale_project", severity: "info", detail: 'project "Legacy" has had no activity 30d' },
    ]);
    expect(capacityFlags(quietRole({ program_ended: { ended: "its plan pl-3 is done", then: "retire" } }))).toEqual([
      { code: "program_ended", severity: "warn", detail: "@growth is a program role and its plan pl-3 is done; its tenure says retire it" },
    ]);
    expect(capacityFlags(quietRole({ program_ended: null }))).toEqual([]);
  });
});
