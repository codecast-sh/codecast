import { describe, expect, test } from "bun:test";
import { FLAG_CODES, PERSON_SPAN, ROLE_CAPACITY, ROLE_LEDGER, STABILITY, capacity, capacityFlags, ledgerDetails, overloadDetails, overloadRatio, renderCapacityModel, splitsOnFirstBreach, type RoleLoad, type RoleSignals } from "./orgCapacity";

// The capacity model (org-staffing.md S2, S3): one module of thresholds with
// a reason each, and the pure flag rule org.health and the analyzer share.
// Load is what reaches a role; the ledger is what its scope holds.

const quietLoad: RoleLoad = { items_per_day: 4, decisions_per_day: 0.3, live_hands: 1, direct_reports: 0, open_stalls: 0, cap_hit_days: 0 };
const quietRole = (over: Partial<RoleSignals> = {}): RoleSignals => ({
  kind: "role",
  handle: "growth",
  load: quietLoad,
  ledger: { open_tasks: 3, in_flight: 1, active_plans: 1 },
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
    for (const table of [ROLE_CAPACITY, ROLE_LEDGER, PERSON_SPAN, STABILITY]) {
      for (const [key, t] of Object.entries(table)) {
        expect(typeof t.value, key).toBe("number");
        expect(t.unit.length, key).toBeGreaterThan(0);
        expect(t.reason.length, key).toBeGreaterThan(10);
      }
    }
    expect(capacity("items_per_day")).toBe(30);
    expect(capacity("live_hands")).toBe(6);
    expect(ROLE_LEDGER.open_tasks.value).toBe(25);
  });

  test("renders every threshold, every ledger line, every flag code and the reading guidance into the prompt text", () => {
    const md = renderCapacityModel();
    for (const key of Object.keys(ROLE_CAPACITY)) expect(md).toContain(`- ${key}:`);
    for (const key of Object.keys(ROLE_LEDGER)) expect(md).toContain(`- ${key}:`);
    for (const key of Object.keys(PERSON_SPAN)) expect(md).toContain(`- ${key}:`);
    for (const key of Object.keys(STABILITY)) expect(md).toContain(`- ${key}:`);
    for (const code of FLAG_CODES) expect(md).toContain(`- ${code}:`);
    expect(md).toContain("70% of the wake cap");
    // The ledger is named as context, and the guidance on sizing lives here,
    // where the thresholds live, so the prompt cannot drift from the model.
    expect(md).toContain("What a role's scope holds (context");
    expect(md).toContain("A role does not do its scope's tasks; hands and people do.");
    expect(md).toContain("How to read the numbers.");
    expect(md).toContain("How to size with it.");
    // The model sizes shape, never an allowance (org-staffing.md S23.2).
    expect(md).not.toContain("`company.caps_total`");
    expect(md).toContain("never propose a limit, never state one");
    expect(md).toContain("A wide ledger with a quiet flow is not a seat problem");
  });
});

