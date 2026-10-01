// The area watch (docs/architecture/org-staffing.md S29): the loop keeps
// itself current. Every few hours one pass reads org.health for each
// workspace with a Head of People, remembers each area's status on its role
// row, and when a pressing status has held across two passes in a row, or a
// project with work has no owner, tells the Head of People once per episode
// through its own event trigger (lib/orgRoutine HEAD_AREA_CHANGE_SPEC), the
// same machinery a waiting session uses to reach a lead (S28): one trigger on
// the Head of People, visible and controllable on its page, the change in its frame.
//
// The plan is pure (planAreaWatch) so the rule is tested without a database;
// the sweep is an action that fans the health read the way healthReport does
// and applies each workspace's plan in one mutation.

import { internalAction, internalQuery } from "./_generated/server";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { AREA_STATUS_ATTENTION, areaChangeLine, type AreaChange, type AreaStatus } from "@codecast/shared/contracts/orgAreas";
import { HEAD_OF_PEOPLE_HANDLE } from "@codecast/shared/contracts/orgLead";
import { computeOrgHealth, HEALTH_CAPS, HEALTH_WINDOW_7D_MS, healthMembersAndRoles, readHealthDecisions, readWorkTasks, type HealthDecisions, type WorkTasks } from "./orgHealth";
import { fireRoleEvent } from "./agentTasks";
import { HEAD_AREA_CHANGE_SPEC } from "./lib/orgRoutine";

/** How often a pass runs (crons.ts). Two passes in a row is the bar an area
 *  status clears before it reaches the Head of People, so a status must hold this long. */
export const AREA_WATCH_EVERY_HOURS = 6;
/** How many passes in a row a pressing status holds before the Head of People hears of it. */
export const AREA_WATCH_PASSES = 2;

export type AreaWatch = { status: string; since: number; passes: number; from?: string; told?: string; told_at?: number };
export type UnownedTold = { id: string; since: number };

export type WatchRoleInput = { role_id: string; handle: string; name: string; status: AreaStatus; status_line: string; area_watch: AreaWatch | null };
export type WatchInput = {
  now: number;
  roles: WatchRoleInput[];
  head: { role_id: string; unowned_told: UnownedTold[] };
  unowned: Array<{ id: string; title: string }>;
};
export type WatchPlan = {
  role_writes: Array<{ role_id: string; area_watch: AreaWatch }>;
  head_write: { role_id: string; unowned_told: UnownedTold[] } | null;
  changes: Array<{ change: AreaChange; client_id: string }>;
};

/** What this pass writes and what it tells the Head of People. Pure. */
export function planAreaWatch(input: WatchInput): WatchPlan {
  const { now } = input;
  const role_writes: WatchPlan["role_writes"] = [];
  const changes: WatchPlan["changes"] = [];
  for (const r of input.roles) {
    const prev = r.area_watch;
    const same = !!prev && prev.status === r.status;
    // An episode is one unbroken run of a status: it starts when the status
    // changes, remembers what it changed from, and forgets what was told.
    const next: AreaWatch = same
      ? { ...prev!, passes: prev!.passes + 1 }
      : { status: r.status, since: now, passes: 1, ...(prev?.status ? { from: prev.status } : {}) };
    const pressing = AREA_STATUS_ATTENTION[r.status] === "head";
    if (pressing && next.passes >= AREA_WATCH_PASSES && next.told !== r.status) {
      next.told = r.status;
      next.told_at = now;
      const change: AreaChange = { kind: "status", role_handle: r.handle, role_name: r.name, from: (next.from as AreaStatus | undefined) ?? null, to: r.status, since: next.since, line: r.status_line };
      changes.push({ change, client_id: `area-change:${r.role_id}:${r.status}:${next.since}` });
    }
    if (!prev || prev.status !== next.status || prev.passes !== next.passes || prev.told !== next.told) role_writes.push({ role_id: r.role_id, area_watch: next });
  }
  // A project with work and no owner is told once, and again only after it
  // gained an owner and lost it: the told list is pruned to the projects
  // still unowned.
  const current = new Map(input.unowned.map((p) => [p.id, p]));
  const told = input.head.unowned_told.filter((t) => current.has(t.id));
  for (const p of input.unowned) {
    if (told.some((t) => t.id === p.id)) continue;
    told.push({ id: p.id, since: now });
    const change: AreaChange = { kind: "unowned_project", project_id: p.id, project_title: p.title, since: now, line: "No role's area includes it." };
    changes.push({ change, client_id: `area-change:project:${p.id}:${now}` });
  }
  const before = input.head.unowned_told;
  const changed = told.length !== before.length || told.some((t, i) => before[i]?.id !== t.id || before[i]?.since !== t.since);
  return { role_writes, head_write: changed ? { role_id: input.head.role_id, unowned_told: told } : null, changes };
}

/** The workspaces a pass reads: one per live Head of People with a seat,
 *  read with its host's grants. */
