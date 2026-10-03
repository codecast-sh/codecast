// The ownership rule's readers on the server (org-staffing.md S26, S35): what
// a task or a session is working on, as contracts/orgLead ownerOf reads it,
// which sessions a role may take by the rule, and the hold a binding gives or
// takes. A leaf over the db and the shared rule, so org.ts, orgInit.ts,
// orgRoles.ts, tasks.ts, plans.ts and orgLine.ts all import it without
// closing a cycle.

import type { Id } from "../_generated/dataModel";
import { coverDepth, isWholeWorkspaceRole, ownerOf, ownsWork, type OwnedWork } from "@codecast/shared/contracts/orgLead";
import { rolesInBoundary } from "./orgAccess";

type Ctx = { db: any; scheduler?: any };

// The work a task or a session is doing, as the ownership rule reads it
// (contracts/orgLead ownerOf, org-staffing.md S26): the plan it is filed
// under and the project it belongs to. A session's is its active task's,
// else its plan's. Its folder is not part of the work (S35): a session bound
// to nothing has no owner by the rule, whatever directory it runs in.
export async function taskWork(ctx: Ctx, t: { project_id?: any; plan_id?: any }): Promise<OwnedWork> {
  if (t.project_id || !t.plan_id) return { project_id: t.project_id, plan_id: t.plan_id };
  return { plan_id: t.plan_id, project_id: (await ctx.db.get(t.plan_id))?.project_id };
}

export async function sessionWork(ctx: Ctx, c: any): Promise<OwnedWork> {
  const task = c.active_task_id ? await ctx.db.get(c.active_task_id) : null;
  if (task) return taskWork(ctx, task);
  const planId = c.active_plan_id ?? c.plan_ids?.[0];
  if (planId) return { plan_id: planId, project_id: (await ctx.db.get(planId))?.project_id };
  return {};
}

/** A session is bound when it names a task or a plan (S35 "bound"). */
export const isBoundSession = (c: any): boolean => !!(c.active_task_id || c.active_plan_id || (c.plan_ids ?? []).length);

// Of the candidate sessions, the ones `role` owns by the rule and may take
// (S26): sitting with no role, or with a wider role that also covers them. A
// whole workspace role never takes a session a narrower role covers, and a
// session a person filed under a role that does not cover it stays where
// they put it. `roles` is the boundary's roles as the change leaves them,
// `role` among them.
export async function sessionsOwnedBy<T extends { raw: any }>(ctx: Ctx, role: any, roles: any[], candidates: T[]): Promise<T[]> {
  const byId = new Map(roles.map((r) => [String(r._id), r]));
  const out: T[] = [];
  for (const entry of candidates) {
    const c = entry.raw;
    if (c.org_role_id && String(c.org_role_id) === String(role._id)) continue;
    const work = await sessionWork(ctx, c);
    if (!ownsWork(role, work, roles)) continue;
    const filed = c.org_role_id ? byId.get(String(c.org_role_id)) : null;
    if (c.org_role_id && (!filed || filed.status === "retired" || coverDepth(filed, work) < 0)) continue;
    out.push(entry);
  }
  return out;
}

// Of the tasks in `role`'s scope, the open ones it takes by the rule (S26):
// assigned to a wider live role that also covers them, and owned by `role`
// now. The reverse of a retire's hand back (tasks.handOpenTasksUpChain).
export async function tasksOwnedBy(ctx: Ctx, role: any, roles: any[], tasks: any[]): Promise<Array<{ task: any; from: any }>> {
  const byAssignee = new Map<string, any>();
  for (const r of roles) if (r.status !== "retired") { byAssignee.set(String(r._id), r); byAssignee.set(`agent:${r.handle}`, r); }
  const out: Array<{ task: any; from: any }> = [];
  for (const task of tasks) {
    if (task.status === "done" || task.status === "dropped") continue;
    const from = task.assignee ? byAssignee.get(String(task.assignee)) : null;
    if (!from || String(from._id) === String(role._id)) continue;
    const work = await taskWork(ctx, task);
    if (coverDepth(from, work) < 0 || !ownsWork(role, work, roles)) continue;
    out.push({ task, from });
  }
  return out;
}

// ── The hold a binding gives or takes (org-staffing.md S35) ─────────────────
//
// A role holds a session for two reasons only: it is BOUND to work the role
// owns, or a person or role FILED it there (`conversations.org_role_hold`).
// This is read whenever a session's binding changes (a task start, a task
// closed, a plan bound or unbound, a session created on a task) and says what
// the hold should become now:
// - `file`: it sits under no role and a lead owns its work, so the lead takes
//   it, held as bound.
// - `move`: it is held as bound and another lead now owns its work.
// - `release`: it is held as bound and no lead owns its work any more (the
//   binding ended, or only the whole workspace covers it), so it returns to
//   whoever started it.
// - `keep`: nothing changes. A session a person filed is never moved by a
//   binding; a standing session, a done one and a killed one stay put; a
//   session whose host is not the lead's stays with its host, as the takeover
//   leaves it (rehomeSessions).
export type HoldChange =
  | { kind: "keep"; why: string }
  | { kind: "file" | "move"; role: any }
  | { kind: "release"; from: any };

export async function holdChangeFor(ctx: Ctx, c: any): Promise<HoldChange> {
  if (!c) return { kind: "keep", why: "no session" };
  if (c.standing_role_id || c.anchor_id) return { kind: "keep", why: "standing session" };
  if (c.inbox_killed_at || c.status === "done" || c.status === "killed") return { kind: "keep", why: "done" };
  if (c.org_role_id && c.org_role_hold !== "bound") return { kind: "keep", why: "filed" };
  const roles = await rolesInBoundary(ctx, c.team_id ? { team_id: c.team_id } : { scope_user_id: c.user_id });
  const owner = ownerOf(await sessionWork(ctx, c), roles);
  const lead = owner.kind === "owner" && !isWholeWorkspaceRole(owner.role) ? owner.role : null;
  const hostOf = String(c.owner_user_id ?? c.user_id);
  if (c.org_role_id) {
    if (lead && String(lead._id) === String(c.org_role_id)) return { kind: "keep", why: "still bound to its area" };
    if (lead && String(lead.host_user_id) === hostOf) return { kind: "move", role: lead };
    const from = roles.find((r) => String(r._id) === String(c.org_role_id)) ?? { _id: c.org_role_id };
    return { kind: "release", from };
  }
  if (!lead) return { kind: "keep", why: isBoundSession(c) ? "no lead owns its work" : "unbound" };
  if (String(lead.host_user_id) !== hostOf) return { kind: "keep", why: "another person's session" };
  return { kind: "file", role: lead };
}
