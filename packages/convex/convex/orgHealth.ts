import { action, query } from "./functions";
import { api } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { scopedFetch } from "./data";
import { collectOrgSessions, computeScopeFeed, requireWorkspaceCaller, resolveScope, sessionsInScope, waitingSinceOf, type OrgScan, type ResolvedScope } from "./org";
import { planProjectsOf } from "./orgRoles";
import { capsFor, countersFor, utcDay } from "./orgEvents";
import { isWholeWorkspace, scopeIds } from "./lib/orgScope";
import { projectsWithoutAnOwnerAmongWatchers } from "@codecast/shared/contracts/orgLead";
import { capacity, capacityFlags, type HealthFlag, isOverloaded, overloadRatio, type RoleLedger, type RoleLoad } from "@codecast/shared/contracts/orgCapacity";
import { extractRepoFromRemoteUrl } from "@codecast/shared/contracts";
import { computeStale, type ActivityCommit, type ActivitySession } from "./lib/orgActivity";
import { isActiveTask } from "@codecast/shared/tasks";

// org.health (docs/architecture/org-staffing.md S3): the flow signals the
// capacity model needs, per role, per person and for the company, with the
// flags the shared model raises against them. Computed on read from the same
// scan org.tree uses plus bounded, indexed reads of the wake log, the
// decision ladder, the tasks in scope, the send ledger between standing
// sessions, chat mentions and the role history. Nothing here is stored.
//
// The thresholds live in @codecast/shared/contracts/orgCapacity; this file
// only measures. `roleActivity` is the one reading of a role's wakes and idle
// time, shared with the analyzer inputs (orgInit.computeAnalysisInputs).

type Ctx = { db: any };
const D = 86_400_000;
export const HEALTH_WINDOW_7D_MS = 7 * D;
export const HEALTH_WINDOW_30D_MS = 30 * D;
export const HEALTH_CAPS = {
  projects: 200,
  plans: 500,
  /** Open rows per status (readWorkTasks), and the rows updated this week. */
  tasks: 2000,
  recent_tasks: 1500,
  decisions: 1000,
  sends_per_session: 300,
  channels: 50,
  messages_per_channel: 300,
  inbox_per_person: 200,
  history_per_role: 1,
} as const;

export type RoleActivity = {
  last_scope_event_at: number | null;
  idle_days: number | null;
  /** Days since the seat was created: a new seat with no event is not idle yet. */
  age_days: number;
  idle: boolean;
  // total and by_day count DELIVERED wakes only, the count the flush gate
  // spends against the cap; a dropped frame bumps nothing and a held one
  // marks its day as a cap hit.
  wakes_7d: { total: number; delivered: number; dropped: number; held: number; days_at_cap: number; cap_hit_days: number; by_day: Record<string, number> };
};

/** The newest event in a workspace: the idle clock of a whole workspace role,
 *  whose scope resolves to no rows of its own. */
export function latestEventAnywhere(tasks: any[], plans: any[], scan: OrgScan): number | null {
  let latest: number | null = null;
  const see = (t: number | undefined) => { if (t && (latest === null || t > latest)) latest = t; };
  for (const t of tasks) see(t.updated_at);
  for (const p of plans) see(p.updated_at);
  for (const { session } of scan.sessions.values()) see(session.updated_at);
  return latest;
}

/** A role's last scope event and its wake log over the week. One reading for
 *  org.health and the analyzer inputs: the idle rule is the model's
 *  `idle_days` over the seat's age when it never had an event, and
 *  `wholeWorkspaceLatest` (latestEventAnywhere) is required so no caller can
 *  read a whole workspace role as idle by mistake. */
