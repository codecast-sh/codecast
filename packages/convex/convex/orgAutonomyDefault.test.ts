import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performTurnOnExistingRoles, planAutonomyDefault } from "./orgAutonomyDefault";

// One switch instead of trust stages (org-staffing.md S23.1): the roles that
// exist today were created with the switch off. The migration turns every
// non root role on, leaves the root off, writes nothing as a dry run, and
// flips only the rows it is told to.

const TEAM = "teams_acme" as any;
const ME = "u".repeat(31) + "m";
function world() {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    org_roles: [
      { _id: "r_growth", short_id: "or-1", handle: "growth", status: "active", team_id: TEAM, trust: "understand" },
      { _id: "r_infra", short_id: "or-2", handle: "infra", status: "paused", team_id: TEAM },
      { _id: "r_ops", short_id: "or-3", handle: "ops", status: "active", team_id: TEAM, trust: "decide" },
      { _id: "r_old", short_id: "or-4", handle: "old", status: "retired", team_id: TEAM, trust: "understand" },
      { _id: "r_chief", short_id: "or-5", handle: "chief-of-staff", status: "active", team_id: TEAM, trust: "understand" },
      { _id: "r_mine", short_id: "or-6", handle: "mine", status: "active", scope_user_id: ME, trust: "understand" },
    ],
  };
  const db = makeFakeDb(tables);
  return { ctx: { db } as any, tables };
}

describe("orgAutonomyDefault", () => {
  test("the plan names every role and why: turn_on, already_on (decide reads as on), root_off, retired", async () => {
    const { ctx } = world();
    const rows = await planAutonomyDefault(ctx);
    expect(Object.fromEntries(rows.map((r) => [r.handle, r.action]))).toEqual({
      growth: "turn_on", infra: "turn_on", ops: "already_on", old: "retired", "chief-of-staff": "root_off", mine: "turn_on",
    });
    expect(rows.find((r) => r.handle === "mine")!.workspace).toBe("Me (personal)");
  });

  test("a dry run writes nothing; the run flips only the turn_on rows, and never decide, the root or a retired role", async () => {
    const { ctx, tables } = world();
    const dry = await performTurnOnExistingRoles(ctx, true);
    expect(dry.turned_on).toBe(0);
    expect(tables.org_roles.map((r) => r.trust)).toEqual(["understand", undefined, "decide", "understand", "understand", "understand"]);
    const run = await performTurnOnExistingRoles(ctx, false);
    expect(run.turned_on).toBe(3);
    expect(Object.fromEntries(tables.org_roles.map((r) => [r.handle, r.trust]))).toEqual({
      growth: "direct", infra: "direct", ops: "decide", old: "understand", "chief-of-staff": "understand", mine: "direct",
    });
    // Idempotent: a second run finds nothing to flip.
    expect((await performTurnOnExistingRoles(ctx, false)).turned_on).toBe(0);
  });

  test("an explicit list flips only those rows and reports the rest held", async () => {
    const { ctx, tables } = world();
    const run = await performTurnOnExistingRoles(ctx, false, new Set(["r_growth"]));
    expect(run.turned_on).toBe(1);
    expect(tables.org_roles.find((r) => r.handle === "growth")!.trust).toBe("direct");
    expect(tables.org_roles.find((r) => r.handle === "infra")!.trust).toBeUndefined();
    expect(run.rows.filter((r) => r.held).map((r) => r.handle).sort()).toEqual(["infra", "mine"]);
  });
});