describe("the load reading", () => {
  test("a ledger of any size does not overload; only the flow does", () => {
    const bigLedger = quietRole({ ledger: { open_tasks: 90, in_flight: 50, active_plans: 12 } });
    expect(overloadDetails(bigLedger.load)).toEqual([]);
    expect(codes(capacityFlags(bigLedger))).toEqual(["wide_ledger"]);
    const flag = capacityFlags(bigLedger)[0];
    expect(flag.severity).toBe("info");
    expect(flag.detail).toBe("@growth's scope holds 90 open tasks (frame lists: 25), 50 tasks in flight (frame lists: 8), 12 active plans (frame lists: 4); its load is inside the model, so this is size, not overload: bring records in line or file by seam before reading it as a seat");
    expect(ledgerDetails({ open_tasks: 25, in_flight: 8, active_plans: 4 })).toEqual([]);
  });

  test("one load breach warns; two block; the detail names the load and the ledger", () => {
    const one = capacityFlags(quietRole({ load: { ...quietLoad, items_per_day: 36.25 } }));
    expect(one).toEqual([{ code: "overloaded", severity: "warn", detail: "@growth carries 36.3 items changing a day (model: 30); first breach on record; ledger 3 open, 1 in flight, 1 active plan" }]);
    const two = capacityFlags(quietRole({ load: { ...quietLoad, items_per_day: 36, open_stalls: 4 } }));
    expect(two[0]).toMatchObject({ code: "overloaded", severity: "blocker" });
    expect(two[0].detail).toContain("4 open stalls (model: 3)");
  });

  test("the ratio reads the volume axes only: stalls and cap hits breach but never split on their own", () => {
    const symptoms: RoleLoad = { ...quietLoad, open_stalls: 9, cap_hit_days: 7 };
    expect(overloadDetails(symptoms).map(([, key]) => key)).toEqual(["open_stalls", "cap_hit_days"]);
    expect(overloadRatio(symptoms)).toBeCloseTo(quietLoad.live_hands / capacity("live_hands"));
    expect(splitsOnFirstBreach(symptoms)).toBe(false);
    const flagged = capacityFlags(quietRole({ load: symptoms }))[0];
    expect(flagged).toMatchObject({ code: "overloaded", severity: "blocker" });
    expect(flagged.detail).toContain("7 cap hit days this week (model: 1)");
    expect(flagged.detail).toContain("first breach on record");
  });

  test("a flow twice the model on a volume axis splits on the first breach; below that line the streak decides", () => {
    const flood: RoleLoad = { items_per_day: 61, decisions_per_day: 9, live_hands: 13, direct_reports: 0, open_stalls: 0, cap_hit_days: 0 };
    expect(overloadRatio(flood)).toBeCloseTo(9 / 4);
    expect(splitsOnFirstBreach(flood)).toBe(true);
    const first = capacityFlags(quietRole({ load: flood, breaches: 0 }));
    expect(first).toEqual([{ code: "overloaded", severity: "blocker", detail: "@growth carries 61 items changing a day (model: 30), 9 decisions a day (model: 4), 13 live hands (model: 6); split now: 2.3 times the model; ledger 3 open, 1 in flight, 1 active plan" }]);
    // 1.2 times the model on one axis: a warning on the first breach, a blocker on the second.
    const mild: RoleLoad = { ...quietLoad, items_per_day: 36 };
    expect(overloadRatio(mild)).toBeCloseTo(1.2);
    expect(splitsOnFirstBreach(mild)).toBe(false);
    expect(capacityFlags(quietRole({ load: mild, breaches: 0 }))[0]).toMatchObject({ severity: "warn", detail: expect.stringContaining("first breach on record") });
    expect(capacityFlags(quietRole({ load: mild, breaches: 1 }))[0]).toMatchObject({ severity: "blocker", detail: expect.stringContaining("this is breach 2") });
    // Exactly at the line counts as structural.
    expect(splitsOnFirstBreach({ ...quietLoad, decisions_per_day: 8 })).toBe(true);
    expect(STABILITY.split_on_first_breach_ratio.value).toBe(2);
  });

  test("a wide ledger under an overloaded flow points at the load rather than at filing", () => {
    const flags = capacityFlags(quietRole({ load: { ...quietLoad, live_hands: 7 }, ledger: { open_tasks: 40, in_flight: 2, active_plans: 1 } }));
    expect(codes(flags)).toEqual(["overloaded", "wide_ledger"]);
    expect(flags.find((f) => f.code === "wide_ledger")!.detail).toContain("read the load above for whether the seat fits");
  });
});

describe("a seat the work passes by", () => {
  const shipping = { decisions_7d: 0, median_recommend_min: null, review_stalls: 0, done_7d: 121, sends_7d: { to: [], from: [] }, hands_window: 0 };
  test("a scope that closes work with no hand under the seat and no decision routed to it is bypassed, not idle and not loaded", () => {
    const flags = capacityFlags(quietRole({ load: { ...quietLoad, live_hands: 0 }, ledger: { open_tasks: 20, in_flight: 8, active_plans: 1 }, flow: shipping }));
    expect(codes(flags)).toEqual(["bypassed"]);
    expect(flags[0]).toMatchObject({ severity: "warn" });
    expect(flags[0].detail).toContain("closed 121 tasks this week (line: 10) and holds 8 in flight, none of it through the seat");
  });
  test("one hand under the seat, one routed decision, a quiet scope or a reviewing seat clears it", () => {
    expect(capacityFlags(quietRole({ flow: { ...shipping, hands_window: 1 } }))).toEqual([]);
    expect(capacityFlags(quietRole({ flow: { ...shipping, decisions_7d: 1, median_recommend_min: 1 } }))).toEqual([]);
    expect(capacityFlags(quietRole({ flow: { ...shipping, done_7d: 9 } }))).toEqual([]);
    expect(capacityFlags(quietRole({ flow: shipping, reviews_only: true }))).toEqual([]);
  });
});

