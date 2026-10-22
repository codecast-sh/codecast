import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performTurnOnExistingRoles, planAutonomyDefault } from "./orgAutonomyDefault";

// One switch instead of trust stages (org-staffing.md S23.1): the roles that
// exist today were created with the switch off. The migration turns every
// live role on, the root included, clears the daily limits a person set
// (keeping the line's own settings), writes nothing as a dry run, and flips
// only the rows it is told to.

const TEAM = "teams_acme" as any;
const ME = "u".repeat(31) + "m";
function world() {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    org_roles: [
      { _id: "r_growth", short_id: "or-1", handle: "growth", status: "active", team_id: TEAM, trust: "understand" },
      { _id: "r_infra", short_id: "or-2", handle: "infra", status: "paused", team_id: TEAM, trust: "understand" },
      { _id: "r_ops", short_id: "or-3", handle: "ops", status: "active", team_id: TEAM, trust: "decide", caps: { hands_per_day: 5, tokens_per_day: 100, cards: 2, line_on: true } },
      { _id: "r_old", short_id: "or-4", handle: "old", status: "retired", team_id: TEAM, trust: "understand", caps: { hands_per_day: 1 } },
      { _id: "r_head", short_id: "or-5", handle: "head-of-people", status: "active", team_id: TEAM, trust: "understand" },
      { _id: "r_mine", short_id: "or-6", handle: "mine", status: "active", scope_user_id: ME, trust: "understand" },
    ],
  };
  const db = makeFakeDb(tables);
  return { ctx: { db } as any, tables };
}

describe("orgAutonomyDefault", () => {
  test("the plan names every role and why: turn_on, already_on (decide reads as on), retired, and the limits it clears", async () => {
    const { ctx } = world();
    const rows = await planAutonomyDefault(ctx);
    expect(Object.fromEntries(rows.map((r) => [r.handle, r.action]))).toEqual({
      growth: "turn_on", infra: "turn_on", ops: "already_on", old: "retired", "head-of-people": "turn_on", mine: "turn_on",
    });
    expect(rows.find((r) => r.handle === "ops")!.limits).toEqual({ hands_per_day: 5, tokens_per_day: 100 });
    expect(rows.find((r) => r.handle === "old")!.limits).toBeUndefined();
    expect(rows.find((r) => r.handle === "mine")!.workspace).toBe("Me (personal)");
  });

  test("a dry run writes nothing; the run flips the turn_on rows, clears limits, and never touches decide's word or a retired role", async () => {
    const { ctx, tables } = world();
    const dry = await performTurnOnExistingRoles(ctx, true);
    expect(dry.turned_on).toBe(0);
    expect(tables.org_roles.map((r) => r.trust)).toEqual(["understand", "understand", "decide", "understand", "understand", "understand"]);
    const run = await performTurnOnExistingRoles(ctx, false);
    expect(run.turned_on).toBe(4);
    expect(run.limits_cleared).toBe(1);
    expect(Object.fromEntries(tables.org_roles.map((r) => [r.handle, r.trust]))).toEqual({
      growth: "direct", infra: "direct", ops: "decide", old: "understand", "head-of-people": "direct", mine: "direct",
    });
    expect(tables.org_roles.find((r) => r.handle === "ops")!.caps).toEqual({ cards: 2, line_on: true });
    expect(tables.org_roles.find((r) => r.handle === "old")!.caps).toEqual({ hands_per_day: 1 });
    // Idempotent: a second run finds nothing to flip or clear.
    const again = await performTurnOnExistingRoles(ctx, false);
    expect([again.turned_on, again.limits_cleared]).toEqual([0, 0]);
  });

  test("an explicit list flips only those rows and reports the rest held", async () => {
    const { ctx, tables } = world();
    const run = await performTurnOnExistingRoles(ctx, false, new Set(["r_growth"]));
    expect(run.turned_on).toBe(1);
    expect(tables.org_roles.find((r) => r.handle === "growth")!.trust).toBe("direct");
    expect(tables.org_roles.find((r) => r.handle === "infra")!.trust).toBe("understand");
    expect(run.rows.filter((r) => r.held).map((r) => r.handle).sort()).toEqual(["head-of-people", "infra", "mine", "ops"]);
  });
});