export async function roleActivity(ctx: Ctx, userId: Id<"users">, role: any, now: number, opts: { wholeWorkspaceLatest: number | null; resolved?: ResolvedScope | null; lastScopeEventAt?: number | null }): Promise<RoleActivity> {
  let lastScopeEventAt: number | null = null;
  if (isWholeWorkspace(scopeIds(role.scope ?? { project_ids: [], plan_ids: [] }))) {
    lastScopeEventAt = opts.wholeWorkspaceLatest;
  } else if (opts.lastScopeEventAt !== undefined) {
    // The caller already holds the scope's rows (org.health): no second read.
    lastScopeEventAt = opts.lastScopeEventAt;
  } else {
    const resolved = opts.resolved !== undefined ? opts.resolved : await resolveScope(ctx, userId, { role_id: String(role._id) });
    if (resolved) {
      const feed = await computeScopeFeed(ctx, resolved, { limit: 1, now });
      lastScopeEventAt = feed.rows[0]?.updated_at ?? null;
    }
  }
  const wakes: any[] = await ctx.db.query("role_wakes").withIndex("by_role_created", (q: any) => q.eq("role_id", role._id).gte("created_at", now - HEALTH_WINDOW_7D_MS)).collect();
  const byDay = new Map<string, number>();
  const heldDays = new Set<string>();
  let held = 0, dropped = 0, delivered = 0;
  for (const w of wakes) {
    if (w.status === "held") { held++; heldDays.add(utcDay(w.created_at)); continue; }
    if (w.status === "dropped") { dropped++; continue; }
    delivered++;
    const day = utcDay(w.created_at);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const caps = capsFor(role);
  const daysAtCap = Array.from(byDay.values()).filter((n) => n >= caps.wakes_per_day).length;
  const capHitDays = new Set([...heldDays, ...Array.from(byDay.entries()).filter(([, n]) => n >= caps.wakes_per_day).map(([d]) => d)]).size;
  // A row stamped a moment after `now` (a write racing the read) is today, not a negative day.
  const idle_days = lastScopeEventAt ? Math.max(0, Math.floor((now - lastScopeEventAt) / D)) : null;
  const age_days = Math.floor((now - (role.created_at ?? now)) / D);
  return {
    last_scope_event_at: lastScopeEventAt,
    idle_days,
    age_days,
    idle: (idle_days ?? age_days) >= capacity("idle_days"),
    wakes_7d: { total: delivered, delivered, dropped, held, days_at_cap: daysAtCap, cap_hit_days: capHitDays, by_day: Object.fromEntries(byDay) },
  };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const isOpen = (t: any) => t.status !== "done" && t.status !== "dropped";
/** A plan no longer carrying work: done, dropped or abandoned. */
const PLAN_CLOSED = new Set(["done", "dropped", "abandoned"]);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export const ACTIVITY_COMMITS_PER_REPO = 500;

/** The distinct work items that reached a role's frames inside the window:
 *  its wake outbox rows (one per (table, id) per coalesce window), flushed in
 *  the window or still waiting. This is what the load model means by an item
 *  reaching a seat; the scope's churn (tasks changed) is a different number. */
export const OUTBOX_LOAD_CAP = 1500;
export async function readReachedItems(ctx: Ctx, roleId: Id<"org_roles">, since: number): Promise<{ items: number; truncated: boolean }> {
  const flushed: any[] = await ctx.db.query("role_wake_outbox").withIndex("by_role_flushed", (q: any) => q.eq("role_id", roleId).gte("flushed_at", since)).take(OUTBOX_LOAD_CAP);
  const waiting: any[] = await ctx.db.query("role_wake_outbox").withIndex("by_role_flushed", (q: any) => q.eq("role_id", roleId).eq("flushed_at", undefined)).take(OUTBOX_LOAD_CAP);
  const refs = new Set<string>();
  for (const row of [...flushed, ...waiting]) {
    if ((row.created_at ?? 0) < since && !(row.flushed_at >= since)) continue;
    if (row.ref) refs.add(`${row.ref.table}:${row.ref.id}`);
  }
  return { items: refs.size, truncated: flushed.length >= OUTBOX_LOAD_CAP || waiting.length >= OUTBOX_LOAD_CAP };
}

/** The statuses a task is still open under (shared/tasks TASK_STATUS_CATEGORIES minus done and dropped). */
export const WORK_STATUSES = ["backlog", "open", "in_progress", "in_review"] as const;

export type WorkTasks = {
  /** Every open row of the workspace that is real work (isActiveTask), plus
   *  every row that changed inside the recent window (the closes of the week
   *  ride on the updated index). */
  tasks: any[];
  /** Per status, whether the read hit its cap (a floor, not a count). */
  truncated: Partial<Record<string, boolean>>;
  /** True when any slice was a floor. */
  any_truncated: boolean;
};

/** The tasks the org layer reads: the OPEN rows of the workspace, complete,
 *  one status index read each, plus the rows updated inside the window (for
 *  what was done and what changed this week). A workspace-wide "newest N"
 *  read is the wrong shape for this: on a large workspace the newest rows are
 *  mined suggestions and closes, and the older open rows, the ones a stale
 *  detector exists for, fall out of the cap. Mined suggestions and dismissed
 *  rows are left out (shared/tasks isActiveTask): they are not claims anyone
 *  filed, so they are neither ledger, nor load, nor a record to bring in line.
 *  Shared by org.health and the analyzer inputs so both count the same rows. */
export async function readWorkTasks(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, opts: { perStatus: number; updatedSince: number; recentCap: number }): Promise<WorkTasks> {
  const fetchOpts = teamId ? { userId, workspace: "team" as const, teamId } : { userId, workspace: "personal" as const };
  const byId = new Map<string, any>();
  const truncated: Partial<Record<string, boolean>> = {};
  for (const status of WORK_STATUSES) {
    const { records } = await scopedFetch(ctx, "tasks", { ...fetchOpts, status, limit: opts.perStatus });
    truncated[status] = records.length >= opts.perStatus;
    for (const t of records) if (isActiveTask(t)) byId.set(String(t._id), t);
  }
  const { records: recent } = await scopedFetch(ctx, "tasks", { ...fetchOpts, updatedSince: opts.updatedSince, limit: opts.recentCap });
  truncated.recent = recent.length >= opts.recentCap;
  for (const t of recent) if (isActiveTask(t) && !byId.has(String(t._id))) byId.set(String(t._id), t);
  return { tasks: Array.from(byId.values()), truncated, any_truncated: Object.values(truncated).some(Boolean) };
}

/** The repos the scanned sessions touch (org-staffing.md S9): where to read
 *  the commit history from. */
export function reposFromScan(scan: OrgScan): string[] {
  const s = new Set<string>();
  for (const { raw } of scan.sessions.values()) { const r = extractRepoFromRemoteUrl(raw.git_remote_url); if (r) s.add(r); }
  return Array.from(s);
}

/** The scan's sessions as the activity computation reads them. */
export function activitySessionsFromScan(scan: OrgScan): ActivitySession[] {
  const out: ActivitySession[] = [];
  for (const { session, raw } of scan.sessions.values()) {
    out.push({
      _id: String(session._id),
      state: session.state,
      updated_at: session.updated_at ?? null,
      owner_user_id: session.owner_user_id ? String(session.owner_user_id) : raw.user_id ? String(raw.user_id) : null,
      project_path: session.project_path ?? null,
      repo: extractRepoFromRemoteUrl(raw.git_remote_url) ?? null,
      git_root: raw.git_root ?? null,
      active_plan_id: raw.active_plan_id ? String(raw.active_plan_id) : null,
      active_task_id: raw.active_task_id ? String(raw.active_task_id) : null,
    });
  }
  return out;
}

/** The landed commits for a set of repos over a window, capped per repo. */
export async function readActivityCommits(ctx: Ctx, repos: string[], since: number, perRepoCap = ACTIVITY_COMMITS_PER_REPO): Promise<ActivityCommit[]> {
  const out: ActivityCommit[] = [];
  for (const repo of repos) {
    const rows: any[] = await ctx.db.query("commits").withIndex("by_repository_timestamp", (q: any) => q.eq("repository", repo).gte("timestamp", since)).order("desc").take(perRepoCap);
    for (const c of rows) out.push({ repository: c.repository, timestamp: c.timestamp, author_name: c.author_name, author_email: c.author_email, files: c.files ?? null, task_ids: (c.task_ids ?? []).map((id: any) => String(id)) });
  }
  return out;
}

/** A program role's end condition, met or not (org-staffing.md S10): its plan
 *  or project done, or its date past. Pure over rows already fetched. */
export function programEndedOf(role: any, now: number, planById: Map<string, any>, projectById: Map<string, any>): { ended: string; then: "retire" | "review" } | null {
  const t = role.tenure;
  if (!t || t.kind !== "program") return null;
  const then = t.then === "review" ? "review" : "retire";
  const e = t.ends ?? {};
  if (e.plan !== undefined) { const pl = planById.get(String(e.plan)); return pl && pl.status === "done" ? { ended: `its plan ${pl.short_id ?? String(e.plan)} is done`, then } : null; }
  if (e.project !== undefined) { const pr = projectById.get(String(e.project)); return pr && pr.status === "done" ? { ended: `its project "${pr.title}" is done`, then } : null; }
  if (e.date !== undefined) return now >= e.date ? { ended: `its end date ${new Date(e.date).toISOString().slice(0, 10)} is past`, then } : null;
  return null;
}

// ── Decisions, split out so they get their own execution budget ─────────────
// The decision ladder (per member, two statuses) and the per-person inbox are
// the heaviest reads in health, and they need neither the session scan nor the
// work rows. Split into their own query (org-staffing.md S3, the analysisInputs
// fan-out pattern) so a large workspace answers inside the 1s cap: the core
// query does the scan and the work, this does the decisions, an action merges.
export type HealthDecisions = {
  decisionsOf: Record<string, number>;
  latency: Record<string, number[]>;
  escalations: Record<string, number>;
  decisionsTruncated: boolean;
  peopleWaiting: Record<string, { n: number; oldest_min: number | null }>;
};

/** The members and non-retired roles of a workspace, by the same rule the scan
 *  uses, but without the session scan: cheap indexed reads for the decisions
 *  part, which needs only the member ids and the role ids. */
export async function healthMembersAndRoles(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined): Promise<{ memberIds: Id<"users">[]; roleIds: string[] }> {
  const memberIds: Id<"users">[] = teamId
    ? (await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect()).map((m: any) => m.user_id)
    : [userId];
  const roles: any[] = teamId
    ? await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).collect()
    : await ctx.db.query("org_roles").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId)).collect();
  return { memberIds, roleIds: roles.filter((r) => r.status !== "retired").map((r) => String(r._id)) };
}

