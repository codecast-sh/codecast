// The reads behind coverage.unplaced (ct-95900; the reading is
// lib/orgCoverage computeUnplaced). Every count comes from an index read of
// its own rather than from the capped task sample the rest of coverage
// shares: an open plan's tasks through by_plan_id, a project's open tasks
// through by_project_status, the week's loose tasks through
// by_workspace_updated. One query of its own (`part`), so the analyzer
// inputs, org health, the brief of a whole workspace role and the area watch
// each fan it beside their other reads instead of adding it to a budget
// already near its limit.

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { query } from "./functions";
import { collectOrgSessions, requireWorkspaceCaller, type OrgScan } from "./org";
import { WORK_STATUSES } from "./orgHealth";
import { readWorkspaceInitiatives } from "./lib/roleInitiatives";
import { computeUnplaced, INITIATIVE_OPEN, UNPLACED_RECENT_MS, type OrgUnplaced, type SessionRef, type UnplacedInputs } from "./lib/orgCoverage";
import { isOpenPlan, openPlansOf } from "@codecast/shared/contracts/openPlans";
import { isOnProjectBoard } from "@codecast/shared/tasks";
import { planDriver, sessionRefs, taskSession } from "./lib/planDriver";

type Ctx = { db: any };

/** Read bounds: a floor past any of them, and `truncated` says so. */
export const UNPLACED_READ = {
  /** Project-less open plans whose tasks are counted, newest first. */
  plans: 120,
  /** One plan's tasks, or one project's open tasks per status. */
  tasks_per_record: 400,
  /** The week's touched tasks of the workspace scanned for loose ones. */
  recent_tasks: 2500,
  /** Open plans of the workspace, per status. */
  open_plans: 600,
  /** Long running sessions whose bound work is resolved. */
  sessions: 60,
} as const;

const isOpenTask = (t: any) => isOnProjectBoard(t) && t.status !== "done";

/** The driving session of each open plan a goal lists under its projects
 *  (openPlansOf), by plan id: the plan's own session fields, no task read. */
export async function planDriverRefs(ctx: Ctx, plans: any[], initiatives: Array<{ status: string; project_ids?: unknown[] }>): Promise<Map<string, SessionRef | null>> {
  const refOf = sessionRefs(ctx);
  const out = new Map<string, SessionRef | null>();
  const projectIds = new Set<string>();
  for (const i of initiatives) if (INITIATIVE_OPEN.has(i.status)) for (const id of i.project_ids ?? []) projectIds.add(String(id));
  for (const id of projectIds) for (const p of openPlansOf(plans, id).plans) out.set(String(p._id), await planDriver(refOf, p, []));
  return out;
}

/** Every open plan of the workspace, through the status index and the
 *  workspace key on the row: no per-row conversation read (scopedFetch makes
 *  one per linked conversation, which on Union took a query past the 4096
 *  read limit). Bodies are dropped. */
export async function readOpenPlans(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined): Promise<any[]> {
  const key = teamId ? `team:${teamId}` : `user:${userId}`;
  const out: any[] = [];
  for (const status of ["active", "draft", "paused"] as const) {
    const q = teamId
      ? ctx.db.query("plans").withIndex("by_team_status", (r: any) => r.eq("team_id", teamId).eq("status", status))
      : ctx.db.query("plans").withIndex("by_user_status", (r: any) => r.eq("user_id", userId).eq("status", status));
    for (const p of await q.take(UNPLACED_READ.open_plans)) if (p.workspace === key) { const { body: _body, ...rest } = p; out.push(rest); }
  }
  return out;
}

