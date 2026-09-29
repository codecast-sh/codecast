// The ownership rule's readers on the server (org-staffing.md S26): what a
// task or a session is working on, as contracts/orgLead ownerOf reads it, and
// which sessions a role may take by the rule. A leaf over the db and the
// shared rule, so org.ts, orgInit.ts, orgRoles.ts, tasks.ts and orgLine.ts
// all import it without closing a cycle.

import type { Id } from "../_generated/dataModel";
import { coverDepth, ownsWork, type OwnedWork } from "@codecast/shared/contracts/orgLead";

type Ctx = { db: any };

// The work a task or a session is doing, as the ownership rule reads it
// (contracts/orgLead ownerOf, org-staffing.md S26): the plan it is filed
// under and the project it belongs to. A session's is its active task's,
// else its plan's, else the project on its path. Only a project some role
// lists can make a role more specific than the whole workspace, so the path
// is looked up among those (projectsListedBy).
export async function taskWork(ctx: Ctx, t: { project_id?: any; plan_id?: any }): Promise<OwnedWork> {
  if (t.project_id || !t.plan_id) return { project_id: t.project_id, plan_id: t.plan_id };
  return { plan_id: t.plan_id, project_id: (await ctx.db.get(t.plan_id))?.project_id };
}

export async function sessionWork(ctx: Ctx, c: any, projectOfPath: Map<string, string>): Promise<OwnedWork> {
  const task = c.active_task_id ? await ctx.db.get(c.active_task_id) : null;
  if (task) return taskWork(ctx, task);
  const pathProject = c.project_path ? projectOfPath.get(c.project_path) : undefined;
  const planId = c.active_plan_id ?? c.plan_ids?.[0];
  if (planId) return { plan_id: planId, project_id: (await ctx.db.get(planId))?.project_id ?? pathProject };
  return { project_id: pathProject };
}

export async function projectsListedBy(ctx: Ctx, roles: any[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = new Set(roles.flatMap((r) => (r.scope?.project_ids ?? []).map(String)));
  for (const id of ids) {
    const p = await ctx.db.get(id as Id<"projects">);
    if (p?.project_path) out.set(p.project_path, String(p._id));
  }
  return out;
}

// Of the candidate sessions, the ones `role` owns by the rule and may take
// (S26): sitting with no role, or with a wider role that also covers them. A
// whole workspace role never takes a session a narrower role covers, and a
// session a person filed under a role that does not cover it stays where
// they put it. `roles` is the boundary's roles as the change leaves them,
// `role` among them.
export async function sessionsOwnedBy<T extends { raw: any }>(ctx: Ctx, role: any, roles: any[], candidates: T[]): Promise<T[]> {
  const projectOfPath = await projectsListedBy(ctx, roles);
  const byId = new Map(roles.map((r) => [String(r._id), r]));
  const out: T[] = [];
  for (const entry of candidates) {
    const c = entry.raw;
    if (c.org_role_id && String(c.org_role_id) === String(role._id)) continue;
    const work = await sessionWork(ctx, c, projectOfPath);
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