export async function readHealthDecisions(ctx: Ctx, teamId: Id<"teams"> | undefined, memberIds: Id<"users">[], roleIds: string[], now: number): Promise<HealthDecisions> {
  const cut7 = now - HEALTH_WINDOW_7D_MS;
  const deadlineMin = capacity("decision_latency_min");
  const roleSet = new Set(roleIds.map(String));
  const decisionsOf: Record<string, number> = {};
  const latency: Record<string, number[]> = {};
  const escalations: Record<string, number> = {};
  let decisionsTruncated = false;
  const inc = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  // Member by member (the asker's account), never the deployment's newest
  // rows. A hop's latency is ask to recommendation; a hop that never
  // recommended counts the whole wait once it is past the hop deadline.
  for (const status of ["pending", "answered"]) {
    for (const memberId of memberIds) {
      const rows: any[] = await ctx.db.query("session_decisions").withIndex("by_user_status_created", (q: any) => q.eq("user_id", memberId).eq("status", status).gte("created_at", cut7)).order("desc").take(HEALTH_CAPS.decisions);
      if (rows.length >= HEALTH_CAPS.decisions) decisionsTruncated = true;
      for (const d of rows) {
        for (const hop of d.hops ?? []) {
          const rid = String(hop.role_id);
          if (!roleSet.has(rid)) continue;
          const note = typeof hop.note === "string" ? hop.note : "";
          if (note.startsWith("skipped")) continue; // a paused or retired seat: never woken
          inc(decisionsOf, rid);
          if (note.startsWith("escalated")) { inc(escalations, rid); continue; }
          let sampleMin: number | null = null;
          if (hop.recommendation !== undefined) sampleMin = (hop.at - d.created_at) / 60_000;
          else if (d.status === "answered") sampleMin = ((d.resolved_at ?? now) - d.created_at) / 60_000;
          else { const waited = (now - d.created_at) / 60_000; if (waited > deadlineMin) sampleMin = waited; }
          if (sampleMin !== null) (latency[rid] ??= []).push(sampleMin);
        }
      }
    }
  }
  const peopleWaiting: Record<string, { n: number; oldest_min: number | null }> = {};
  for (const uid of memberIds) {
    const inbox: any[] = await ctx.db.query("decision_inbox").withIndex("by_user_status", (q: any) => q.eq("user_id", uid).eq("status", "pending")).take(HEALTH_CAPS.inbox_per_person);
    let oldest: number | null = null;
    for (const row of inbox) {
      const d = await ctx.db.get(row.decision_id);
      if (d?.status === "pending") oldest = oldest === null ? d.created_at : Math.min(oldest, d.created_at);
    }
    peopleWaiting[String(uid)] = { n: inbox.length, oldest_min: oldest === null ? null : Math.floor((now - oldest) / 60_000) };
  }
  return { decisionsOf, latency, escalations, decisionsTruncated, peopleWaiting };
}