export const listWatched = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ head_of_people_id: Id<"org_roles">; user_id: Id<"users">; team_id?: Id<"teams"> }>> => {
    const roles: any[] = await ctx.db.query("org_roles").take(5000);
    return roles
      .filter((r) => r.handle === HEAD_OF_PEOPLE_HANDLE && r.status === "active" && r.anchor_id)
      .map((r) => ({ head_of_people_id: r._id, user_id: r.host_user_id, ...(r.team_id ? { team_id: r.team_id } : {}) }));
  },
});

// The health read fanned as healthReport fans it, without a caller: the
// decision ladder and the open task set in their own budgets, then the core.
export const decisionsPart = internalQuery({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")), now: v.number() },
  handler: async (ctx, args): Promise<HealthDecisions> => {
    const { memberIds, roleIds } = await healthMembersAndRoles(ctx, args.user_id, args.team_id);
    return readHealthDecisions(ctx, args.team_id, memberIds, roleIds, args.now);
  },
});

export const workPart = internalQuery({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")), now: v.number() },
  handler: async (ctx, args): Promise<WorkTasks> =>
    readWorkTasks(ctx, args.user_id, args.team_id, { perStatus: HEALTH_CAPS.tasks, updatedSince: args.now - HEALTH_WINDOW_7D_MS, recentCap: HEALTH_CAPS.recent_tasks }),
});

/** The plan for one workspace: health computed, the rows' watch state read
 *  beside it, the rule applied. */
export async function performPlanAreaWatch(ctx: { db: any }, userId: Id<"users">, teamId: Id<"teams"> | undefined, headId: Id<"org_roles">, now: number, parts?: { decisions?: HealthDecisions; work?: WorkTasks }): Promise<WatchPlan> {
  const health = await computeOrgHealth(ctx, userId, teamId, now, parts);
  const roles: WatchRoleInput[] = [];
  for (const row of health.roles as any[]) {
    const role = await ctx.db.get(row.role_id);
    if (!role || role.status === "retired") continue;
    roles.push({ role_id: String(row.role_id), handle: row.handle, name: row.name, status: row.area.status, status_line: row.area.status_line, area_watch: role.area_watch ?? null });
  }
  const head = await ctx.db.get(headId);
  return planAreaWatch({ now, roles, head: { role_id: String(headId), unowned_told: head?.unowned_told ?? [] }, unowned: health.company.unowned_projects });
}

export const planPart = internalQuery({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")), head_of_people_id: v.id("org_roles"), now: v.number(), decisions: v.optional(v.any()), work: v.optional(v.any()) },
  handler: async (ctx, args): Promise<WatchPlan> =>
    performPlanAreaWatch(ctx, args.user_id, args.team_id, args.head_of_people_id, args.now, { decisions: args.decisions as HealthDecisions | undefined, work: args.work as WorkTasks | undefined }),
});

/** Write the plan: the watch state on each role, and one firing of the
 *  Head of People's trigger per change. A Head of People that cannot be reached (paused,
 *  cancelled trigger, org off) is not told, and the episode stays told, so
 *  nothing fires twice when it comes back; the panel shows the status live
 *  either way. Returns how many changes reached the Head of People. */
export async function performApplyAreaWatch(ctx: any, headId: Id<"org_roles">, plan: WatchPlan): Promise<number> {
  for (const w of plan.role_writes) await ctx.db.patch(w.role_id, { area_watch: w.area_watch });
  if (plan.head_write) await ctx.db.patch(plan.head_write.role_id, { unowned_told: plan.head_write.unowned_told });
  let told = 0;
  for (const c of plan.changes) {
    const id = await fireRoleEvent(ctx, headId, HEAD_AREA_CHANGE_SPEC, { change: { ...c.change, line: areaChangeLine(c.change) } }, c.client_id);
    if (id) told++;
  }
  return told;
}

export const apply = internalMutation({
  args: { head_of_people_id: v.id("org_roles"), plan: v.any() },
  handler: async (ctx, args): Promise<number> => performApplyAreaWatch(ctx as any, args.head_of_people_id, args.plan as WatchPlan),
});

/** One pass over every watched workspace (crons.ts, every AREA_WATCH_EVERY_HOURS). */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<{ workspaces: number; told: number; failed: number }> => {
    const watched: Array<{ head_of_people_id: Id<"org_roles">; user_id: Id<"users">; team_id?: Id<"teams"> }> = await ctx.runQuery(internal.orgWatch.listWatched, {});
    let told = 0, failed = 0;
    for (const w of watched) {
      const now = Date.now();
      try {
        const [decisions, work] = await Promise.all([
          ctx.runQuery(internal.orgWatch.decisionsPart, { user_id: w.user_id, team_id: w.team_id, now }),
          ctx.runQuery(internal.orgWatch.workPart, { user_id: w.user_id, team_id: w.team_id, now }),
        ]);
        const plan: WatchPlan = await ctx.runQuery(internal.orgWatch.planPart, { user_id: w.user_id, team_id: w.team_id, head_of_people_id: w.head_of_people_id, now, decisions, work });
        told += await ctx.runMutation(internal.orgWatch.apply, { head_of_people_id: w.head_of_people_id, plan });
      } catch (e) {
        // One workspace's read past its budget must not stop the rest.
        failed++;
        console.warn("org_area_watch_failed", { head_of_people_id: w.head_of_people_id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { workspaces: watched.length, told, failed };
  },
});
