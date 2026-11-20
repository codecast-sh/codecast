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
import { isActiveTask, isOnProjectBoard } from "@codecast/shared/tasks";
import { planDriver, sessionRefs, taskSession } from "./lib/planDriver";
import { canAccessPlan, canAccessTask } from "./lib/access";

type Ctx = { db: any };

/** Read bounds: a floor past any of them, and `truncated` says so. The
 *  per-section caps keep one section from starving the rest; `budget` is the
 *  whole query's: every document this reading fetches (rows from an index read
 *  and single gets) counts against it, and a section that finds it spent stops
 *  there. Convex refuses a query past 4096 reads (the prod backend's limit,
 *  seen on Union 2026-11-17), and the session scan and the access checks read
 *  beside this, so the budget leaves them the rest. */
export const UNPLACED_READ = {
  budget: 2400,
  /** Open plans of the workspace, per status. */
  open_plans: 300,
  /** Project-less open plans whose tasks are counted, those with open work first. */
  plans: 60,
  /** One plan's tasks, or one project's open tasks per status. */
  tasks_per_record: 80,
  /** Active projects with no open goal whose open work is counted. */
  projects: 40,
  /** The week's touched tasks of the workspace scanned for loose ones. */
  recent_tasks: 600,
  /** Long running sessions whose bound work is resolved. */
  sessions: 30,
} as const;

/** Index reads and gets counted against one budget (UNPLACED_READ.budget). */
export function budgetedReads(ctx: Ctx, budget: number = UNPLACED_READ.budget) {
  let left = budget;
  let hit = false;
  return {
    get truncated() { return hit; },
    get left() { return left; },
    /** Up to `cap` rows, fewer when the budget is short; a full or cut read marks the reading a floor. */
    take: async (q: any, cap: number): Promise<any[]> => {
      const n = Math.min(cap, left);
      if (n <= 0) { hit = true; return []; }
      const rows: any[] = await q.take(n);
      left -= rows.length;
      if (rows.length >= n) hit = true;
      return rows;
    },
    get: async (id: unknown): Promise<any> => {
      if (left <= 0) { hit = true; return null; }
      left--;
      return id ? ctx.db.get(id) : null;
    },
  };
}
type Reads = ReturnType<typeof budgetedReads>;

const isOpen = (t: any) => t.status !== "done" && t.status !== "dropped";
/** A plan's own work and a loose task: every real task (isActiveTask), agent-filed ones included, the rows a plan's progress counts. A plan an agent filled is still work in flight. */
const isOpenWork = (t: any) => isActiveTask(t) && isOpen(t);
/** A project's open work as its board lists it, the rule coverage.projects counts by. */
const isOpenOnBoard = (t: any) => isOnProjectBoard(t) && isOpen(t);

/** The driving session of each open plan a goal lists under its projects
 *  (openPlansOf), by plan id: the plan's own session fields, no task read. */