export type OrgHealth = Awaited<ReturnType<typeof computeOrgHealth>>;

export async function computeOrgHealth(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number, opts?: { decisions?: HealthDecisions; work?: WorkTasks }) {
  const cut7 = now - HEALTH_WINDOW_7D_MS;
  const scan: OrgScan = await collectOrgSessions(ctx, userId, teamId, now);
  const roles: any[] = scan.roles;
  const roleById = new Map<string, any>(roles.map((r) => [String(r._id), r]));
  // The decision ladder and inbox, in their own budget when the fanned action
  // supplies them; computed in-process otherwise (the web query, tests).
  const dec = opts?.decisions ?? await readHealthDecisions(ctx, teamId, scan.memberIds, roles.map((r) => String(r._id)), now);

  // ── Work items, one read each through the workspace chokepoint ──────────
  const fetchOpts = teamId ? { userId, workspace: "team" as const, teamId } : { userId, workspace: "personal" as const };
  // The open rows of the workspace, complete, plus this week's changes
  // (readWorkTasks): real work only, never the newest N of the table.
  const [projects, plans, work] = await Promise.all([
    scopedFetch(ctx, "projects", { ...fetchOpts, limit: HEALTH_CAPS.projects }).then((r) => r.records),
    scopedFetch(ctx, "plans", { ...fetchOpts, limit: HEALTH_CAPS.plans }).then((r) => r.records),
    opts?.work ?? readWorkTasks(ctx, userId, teamId, { perStatus: HEALTH_CAPS.tasks, updatedSince: cut7, recentCap: HEALTH_CAPS.recent_tasks }),
  ]);
  const tasks = work.tasks;
  const plansByProject = new Map<string, any[]>();
  for (const p of plans) if (p.project_id) plansByProject.set(String(p.project_id), [...(plansByProject.get(String(p.project_id)) ?? []), p]);
  const planProjectOf = await planProjectsOf(ctx, roles.map((r) => r.scope));
  const planById = new Map<string, any>(plans.map((p) => [String(p._id), p]));
  const projectById = new Map<string, any>(projects.map((p) => [String(p._id), p]));

  // Stale records (org-staffing.md S9): the one reading of "the evidence says
  // this is finished", over the rows and the scan already in hand. Health
  // reads NO commit history for this: the commit-derived reason ("commits
  // landed, still open") and commit-based project touches would add a repos ×
  // 500 read to the core query, which already sits at the 1s cap on a large
  // workspace. The full-fidelity version, with commits, is on
  // org.inputs.activity (its own fanned budget); health's flags are the
  // task/plan/session-based subset, which is enough for an info flag.
  const stale = computeStale({
    now,
    commits: [],
    sessions: activitySessionsFromScan(scan),
    projects: projects.map((p) => ({ id: String(p._id), title: p.title, status: p.status, project_path: p.project_path ?? null, updated_at: p.updated_at ?? p._creationTime })),
    plans: plans.map((p) => ({ id: String(p._id), short_id: p.short_id, title: p.title, status: p.status, project_id: p.project_id ? String(p.project_id) : null, updated_at: p.updated_at ?? p._creationTime })),
    tasks: tasks.map((t) => ({ id: String(t._id), short_id: t.short_id, title: t.title, status: t.status, plan_id: t.plan_id ? String(t.plan_id) : null, project_id: t.project_id ? String(t.project_id) : null, updated_at: t.updated_at ?? t._creationTime, conversation_ids: (t.conversation_ids ?? []).map((id: any) => String(id)) })),
    members: [],
  });

  // What the narrower roles cover, once: a scope's projects (a named plan
  // covers its project too) and its plans (a covered project's plans too).
  // Ownership of a project is a role naming it, never a whole workspace
  // scope: that is the root's view (the chief of staff, a role created with
  // no scope), so it leaves the unowned signal alone.
  const coveredProjects = new Set<string>();
  const coveredPlans = new Set<string>();
  for (const r of roles) {
    const ids = scopeIds(r.scope ?? { project_ids: [], plan_ids: [] });
    for (const id of ids.project_ids) coveredProjects.add(id);
    for (const id of ids.plan_ids) { coveredPlans.add(id); const pr = planProjectOf.get(id); if (pr) coveredProjects.add(pr); }
  }
  for (const pid of coveredProjects) for (const p of plansByProject.get(pid) ?? []) coveredPlans.add(String(p._id));
  const inScope = (projectIds: Set<string>, planIds: Set<string>) => ({
    tasks: tasks.filter((t) => (t.project_id && projectIds.has(String(t.project_id))) || (t.plan_id && planIds.has(String(t.plan_id)))),
    plans: plans.filter((p) => planIds.has(String(p._id))),
    projectIds,
  });

  // A role's tasks and plans, by the ONE scope rule the scope feed, the scope
  // page and `cast task ls` read (org.resolveScope): the scope's projects, the
  // scope's plans plus every plan of a scope project, and the tasks filed
  // under either. Evaluated here over the workspace's complete open set
  // (readWorkTasks) rather than by a second index read per role, which is
  // the same rows at a fraction of the read budget. A whole workspace role
  // holds the remainder: what no narrower role covers, which is the work it
  // exists to find an owner for. `counted` says which rule a row used.
  const tasksTruncated = work.any_truncated;
  const itemsOf = async (role: any) => {
    const ids = scopeIds(role.scope ?? { project_ids: [], plan_ids: [] });
    if (isWholeWorkspace(ids)) {
      const projectIds = new Set(projects.map((p) => String(p._id)).filter((id) => !coveredProjects.has(id)));
      const planIds = new Set(plans.map((p) => String(p._id)).filter((id) => !coveredPlans.has(id)));
      const rest = inScope(projectIds, planIds);
      const items = { ...rest, tasks: [...rest.tasks, ...tasks.filter((t) => !t.project_id && !t.plan_id)] };
      return {
        ...items,
        resolved: null as ResolvedScope | null,
        counted: {
          rule: "remainder" as const,
          projects: projectIds.size, plans: planIds.size, tasks: items.tasks.length,
          complete: !tasksTruncated,
          note: `the remainder no narrower role covers: ${projectIds.size} projects, ${planIds.size} plans and ${items.tasks.length} tasks (${tasks.filter((t) => !t.project_id && !t.plan_id).length} filed under no project or plan), over every open task of the workspace read by status${tasksTruncated ? ` (a floor: a status slice hit its cap of ${HEALTH_CAPS.tasks})` : ""}`,
        },
      };
    }
    const projectIds = new Set(ids.project_ids.filter((id) => projectById.has(id)));
    const planIds = new Set(ids.plan_ids.filter((id) => planById.has(id)));
    for (const pid of projectIds) for (const p of plansByProject.get(pid) ?? []) planIds.add(String(p._id));
    const items = inScope(projectIds, planIds);
    return {
      ...items,
      resolved: null as ResolvedScope | null,
      counted: {
        rule: "scope" as const,
        projects: projectIds.size, plans: planIds.size, tasks: items.tasks.length,
        complete: !tasksTruncated,
        note: `${projectIds.size} projects and ${planIds.size} plans in scope (${ids.plan_ids.length} named, the rest under the projects) and every open task filed under either plus this week's closes: ${items.tasks.length} tasks by the scope rule, the same rows the scope feed and the task list show${tasksTruncated ? ` (a floor: a status slice hit its cap of ${HEALTH_CAPS.tasks})` : ""}`,
      },
    };
  };

  // ── Standing sessions and the send ledger between them ──────────────────
  const standingConvOfRole = new Map<string, string>();
  for (const a of scan.anchors) if (a.org_role_id && a.conversation_id) standingConvOfRole.set(String(a.org_role_id), String(a.conversation_id));
  for (const r of roles) {
    if (standingConvOfRole.has(String(r._id)) || !r.anchor_id) continue;
    const a = scan.anchors.find((x: any) => String(x._id) === String(r.anchor_id));
    if (a?.conversation_id) standingConvOfRole.set(String(r._id), String(a.conversation_id));
  }
  const roleOfConv = async (convId: string): Promise<string | null> => {
    const c = scan.sessions.get(convId)?.raw ?? (await ctx.db.get(convId));
    const rid = c?.standing_role_id ?? c?.org_role_id;
    return rid && roleById.has(String(rid)) ? String(rid) : null;
  };
  // sends[from][to] over the week, read once from each standing session's
  // inbound rows (the ledger keeps delivered rows; sessionThreads reads it
  // the same way).
  const sends = new Map<string, Map<string, number>>();
  for (const [roleId, convId] of standingConvOfRole) {
    const rows: any[] = await ctx.db.query("pending_messages").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", convId)).order("desc").take(HEALTH_CAPS.sends_per_session);
    for (const row of rows) {
      if (row.created_at < cut7 || !row.from_conversation_id) continue;
      const from = await roleOfConv(String(row.from_conversation_id));
      if (!from || from === roleId) continue;
      const m = sends.get(from) ?? new Map();
      bump(m, roleId);
      sends.set(from, m);
    }
  }

  // ── Chat mentions of roles (team only) ──────────────────────────────────
  const mentions = new Map<string, number>();
  if (teamId) {
    const channels: any[] = await ctx.db.query("chat_channels").withIndex("by_team_name", (q: any) => q.eq("team_id", teamId)).take(HEALTH_CAPS.channels);
    for (const ch of channels) {
      if (ch.archived_at) continue;
      const msgs: any[] = await ctx.db.query("chat_messages").withIndex("by_channel_created", (q: any) => q.eq("channel_id", ch._id).gte("created_at", cut7)).order("desc").take(HEALTH_CAPS.messages_per_channel);
      for (const m of msgs) for (const ref of m.mentions ?? []) if (ref && typeof ref === "object" && ref.kind === "role") bump(mentions, String(ref.role_id));
    }
  }

  const decisionsTruncated = dec.decisionsTruncated;

  // ── Per role ────────────────────────────────────────────────────────────
  const reportsOf = new Map<string, number>();
  const directRolesOf = new Map<string, number>();
  for (const r of roles) {
    if (r.reports_to?.kind === "role") bump(reportsOf, String(r.reports_to.role_id));
    else if (r.reports_to?.kind === "user") bump(directRolesOf, String(r.reports_to.user_id));
  }
  const latestAnywhere = latestEventAnywhere(tasks, plans, scan);

  const roleRows = [];
  for (const role of roles) {
    const rid = String(role._id);
    const items = await itemsOf(role);
    const stallMs = capacity("review_stall_hours") * 3_600_000;
    // The ledger: what the scope holds today. Context, never load.
    const ledger: RoleLedger = {
      open_tasks: items.tasks.filter(isOpen).length,
      in_flight: items.tasks.filter((t) => t.status === "in_progress" || t.status === "in_review").length,
      active_plans: items.plans.filter((p) => p.status === "active").length,
    };
    const handoffs = { done: 0, blocked: 0, needs_context: 0 };
    let done7 = 0, stalls = 0, changed7 = 0, stuckHands = 0;
    for (const t of items.tasks) {
      if (t.status === "in_review" && now - (t.updated_at ?? 0) > stallMs) stalls++;
      // A hand that reported blocked or needs context on a task still open is
      // a stall until the task moves, however long ago it reported: the old
      // ones are the ones the role most needs to unstick. A closed task's
      // leftover execution_status is history, not a stall.
      if (isOpen(t) && (t.execution_status === "blocked" || t.execution_status === "needs_context")) stuckHands++;
      if ((t.updated_at ?? 0) < cut7) continue;
      changed7++;
      if (t.status === "done") done7++;
      if (t.execution_status === "done" || t.execution_status === "done_with_concerns") handoffs.done++;
      else if (t.execution_status === "blocked") handoffs.blocked++;
      else if (t.execution_status === "needs_context") handoffs.needs_context++;
    }
    for (const p of items.plans) if ((p.updated_at ?? p._creationTime ?? 0) >= cut7) changed7++;
    // The scope's last event, from rows already in hand: its tasks and plans,
    // and the sessions in scope by the feed's session rule (org.sessionsInScope
    // over the scan), so no role costs a second read of its scope.
    let lastScopeEventAt: number | null | undefined = undefined;
    if (!isWholeWorkspace(scopeIds(role.scope ?? { project_ids: [], plan_ids: [] }))) {
      let latest: number | null = null;
      const see = (t: number | undefined | null) => { if (t && (latest === null || t > latest)) latest = t; };
      for (const t of items.tasks) see(t.updated_at);
      for (const p of items.plans) see(p.updated_at ?? p._creationTime);
      const pseudo: ResolvedScope = { userId, role, teamId, scope: role.scope ?? { project_ids: [], plan_ids: [] }, projects: Array.from(items.projectIds).map((id) => projectById.get(id)).filter(Boolean), plans: items.plans, tasks: items.tasks };
      for (const { session } of await sessionsInScope(ctx, pseudo, now, scan)) see(session.updated_at);
      // The rows in hand are the open ones and this week's changes. A scope
      // whose last task closed nine days ago has neither, and would read as
      // "never had an event": ask each scope project and plan for its newest
      // task (one row each) before falling back to the seat's age.
      if (latest === null) {
        for (const pid of items.projectIds) { const row = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", pid)).order("desc").first(); see(row?.updated_at); }
        for (const p of items.plans) { const row = await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", p._id)).order("desc").first(); see(row?.updated_at); }
      }
      lastScopeEventAt = latest;
    }
    const activity = await roleActivity(ctx, userId, role, now, { wholeWorkspaceLatest: latestAnywhere, resolved: items.resolved, lastScopeEventAt });
    const decisions7 = dec.decisionsOf[rid] ?? 0;
    // The load: what reached the seat this week and asked for its attention.
    const caps = capsFor(role);
    const reached = await readReachedItems(ctx, role._id, cut7);
    const hands = scan.byParent.get(`role:${rid}`) ?? [];
    // A session of the role that has waited on a person past the window with
    // no escalation (org-roles-run-work.md R1): it is out of the person's
    // inbox, so nobody sees the wait but the role.
    const waitMs = capacity("session_wait_hours") * 3_600_000;
    const unseenWaits = hands.filter((h) => {
      const raw = scan.sessions.get(String(h._id))?.raw;
      const since = raw && !raw.escalated_by_role ? waitingSinceOf(h.state, raw) : null;
      return since !== null && now - since > waitMs;
    }).length;
    const load: RoleLoad = {
      items_per_day: reached.items / 7,
      decisions_per_day: decisions7 / 7,
      live_hands: hands.filter((s) => s.state === "working" || s.state === "needs_input" || s.state === "dormant").length,
      hands_cap: caps.hands_per_day,
      direct_reports: reportsOf.get(rid) ?? 0,
      open_stalls: stalls + stuckHands + unseenWaits,
      cap_hit_days: activity.wakes_7d.cap_hit_days,
    };
    const counters = countersFor(role, now);
    const spend = {
      wakes_today: counters.wakes,
      wakes_7d_avg: activity.wakes_7d.total / 7,
      wakes_cap: caps.wakes_per_day,
      tokens_today: counters.tokens,
      // Tokens are counted per day on the role's counters only; the ledger
      // keeps no daily history, so the week's average is not known.
      tokens_7d_avg: null as number | null,
      tokens_cap: caps.tokens_per_day,
      cap_hits_7d: activity.wakes_7d.cap_hit_days,
      // A 7 day average of one burst reads as a daily rate; the days say which.
      wakes_by_day: activity.wakes_7d.by_day,
      last_wake_at: role.last_wake_at ?? null,
    };
    const toRows = Array.from(sends.get(rid)?.entries() ?? []).map(([to, n]) => ({ role_id: to, handle: roleById.get(to)?.handle ?? "?", n }));
    const fromRows = Array.from(sends.entries()).filter(([, m]) => m.has(rid)).map(([from, m]) => ({ role_id: from, handle: roleById.get(from)?.handle ?? "?", n: m.get(rid)! }));
    const flow = {
      decisions_7d: decisions7,
      /** Distinct work items that reached the seat's frames this week (load.items_per_day × 7). */
      items_reached_7d: reached.items,
      /** Tasks and plans in scope that changed this week: the scope's churn, which is not load. */
      items_changed_7d: changed7,
      /** Sessions filed under the seat inside the scan window, in any state. */
      hands_window: hands.length,
      median_recommend_min: median(dec.latency[rid] ?? []),
      escalations_7d: dec.escalations[rid] ?? 0,
      frames_dropped_7d: activity.wakes_7d.dropped,
      done_7d: done7,
      handoffs_7d: handoffs,
      review_stalls: stalls,
      sends_7d: { to: toRows, from: fromRows },
      mentions_7d: mentions.get(rid) ?? 0,
    };
    const history: any[] = await ctx.db.query("org_role_history").withIndex("by_role", (q: any) => q.eq("role_id", role._id)).order("desc").take(HEALTH_CAPS.history_per_role);
    const lastMoveAt: number | null = history[0]?.created_at ?? null;
    const flags: HealthFlag[] = capacityFlags({
      kind: "role",
      handle: role.handle,
      load,
      ledger,
      spend,
      reviews_only: isWholeWorkspace(scopeIds(role.scope ?? { project_ids: [], plan_ids: [] })),
      scope_empty: items.counted.rule === "scope" && items.counted.projects === 0 && items.counted.plans === 0,
      flow: { decisions_7d: flow.decisions_7d, median_recommend_min: flow.median_recommend_min, review_stalls: stalls, done_7d: done7, hands_window: hands.length, sends_7d: { to: toRows.map((r) => ({ handle: r.handle, n: r.n })), from: fromRows.map((r) => ({ handle: r.handle, n: r.n })) } },
      idle_days: activity.idle_days,
      age_days: activity.age_days,
      has_charter: !!(role.charter_doc_id || (role.charter ?? "").trim()),
      breaches: role.overload_streak ?? 0,
      program_ended: programEndedOf(role, now, planById, projectById),
    });
    roleRows.push({
      role_id: role._id,
      // The busiest volume axis over its line (orgCapacity.overloadRatio);
      // at STABILITY.split_on_first_breach_ratio the split waits for no second review.
      overload_ratio: overloadRatio(load),
      short_id: role.short_id,
      handle: role.handle,
      name: role.name,
      status: role.status,
      reports_to: role.reports_to,
      /** What reached the seat this week (orgCapacity.RoleLoad). */
      load,
      /** What the scope holds today (orgCapacity.RoleLedger): context, never load. */
      ledger,
      /** Which rows the load and the ledger were counted from, and by what rule. */
      counted: items.counted,
      /** Earlier consecutive reviews that flagged the role; the next review
       *  reads it against STABILITY.split_after_breaches. */
      breaches: role.overload_streak ?? 0,
      overloaded_now: isOverloaded(load),
      spend,
      flow,
      last_move_at: lastMoveAt,
      idle_days: activity.idle_days,
      flags,
    });
  }

  // ── People ──────────────────────────────────────────────────────────────
  const people = [];
  for (const uid of scan.memberIds) {
    const user = await ctx.db.get(uid);
    const name = user?.name ?? user?.email ?? "";
    const direct_roles = directRolesOf.get(String(uid)) ?? 0;
    const waiting = dec.peopleWaiting[String(uid)] ?? { n: 0, oldest_min: null };
    people.push({
      user_id: uid,
      name,
      direct_roles,
      decisions_waiting: waiting,
      flags: capacityFlags({ kind: "person", name, direct_roles }),
    });
  }

  // ── Company ─────────────────────────────────────────────────────────────
  // A project is owned when a role names it as owner, or when a role's scope
  // names it directly or through one of its plans (coveredProjects above).
  // A live project is an active one: paused and planning lines are not seats
  // to fill or charters to write. A project needs an owner when it has work
  // (an open task, or a plan still open), which is the prompt's own rule; an
  // empty import, or a line nothing touches, reads as paused, not unowned.
  const liveProjects = projects.filter((p) => p.status === "active");
  const openByProject = new Map<string, number>();
  for (const t of tasks) if (isOpen(t) && t.project_id) bump(openByProject, String(t.project_id));
  const openPlansByProject = new Map<string, number>();
  for (const p of plans) if (p.project_id && !PLAN_CLOSED.has(p.status)) bump(openPlansByProject, String(p.project_id));
  const hasWork = (p: any) => (openByProject.get(String(p._id)) ?? 0) > 0 || (openPlansByProject.get(String(p._id)) ?? 0) > 0;
  const unowned_projects = liveProjects.filter((p) => hasWork(p) && !p.owner_role_id && !coveredProjects.has(String(p._id))).map((p) => ({ id: String(p._id), title: p.title }));
  // Two roles on separate lines list the project and it names neither as its
  // lead (org-roles-run-work.md R4): the one rule every surface reads, so the
  // analyzer proposes the owner for exactly the projects the web marks "two
  // roles watch this".
  const watched_without_lead = projectsWithoutAnOwnerAmongWatchers(liveProjects, roles).map(({ project, roles: watchers }) => ({ id: String(project._id), title: project.title as string, roles: watchers.map((r: any) => r.handle as string) }));
  const openByPlan = new Map<string, number>();
  for (const t of tasks) if (isOpen(t) && t.plan_id) bump(openByPlan, String(t.plan_id));
  // The company's budget as it stands: the caps of every active role summed,
  // so a proposal states the total it asks a person to allow, not a sum by hand.
  const caps_total = { hands_per_day: 0, wakes_per_day: 0, tokens_per_day: 0 };
  for (const r of roles) {
    if (r.status !== "active") continue;
    const c = capsFor(r);
    caps_total.hands_per_day += c.hands_per_day; caps_total.wakes_per_day += c.wakes_per_day; caps_total.tokens_per_day += c.tokens_per_day;
  }
  const company = {
    caps_total,
    unowned_projects,
    watched_without_lead,
    unfiled_tasks: tasks.filter((t) => isOpen(t) && !t.project_id && !t.plan_id).length,
    unfiled_plans: plans.filter((p) => !p.project_id && !PLAN_CLOSED.has(p.status) && (openByPlan.get(String(p._id)) ?? 0) > 0)
      .map((p) => ({ id: String(p._id), title: p.title, short_id: p.short_id ?? undefined, open_tasks: openByPlan.get(String(p._id))! })),
    plans_without_goal: plans.filter((p) => p.status === "active" && !(p.goal ?? "").trim()).map((p) => ({ id: String(p._id), title: p.title })),
    projects_without_charter: liveProjects.filter((p) => !(p.goal ?? "").trim()).map((p) => ({ id: String(p._id), title: p.title })),
    // The records the evidence says are finished (org-staffing.md S9): the
    // stale flags come off this, a sync change rather than a seat.
    stale,
  };

  return {
    workspace: teamId ? { kind: "team" as const, id: String(teamId) } : { kind: "user" as const, id: String(userId) },
    roles: roleRows,
    people,
    company: { ...company, flags: capacityFlags({ kind: "company", ...company }) },
    truncated: { sessions: scan.truncated, tasks: tasksTruncated, plans: plans.length >= HEALTH_CAPS.plans, projects: projects.length >= HEALTH_CAPS.projects, decisions: decisionsTruncated },
    generated_at: now,
  };
}

export const health = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    return computeOrgHealth(ctx, userId, args.team_id, Date.now());
  },
});

