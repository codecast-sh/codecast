import { v } from "convex/values";
import { internalMutation, internalQuery } from "./functions";
import type { Id } from "./_generated/dataModel";
import { CHIEF_OF_STAFF_HANDLE } from "./lib/orgAccess";
import { roleStartsOnItsOwn } from "./lib/orgCaps";
import { trustForSwitch } from "@codecast/shared/contracts/roleAutonomy";

// One switch instead of trust stages (docs/architecture/org-staffing.md
// S23.1). A role a person hires from now on starts with the switch on; the
// roles that already exist were created at the old default (off), and the
// founder decided (2026-09-23) that every one of them turns on and the root
// stays off. This is that migration, in the shape of orgRootSeat: a read only
// plan that names every role the run would touch and why the rest are left,
// and a run that flips only the rows it is told to (`role_ids`), or all of
// the plan's `turn_on` rows when no list is given, and is a no op as a dry run.
//
//   npx convex run orgAutonomyDefault:autonomyDefaultPlan
//   npx convex run orgAutonomyDefault:turnOnExistingRoles '{"dry_run":true}'
//   npx convex run orgAutonomyDefault:turnOnExistingRoles '{"role_ids":["…"]}'
//
// (through packages/convex/deploy.sh's env; never a raw convex CLI against a
// tree behind origin/main). A row's `decide` already reads as on and is left
// as it is: the word is never written again, and never needs to be.

export type AutonomyDefaultAction =
  | "turn_on"       // an active or paused role whose switch is off: turn it on
  | "already_on"    // direct or decide: nothing to write
  | "root_off"      // the workspace's root role: stays off by design
  | "retired";      // a retired role: left alone

export type AutonomyDefaultRow = {
  role_id: Id<"org_roles">;
  short_id: string;
  handle: string;
  workspace: string;
  status: string;
  stored: string | null;
  action: AutonomyDefaultAction;
  /** The run was told to flip other rows; this one waits. */
  held?: boolean;
};

async function workspaceOf(ctx: { db: any }, role: any): Promise<string> {
  if (role.team_id) return (await ctx.db.get(role.team_id))?.name ?? String(role.team_id);
  const u = role.scope_user_id ? await ctx.db.get(role.scope_user_id) : null;
  return `${u?.name || u?.github_username || u?.email || String(role.scope_user_id ?? "?")} (personal)`;
}

export async function planAutonomyDefault(ctx: { db: any }): Promise<AutonomyDefaultRow[]> {
  const roles: any[] = await ctx.db.query("org_roles").collect();
  const out: AutonomyDefaultRow[] = [];
  for (const role of roles) {
    const action: AutonomyDefaultAction = role.status === "retired" ? "retired"
      : role.handle === CHIEF_OF_STAFF_HANDLE ? "root_off"
      : roleStartsOnItsOwn(role) ? "already_on"
      : "turn_on";
    out.push({ role_id: role._id, short_id: role.short_id, handle: role.handle, workspace: await workspaceOf(ctx, role), status: role.status, stored: role.trust ?? null, action });
  }
  return out.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.handle.localeCompare(b.handle));
}

export async function performTurnOnExistingRoles(ctx: { db: any }, dryRun: boolean, only?: ReadonlySet<string>): Promise<{ dry_run: boolean; rows: AutonomyDefaultRow[]; turned_on: number }> {
  const rows = await planAutonomyDefault(ctx);
  let turned_on = 0;
  const now = Date.now();
  for (const row of rows) {
    if (row.action !== "turn_on") continue;
    if (only && !only.has(String(row.role_id))) { row.held = true; continue; }
    if (dryRun) continue;
    await ctx.db.patch(row.role_id, { trust: trustForSwitch(true), updated_at: now });
    row.action = "already_on";
    row.stored = trustForSwitch(true);
    turned_on++;
  }
  return { dry_run: dryRun, rows, turned_on };
}

// Read only: which roles the run would turn on, and why the rest are left.
export const autonomyDefaultPlan = internalQuery({
  args: {},
  handler: async (ctx) => planAutonomyDefault(ctx),
});

// Run once, after the plan is read: `dry_run` writes nothing; `role_ids`
// flips only those rows (from the plan's `role_id`) and reports the rest held.
export const turnOnExistingRoles = internalMutation({
  args: { dry_run: v.optional(v.boolean()), role_ids: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => performTurnOnExistingRoles(ctx, !!args.dry_run, args.role_ids ? new Set(args.role_ids) : undefined),
});