export async function planDriverRefs(ctx: Ctx, viewer: Id<"users">, plans: any[], initiatives: Array<{ status: string; project_ids?: unknown[] }>): Promise<Map<string, SessionRef | null>> {
  const refOf = sessionRefs(ctx, viewer);
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
export async function readOpenPlans(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, reads: Reads = budgetedReads(ctx)): Promise<any[]> {
  const key = teamId ? `team:${teamId}` : `user:${userId}`;
  const out: any[] = [];
  for (const status of ["active", "draft", "paused"] as const) {
    const q = teamId
      ? ctx.db.query("plans").withIndex("by_team_status", (r: any) => r.eq("team_id", teamId).eq("status", status))
      : ctx.db.query("plans").withIndex("by_user_status", (r: any) => r.eq("user_id", userId).eq("status", status));
    for (const p of await reads.take(q, UNPLACED_READ.open_plans)) if (p.workspace === key) { const { body: _body, ...rest } = p; out.push(rest); }
  }
  return out;
}

export async function readUnplaced(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number, given: { scan?: OrgScan; plans?: any[]; projects?: any[] } = {}): Promise<OrgUnplaced> {
  const workspace = teamId ? `team:${teamId}` : `user:${userId}`;
  const reads = budgetedReads(ctx);
  const plans = given.plans ?? await readOpenPlans(ctx, userId, teamId, reads);
  const projects = given.projects ?? await reads.take(ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)), 200);
  const initiatives = await readWorkspaceInitiatives(ctx, workspace);
  // Session lookups go through the budget too: each is one get.
  const refOf = sessionRefs({ db: { get: reads.get, query: ctx.db.query.bind(ctx.db), normalizeId: ctx.db.normalizeId?.bind(ctx.db) } }, userId);
  let truncated = false;
  const take = reads.take;

  const goalProjects = new Set<string>();
  for (const i of initiatives) if (INITIATIVE_OPEN.has(i.status)) for (const id of i.project_ids ?? []) goalProjects.add(String(id));
  const openPlans = plans.filter((p) => isOpenPlan(p.status));

  // Open plans with no project: each one's tasks counted through its own index.
  // Those whose stored progress says they hold open work come first, so the
  // cap never trades a plan with open tasks for a newer empty one.
  const storedOpen = (p: any) => ((p.progress?.open ?? 0) + (p.progress?.in_progress ?? 0) > 0 ? 1 : 0);
  const loosePlans = openPlans.filter((p) => !p.project_id).sort((a, b) => storedOpen(b) - storedOpen(a) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  if (loosePlans.length > UNPLACED_READ.plans) truncated = true;
  const planFacts: UnplacedInputs["plans"] = [];
  for (const p of loosePlans.slice(0, UNPLACED_READ.plans)) {
    const tasks = (await take(ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", p._id)), UNPLACED_READ.tasks_per_record)).filter((t) => isActiveTask(t) && t.status !== "dropped");
    const open = tasks.filter(isOpenWork);
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
  const ungoaled = projects.filter((p) => p.status === "active" && !goalProjects.has(String(p._id)));
  if (ungoaled.length > UNPLACED_READ.projects) truncated = true;
  for (const p of ungoaled.slice(0, UNPLACED_READ.projects)) {
    const open: any[] = [];
    for (const status of WORK_STATUSES) {
      open.push(...(await take(ctx.db.query("tasks").withIndex("by_project_status", (q: any) => q.eq("project_id", p._id).eq("status", status)), UNPLACED_READ.tasks_per_record)).filter(isOpenOnBoard));
    }
    const itsPlans = openPlansByProject.get(String(p._id)) ?? [];
    if (!open.length && !itsPlans.length) continue;
    const newestPlan = [...itsPlans].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
    const newestTask = [...open].filter(taskSession).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
    const driver = newestPlan && (!newestTask || (newestPlan.updated_at ?? 0) >= (newestTask.updated_at ?? 0))
      ? await planDriver(refOf, newestPlan, [])
      : newestTask ? await refOf(taskSession(newestTask)) : null;
    const lead = p.owner_role_id ? await reads.get(p.owner_role_id) : null;
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
    if (t.plan_id || t.project_id || !isOpenWork(t)) continue;
    looseTasks.push({ short_id: t.short_id, title: String(t.title ?? "").slice(0, 120), created_at: t.created_at ?? t._creationTime, updated_at: t.updated_at ?? t._creationTime, session: await refOf(t.created_from_conversation ?? t.first_linked_conversation) });
  }

  // Sessions a week old or more, still moving, whose bound work reaches no open goal.
  const scan = given.scan ?? await collectOrgSessions(ctx, userId, teamId, now);
  const planById = new Map<string, any>(plans.map((p) => [String(p._id), p]));
  const getPlan = async (id: unknown) => planById.get(String(id)) ?? (await reads.get(id));
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
    // Only the records the caller may read are named: a teammate's private
    // task or plan bound to a session the team can see stays unnamed.
    const task = c.active_task_id ? await reads.get(c.active_task_id) : null;
    if (task && (await canAccessTask(ctx as any, userId, task))) {
      const plan = task.plan_id ? await getPlan(task.plan_id) : null;
      bound.push({ kind: "task", short_id: task.short_id, title: task.title, ...reach(task.project_id ?? plan?.project_id) });
    }
    for (const id of new Set([c.active_plan_id, ...(c.plan_ids ?? [])].filter(Boolean).map(String))) {
      const plan = await getPlan(id);
      if (plan && isOpenPlan(plan.status) && (await canAccessPlan(ctx as any, userId, plan))) bound.push({ kind: "plan", short_id: plan.short_id, title: plan.title, ...reach(plan.project_id) });
    }
    if (!bound.length) continue;
    const owner = await reads.get(c.user_id);
    sessionFacts.push({ short_id: c.short_id ?? String(c._id).slice(0, 7), title: String(c.title ?? "").slice(0, 100), owner: owner?.name ?? undefined, started_at: c.started_at ?? c._creationTime, updated_at: c.updated_at ?? c._creationTime, bound });
  }

  return computeUnplaced({ now, plans: planFacts, projects: projectFacts, loose_tasks: looseTasks, sessions: sessionFacts, truncated: truncated || reads.truncated || scan.truncated });
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