// ── Fanned read (org-staffing.md S3): the CLI/action path that answers on a
// large workspace by giving the decision ladder its own execution budget. The
// web query above stays one process and serves cached rows if it ever times
// out; the CLI reads the action so `cast org health` always returns.
export const healthDecisionsPart = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    const now = args.now ?? Date.now();
    const { memberIds, roleIds } = await healthMembersAndRoles(ctx, userId, args.team_id);
    return readHealthDecisions(ctx, args.team_id, memberIds, roleIds, now);
  },
});

/** The workspace's open tasks and this week's changes (readWorkTasks), in
 *  their own read budget: on a large workspace the complete open set alone
 *  is thousands of rows, past what one query may read next to the scan. */
export const healthWorkPart = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    const now = args.now ?? Date.now();
    return readWorkTasks(ctx, userId, args.team_id, { perStatus: HEALTH_CAPS.tasks, updatedSince: now - HEALTH_WINDOW_7D_MS, recentCap: HEALTH_CAPS.recent_tasks });
  },
});

export const healthCorePart = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), now: v.optional(v.number()), decisions: v.optional(v.any()), work: v.optional(v.any()) },
  handler: async (ctx, args): Promise<any> => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    return computeOrgHealth(ctx, userId, args.team_id, args.now ?? Date.now(), { decisions: args.decisions as HealthDecisions | undefined, work: args.work as WorkTasks | undefined });
  },
});

export const healthReport = action({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args): Promise<any> => {
    const now = Date.now();
    const [decisions, work] = await Promise.all([
      ctx.runQuery((api as any).orgHealth.healthDecisionsPart, { ...args, now }),
      ctx.runQuery((api as any).orgHealth.healthWorkPart, { ...args, now }),
    ]);
    if (decisions === null || work === null) return null;
    return ctx.runQuery((api as any).orgHealth.healthCorePart, { ...args, now, decisions, work });
  },
});