describe("live hands read against the role's own cap", () => {
  test("a seat whose person raised its hands cap to 12 is not overloaded at 7, and 12 is its line, not a split", () => {
    expect(capacityFlags(quietRole({ load: { ...quietLoad, live_hands: 7 } }))[0]).toMatchObject({ code: "overloaded", detail: expect.stringContaining("7 live hands (model: 6)") });
    expect(capacityFlags(quietRole({ load: { ...quietLoad, live_hands: 7, hands_cap: 12 } }))).toEqual([]);
    expect(overloadRatio({ ...quietLoad, live_hands: 12, hands_cap: 12 })).toBeCloseTo(1);
    expect(splitsOnFirstBreach({ ...quietLoad, live_hands: 12, hands_cap: 12 })).toBe(false);
    expect(capacityFlags(quietRole({ load: { ...quietLoad, live_hands: 13, hands_cap: 12 } }))[0].detail).toContain("13 live hands (model: 12)");
  });
});

describe("capacityFlags", () => {
  test("a role inside the model raises nothing", () => {
    expect(capacityFlags(quietRole())).toEqual([]);
  });

  test("span, spend, latency, stalls, idle, chatter and charter each raise their own code", () => {
    const flags = capacityFlags(quietRole({
      load: { ...quietLoad, direct_reports: 6 },
      spend: { wakes_today: 40, wakes_7d_avg: 3, wakes_cap: 40, tokens_today: 0, tokens_7d_avg: null, tokens_cap: 400_000, cap_hits_7d: 2 },
      flow: { decisions_7d: 3, median_recommend_min: 12, review_stalls: 2, done_7d: 1, sends_7d: { to: [{ handle: "billing", n: 4 }], from: [{ handle: "billing", n: 3 }] } },
      idle_days: 20,
      has_charter: false,
    }));
    expect(codes(flags)).toEqual(["cap_hit", "chatter", "idle", "no_charter", "review_stall", "slow_to_recommend", "wide_span"]);
    expect(flags.find((f) => f.code === "chatter")?.detail).toBe("@growth and @billing exchanged 7 sends this week (model: 5) against 1 task done");
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
    expect(capacityFlags(quietRole({ idle_days: null, age_days: 20 }))[0]).toMatchObject({ code: "idle", detail: expect.stringContaining("since the role was created 20 days ago (model: 14 days)") });
    expect(capacityFlags(quietRole({ idle_days: null, age_days: 20, scope_empty: true }))[0].detail).toContain("names no project or plan that still exists");
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
        tasks: [
          { short_id: "ct-9", title: "Wire it", status: "in_progress", last_session_activity_at: 1, reason: "commits landed, still open" },
          { short_id: "ct-10", title: "Filed and forgotten", status: "in_progress", last_session_activity_at: null, reason: "in progress, no session 14d" },
        ],
        projects: [{ id: "p2", title: "Legacy", reason: "no activity 30d" }],
      },
    });
    expect(stale).toEqual([
      { code: "stale_plan", severity: "info", detail: 'plan "Old push" (pl-3) is active but every task closed' },
      { code: "stale_task", severity: "info", detail: 'task "Wire it" (ct-9) is in progress: commits landed, still open' },
      { code: "stale_task", severity: "info", detail: 'task "Filed and forgotten" (ct-10) is in progress: in progress, no session 14d' },
      { code: "stale_project", severity: "info", detail: 'project "Legacy" has had no activity 30d' },
    ]);
    expect(capacityFlags(quietRole({ program_ended: { ended: "its plan pl-3 is done", then: "retire" } }))).toEqual([
      { code: "program_ended", severity: "warn", detail: "@growth is a program role and its plan pl-3 is done; its tenure says retire it" },
    ]);
    expect(capacityFlags(quietRole({ program_ended: null }))).toEqual([]);
  });
});