export async function readUnplaced(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number, given: { scan?: OrgScan; plans?: any[]; projects?: any[] } = {}): Promise<OrgUnplaced> {
  const workspace = teamId ? `team:${teamId}` : `user:${userId}`;
  const [plans, projects, initiatives] = await Promise.all([
    given.plans ?? readOpenPlans(ctx, userId, teamId),
    given.projects ?? ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(200),
    readWorkspaceInitiatives(ctx, workspace),
  ]);
  const refOf = sessionRefs(ctx);
  let truncated = false;
  const take = async (q: any, cap: number) => { const rows: any[] = await q.take(cap); if (rows.length >= cap) truncated = true; return rows; };

  const goalProjects = new Set<string>();
  for (const i of initiatives) if (INITIATIVE_OPEN.has(i.status)) for (const id of i.project_ids ?? []) goalProjects.add(String(id));
  const openPlans = plans.filter((p) => isOpenPlan(p.status));

  // Open plans with no project: each one's tasks counted through its own index.
  const loosePlans = openPlans.filter((p) => !p.project_id).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  if (loosePlans.length > UNPLACED_READ.plans) truncated = true;
  const planFacts: UnplacedInputs["plans"] = [];
  for (const p of loosePlans.slice(0, UNPLACED_READ.plans)) {
    const tasks = (await take(ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", p._id)), UNPLACED_READ.tasks_per_record)).filter(isOnProjectBoard);
    const open = tasks.filter(isOpenTask);
    planFacts.push({
      short_id: p.short_id, title: p.title, status: p.status,
      created_at: p.created_at ?? p._creationTime, updated_at: p.updated_at ?? p._creationTime,
      tasks: { open: open.length, done: tasks.filter((t) => t.status === "done").length, last_at: tasks.length ? Math.max(...tasks.map((t) => t.updated_at ?? 0)) : null },
      driver: await planDriver(refOf, p, open.length ? open : tasks),
    });
  }

  // Active projects no open goal carries, with their open work counted by index.
  const openPlansByProject = new Map<string, any[]>();
  for (const p of openPlans) if (p.project_id) openPlansByProject.set(String(p.project_id), [...(openPlansByProject.get(String(p.project_id)) ?? []), p]);
  const projectFacts: UnplacedInputs["projects"] = [];
  for (const p of projects) {
    if (p.status !== "active" || goalProjects.has(String(p._id))) continue;
    const open: any[] = [];
    for (const status of WORK_STATUSES) {
      open.push(...(await take(ctx.db.query("tasks").withIndex("by_project_status", (q: any) => q.eq("project_id", p._id).eq("status", status)), UNPLACED_READ.tasks_per_record)).filter(isOpenTask));
    }
    const itsPlans = openPlansByProject.get(String(p._id)) ?? [];
    if (!open.length && !itsPlans.length) continue;
    const newestPlan = [...itsPlans].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
    const newestTask = [...open].filter(taskSession).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
    const driver = newestPlan && (!newestTask || (newestPlan.updated_at ?? 0) >= (newestTask.updated_at ?? 0))
      ? await planDriver(refOf, newestPlan, [])
      : newestTask ? await refOf(taskSession(newestTask)) : null;
    const lead = p.owner_role_id ? await ctx.db.get(p.owner_role_id) : null;
    projectFacts.push({
      short_id: p.short_id ?? undefined, title: p.title, status: p.status,
      created_at: p.created_at ?? p._creationTime, updated_at: p.updated_at ?? p._creationTime,
      open_tasks: open.length, open_plans: itsPlans.length,
      lead: lead && lead.status !== "retired" ? `@${lead.handle}` : null,
      has_goal: false,
      last_at: Math.max(0, ...open.map((t) => t.updated_at ?? 0), ...itsPlans.map((x) => x.updated_at ?? 0)) || null,
      driver,
    });
  }

  // The week's open tasks under neither a plan nor a project.
  const recent = await take(ctx.db.query("tasks").withIndex("by_workspace_updated", (q: any) => q.eq("workspace", workspace).gte("updated_at", now - UNPLACED_RECENT_MS)).order("desc"), UNPLACED_READ.recent_tasks);
  const looseTasks: UnplacedInputs["loose_tasks"] = [];
  for (const t of recent) {
    if (t.plan_id || t.project_id || !isOpenTask(t)) continue;
    looseTasks.push({ short_id: t.short_id, title: String(t.title ?? "").slice(0, 120), created_at: t.created_at ?? t._creationTime, updated_at: t.updated_at ?? t._creationTime, session: await refOf(t.created_from_conversation ?? t.first_linked_conversation) });
  }

  // Sessions a week old or more, still moving, whose bound work reaches no open goal.
  const scan = given.scan ?? await collectOrgSessions(ctx, userId, teamId, now);
  const planById = new Map<string, any>(plans.map((p) => [String(p._id), p]));
  const getPlan = async (id: unknown) => planById.get(String(id)) ?? (await ctx.db.get(id as Id<"plans">));
  const old = Array.from(scan.sessions.values())
    .map(({ raw }) => raw)
    .filter((c) => !c.anchor_id && !c.standing_role_id && (c.active_task_id || c.active_plan_id || c.plan_ids?.length))
    .filter((c) => now - (c.started_at ?? c._creationTime) >= 7 * 86_400_000 && now - (c.updated_at ?? 0) < UNPLACED_RECENT_MS)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  if (old.length > UNPLACED_READ.sessions) truncated = true;
  const sessionFacts: UnplacedInputs["sessions"] = [];
  for (const c of old.slice(0, UNPLACED_READ.sessions)) {
    const bound: UnplacedInputs["sessions"][number]["bound"] = [];
    const reach = (project: unknown) => ({ project: project ? String(project) : null, reaches_goal: !!project && goalProjects.has(String(project)) });
    const task = c.active_task_id ? await ctx.db.get(c.active_task_id) : null;
    if (task) {
      const plan = task.plan_id ? await getPlan(task.plan_id) : null;
      bound.push({ kind: "task", short_id: task.short_id, title: task.title, ...reach(task.project_id ?? plan?.project_id) });
    }
    for (const id of new Set([c.active_plan_id, ...(c.plan_ids ?? [])].filter(Boolean).map(String))) {
      const plan = await getPlan(id);
      if (plan && isOpenPlan(plan.status)) bound.push({ kind: "plan", short_id: plan.short_id, title: plan.title, ...reach(plan.project_id) });
    }
    if (!bound.length) continue;
    const owner = await ctx.db.get(c.user_id);
    sessionFacts.push({ short_id: c.short_id ?? String(c._id).slice(0, 7), title: String(c.title ?? "").slice(0, 100), owner: owner?.name ?? undefined, started_at: c.started_at ?? c._creationTime, updated_at: c.updated_at ?? c._creationTime, bound });
  }

  return computeUnplaced({ now, plans: planFacts, projects: projectFacts, loose_tasks: looseTasks, sessions: sessionFacts, truncated: truncated || scan.truncated });
}

/** The unplaced reading for a member of the workspace (the analyzer inputs, health, the brief). */
export const part = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<OrgUnplaced | null> => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    return readUnplaced(ctx, userId, args.team_id, args.now ?? Date.now());
  },
});

/** The same reading with the host's grants, for the area watch. */
export const internalPart = internalQuery({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")), now: v.number() },
  handler: async (ctx, args): Promise<OrgUnplaced> => readUnplaced(ctx, args.user_id, args.team_id, args.now),
});
