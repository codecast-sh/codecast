import { action, mutation, query } from "./functions";
import { api } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { scopedFetch } from "./data";
import { workspaceForResource, workspaceKey } from "./lib/access";
import { userCanAdminRole } from "./lib/orgAccess";
import { isWholeWorkspace, scopeIds } from "./lib/orgScope";
import { collectOrgSessions, requireWorkspaceCaller, resolveScope, sessionsInScope } from "./org";
import { performRehomeSessions, type RehomeResult } from "./sessionOwnership";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { activitySessionsFromScan, latestEventAnywhere, readActivityCommits, readWorkTasks, reposFromScan, roleActivity } from "./orgHealth";
import { activityPlanOf, computeOrgActivity } from "./lib/orgActivity";
import { computeCoverage } from "./lib/orgCoverage";
import { isActiveTask } from "@codecast/shared/tasks";
import { capacity } from "@codecast/shared/contracts/orgCapacity";
import {
  overlapsAmong,
  performCreateRole,
  performProvisionRole,
  performReparentRole,
  performRetireRole,
  performSetCaps,
  performSetRoleScope,
  planProjectsOf,
  resolveScopeRef,
  rolesInBoundary,
} from "./orgRoles";
import { capsFor, countersFor, trustOf } from "./orgEvents";
import { findDecision } from "./sessionDecisions";
import { extractRepoFromRemoteUrl, threadStateHeadline } from "@codecast/shared/contracts";
import {
  applyProposalChanges,
  extractOrgProposal,
  orgEveryToMs,
  orgProposalVerdict,
  takeoverPhrase,
  type OrgAdoptChange,
  type OrgBudgetChange,
  type OrgChange,
  type OrgFileChange,
  type OrgPlanStatusChange,
  type OrgProjectChange,
  type OrgProjectMetaChange,
  type OrgProjectStatusChange,
  type OrgProposal,
  type OrgRoleProposal,
  type OrgRoutineChange,
  type OrgScopeChange,
  type OrgTaskStatusChange,
  type OrgTrustChange,
} from "@codecast/shared/contracts/orgProposal";
import { performSetTrust, standingConversationOf } from "./orgRoles";
import { insertTask } from "./agentTasks";
import { charterPatch } from "./lib/orgCharter";
import { enforceIndependentReview, recalcPlanProgress, resolveStatusWrite } from "./tasks";

// Org init and update (docs/architecture/org-init.md O1, O2): the evidence an
// analyzer reads before proposing a chart, and the apply path that turns an
// answered proposal into roles, scopes, charters and standing sessions.
//
// The analyzer never writes: it proposes as a decision stack, and nothing is
// created until a person answers. `applyDecision` is the one writer; it is
// idempotent per decision (applied_at); a handle already live is a refusal, never an adoption.

type Ctx = { db: any };

export const ANALYSIS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const IDLE_ROLE_DAYS = capacity("idle_days");
// The week org.health reads (orgHealth.HEALTH_WINDOW_7D_MS); a literal here
// because orgHealth loads through org.ts, which re-exports this module.
export const WAKE_HISTORY_DAYS = 7;
export const ANALYSIS_CAPS = {
  projects: 100,
  initiatives: 100,
  plans: 200,
  tasks: 2000,
  docs: 300,
  insights: 300,
  channels: 50,
  messages_per_channel: 50,
  decisions: 300,
  assignments: 2000,
  labels: 30,
  titles_per_path: 5,
  git_roots: 40,
  members: 50,
  long_running: 12,
  tasks_filed_per_session: 300,
  first_message_chars: 600,
} as const;
/** A session this old that still runs may be a role nobody has named (org-roles-run-work.md R2). */
export const LONG_RUNNING_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const topOf = (m: Map<string, number>, n: number) =>
  Array.from(m.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([name, count]) => ({ name, count }));
const objOf = (m: Map<string, number>): Record<string, number> => Object.fromEntries(m);

// The inputs are three bounded reads, each its own query so none crosses the
// execution limit on a large workspace, run from one action and merged once.
// computeAnalysisInputs runs the same three in process for tests and any
// server side caller; the shape is identical either way.

type AnalysisWork = ReturnType<typeof shapeWork>;
type AnalysisOrg = Awaited<ReturnType<typeof computeAnalysisOrg>>;
type AnalysisSignals = Awaited<ReturnType<typeof computeAnalysisSignals>>;
/** What the org slice needs from the work slice: small rows, never the tasks. */
export type AnalysisHandoff = {
  projects: Array<{ id: string; short_id?: string; title: string; open_tasks: number; project_path?: string }>;
  plans: Array<{ id: string; short_id: string }>;
  latest_event: number | null;
};

function statusCounts(rows: any[]): Record<string, number> {
  const m = new Map<string, number>();
  for (const t of rows) bump(m, t.status ?? "open");
  return objOf(m);
}

function shapeWork(projects: any[], plans: any[], tasks: any[], docs: any[], tasksTruncated = false) {
  const tasksByProject = new Map<string, any[]>();
  const tasksByPlan = new Map<string, any[]>();
  let unfiledOpen = 0;
  for (const t of tasks) {
    if (t.project_id) tasksByProject.set(String(t.project_id), [...(tasksByProject.get(String(t.project_id)) ?? []), t]);
    if (t.plan_id) tasksByPlan.set(String(t.plan_id), [...(tasksByPlan.get(String(t.plan_id)) ?? []), t]);
    if (!t.project_id && !t.plan_id && t.status !== "done" && t.status !== "dropped") unfiledOpen++;
  }
  const projectRows = projects.map((p) => {
    const mine = tasksByProject.get(String(p._id)) ?? [];
    return {
      id: String(p._id),
      short_id: p.short_id ?? undefined,
      title: p.title,
      description: (p.description ?? "").slice(0, 600) || undefined,
      status: p.status,
      project_path: p.project_path ?? undefined,
      tasks: { total: mine.length, open: mine.filter((t) => t.status !== "done" && t.status !== "dropped").length, by_status: statusCounts(mine) },
      plans: plans.filter((pl) => String(pl.project_id) === String(p._id)).length,
      updated_at: p.updated_at ?? p._creationTime,
    };
  });
  const planRows = plans.map((pl) => {
    const mine = (tasksByPlan.get(String(pl._id)) ?? []).filter((t) => !t.parent_id && t.status !== "dropped");
    const progress = { total: mine.length, done: 0, in_progress: 0, open: 0 };
    for (const t of mine) {
      if (t.status === "done") progress.done++;
      else if (t.status === "in_progress" || t.status === "in_review") progress.in_progress++;
      else progress.open++;
    }
    return {
      id: String(pl._id),
      short_id: pl.short_id,
      title: pl.title,
      status: pl.status,
      project_id: pl.project_id ? String(pl.project_id) : undefined,
      goal: (pl.goal ?? "").slice(0, 300) || undefined,
      progress,
      updated_at: pl.updated_at ?? pl._creationTime,
    };
  });
  const docsByType = new Map<string, number>();
  for (const d of docs) if (!d.archived_at) bump(docsByType, d.doc_type ?? "note");
  let latest: number | null = null;
  for (const r of [...tasks, ...plans]) if (r.updated_at && (latest === null || r.updated_at > latest)) latest = r.updated_at;
  const handoff: AnalysisHandoff = {
    projects: projectRows.map((p) => ({ id: p.id, short_id: p.short_id, title: p.title, open_tasks: p.tasks.open, project_path: p.project_path })),
    plans: planRows.map((p) => ({ id: p.id, short_id: p.short_id })),
    latest_event: latest,
  };
  return {
    projects: projectRows,
    plans: planRows,
    tasks: { total: tasks.length, by_status: statusCounts(tasks), unfiled_open: unfiledOpen, truncated: tasksTruncated, closed_counted: "inside the window only" },
    docs_by_type: objOf(docsByType),
    truncated: {
      projects: projects.length >= ANALYSIS_CAPS.projects,
      plans: plans.length >= ANALYSIS_CAPS.plans,
      tasks: tasksTruncated,
      docs: docs.length >= ANALYSIS_CAPS.docs,
    },
    handoff,
  };
}

// ── Work items, through the workspace chokepoint ──────────────────────────
export async function computeAnalysisWork(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined): Promise<AnalysisWork> {
  const fetchOpts = teamId ? { userId, workspace: "team" as const, teamId } : { userId, workspace: "personal" as const };
  // Every open row of the workspace plus the month's changes (orgHealth
  // readWorkTasks): real work only, complete for what is open, so the counts
  // and the stale reading are not the newest N of the table. Rows closed
  // before the window are not read; `tasks.by_status` counts done and
  // dropped inside the window and says so.
  const [projects, plans, work, docs] = await Promise.all([
    scopedFetch(ctx, "projects", { ...fetchOpts, limit: ANALYSIS_CAPS.projects }).then((r) => r.records),
    scopedFetch(ctx, "plans", { ...fetchOpts, limit: ANALYSIS_CAPS.plans }).then((r) => r.records),
    readWorkTasks(ctx, userId, teamId, { perStatus: ANALYSIS_CAPS.tasks, updatedSince: Date.now() - ANALYSIS_WINDOW_MS, recentCap: ANALYSIS_CAPS.tasks }),
    scopedFetch(ctx, "docs", { ...fetchOpts, limit: ANALYSIS_CAPS.docs, stripFields: ["content", "entries", "content_embedding"] }).then((r) => r.records),
  ]);
  return shapeWork(projects, plans, work.tasks, docs, work.any_truncated);
}

// ── Sessions (the org scan), members, labels, git roots, roles ────────────
export async function computeAnalysisOrg(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number, work: AnalysisHandoff) {
  const scan = await collectOrgSessions(ctx, userId, teamId, now);
  const perMember = new Map<string, { sessions: number; by_path: Map<string, number> }>();
  const gitRoots = new Map<string, { git_root: string; remote_url?: string; repo?: string; sessions: number }>();
  const titlesByPath = new Map<string, Array<{ short_id?: string; title: string; updated_at: number }>>();
  const byId = new Map<string, any>();
  for (const { session, raw } of scan.sessions.values()) {
    byId.set(String(session._id), raw);
    const owner = String(session.owner_user_id ?? raw.user_id);
    const m = perMember.get(owner) ?? { sessions: 0, by_path: new Map() };
    m.sessions++;
    const p = session.project_path ?? "(no path)";
    bump(m.by_path, p);
    perMember.set(owner, m);
    const rootKey = raw.git_root ?? raw.git_remote_url;
    if (rootKey) {
      const g = gitRoots.get(rootKey) ?? { git_root: raw.git_root ?? rootKey, remote_url: raw.git_remote_url ?? undefined, repo: extractRepoFromRemoteUrl(raw.git_remote_url) ?? undefined, sessions: 0 };
      g.sessions++;
      gitRoots.set(rootKey, g);
    }
    const list = titlesByPath.get(p) ?? [];
    if (session.title && list.length < ANALYSIS_CAPS.titles_per_path) list.push({ short_id: session.short_id ?? undefined, title: session.title, updated_at: session.updated_at });
    titlesByPath.set(p, list);
  }
  const members = [];
  for (const uid of scan.memberIds.slice(0, ANALYSIS_CAPS.members)) {
    const user = await ctx.db.get(uid);
    const m = perMember.get(String(uid));
    members.push({
      user_id: String(uid),
      name: user?.name ?? user?.email ?? "",
      is_me: String(uid) === String(userId),
      sessions_30d: m?.sessions ?? 0,
      by_project_path: m ? objOf(m.by_path) : {},
    });
  }

  // Labels are personal filing (inbox_buckets): the caller's buckets over the
  // scanned sessions. The assignment read is capped: labels are colour, not
  // evidence, and a caller with thousands of filed sessions must not sink the
  // whole read.
  const labels = new Map<string, number>();
  const buckets: any[] = await ctx.db.query("inbox_buckets").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  const bucketName = new Map(buckets.filter((b) => !b.archived_at).map((b) => [String(b._id), b.name]));
  const assignments: any[] = await ctx.db.query("bucket_assignments").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).take(ANALYSIS_CAPS.assignments);
  for (const a of assignments) {
    const name = a.bucket_id ? bucketName.get(String(a.bucket_id)) : undefined;
    if (name && byId.has(String(a.conversation_id))) bump(labels, name);
  }

  // ── Roles, anchors, and each role's health (update mode reads these) ────
  const roleRows = scan.roles;
  const planProjectOf = await planProjectsOf(ctx, roleRows.map((r: any) => r.scope));
  const projectTitle = new Map(work.projects.map((p) => [p.id, p.title]));
  const planShort = new Map(work.plans.map((p) => [p.id, p.short_id]));
  // The whole workspace idle clock: the newest task or plan (handed over from
  // the work slice) or the newest scanned session.
  const latestSession = latestEventAnywhere([], [], scan);
  const latestAnywhere = work.latest_event === null ? latestSession : latestSession === null ? work.latest_event : Math.max(work.latest_event, latestSession);
  const coveredProjects = new Set<string>();
  let wholeWorkspaceRoles = 0;
  const roles = [];
  for (const role of roleRows) {
    const ids = scopeIds(role.scope);
    if (isWholeWorkspace(ids)) wholeWorkspaceRoles++;
    for (const id of ids.project_ids) coveredProjects.add(id);
    for (const id of ids.plan_ids) { const pr = planProjectOf.get(id); if (pr) coveredProjects.add(pr); }
    const scopeNames = {
      projects: ids.project_ids.map((id) => projectTitle.get(id) ?? id),
      plans: ids.plan_ids.map((id) => planShort.get(id) ?? id),
    };
    // Last activity in the scope and the week's wakes: the one reading
    // org.health uses (orgHealth.roleActivity).
    const activity = await roleActivity(ctx, userId, role, now, { wholeWorkspaceLatest: latestAnywhere });
    const caps = capsFor(role);
    const hands = (scan.byParent.get(`role:${String(role._id)}`) ?? []).length;
    const parent = role.reports_to?.kind === "role"
      ? `@${roleRows.find((r: any) => String(r._id) === String(role.reports_to.role_id))?.handle ?? "?"}`
      : (await ctx.db.get(role.reports_to.user_id))?.name ?? "a person";
    roles.push({
      id: String(role._id),
      short_id: role.short_id,
      name: role.name,
      handle: role.handle,
      status: role.status,
      trust: trustOf(role),
      caps,
      counters: countersFor(role, now),
      reports_to: parent,
      scope: scopeNames,
      whole_workspace: isWholeWorkspace(ids),
      charter: (role.charter ?? "").slice(0, 400) || undefined,
      standing: !!role.anchor_id,
      last_wake_at: role.last_wake_at ?? null,
      hands,
      last_scope_event_at: activity.last_scope_event_at,
      idle_days: activity.idle_days,
      idle: activity.idle,
      wakes_7d: activity.wakes_7d,
      overlaps: overlapsAmong(role, roleRows, planProjectOf).map((o) => ({ handle: o.handle, projects: o.project_ids.length, plans: o.plan_ids.length })),
    });
  }
  const anchors = scan.anchors.map((a: any) => ({ id: String(a._id), name: a.name, status: a.status, role_id: a.org_role_id ? String(a.org_role_id) : undefined }));
  const projectsWithoutRole = wholeWorkspaceRoles > 0 ? [] : work.projects.filter((p) => !coveredProjects.has(p.id)).map((p) => ({ id: p.id, short_id: p.short_id, title: p.title, open_tasks: p.open_tasks }));
  let sessionsUnfiled = 0;
  for (const [key, list] of scan.byParent) if (key.startsWith("user:")) sessionsUnfiled += list.length;
  const longRunning = await longRunningSessions(ctx, scan, now, work);

  return {
    members,
    labels: topOf(labels, ANALYSIS_CAPS.labels),
    git_roots: Array.from(gitRoots.values()).sort((a, b) => b.sessions - a.sessions).slice(0, ANALYSIS_CAPS.git_roots),
    sessions: { total: scan.sessions.size, truncated: scan.truncated, unfiled: sessionsUnfiled, titles_by_path: Object.fromEntries(titlesByPath), long_running: longRunning },
    org: { roles, anchors, projects_without_role: projectsWithoutRole, whole_workspace_roles: wholeWorkspaceRoles },
  };
}

// ── Long running sessions (org-roles-run-work.md R2) ───────────────────────
// A session older than a week that still runs may be a role nobody has named.
// This lists the facts and judges nothing: how old it is, how many helper
// sessions it started inside the window, the routines that wake it, its pinned
// state, its first message and the projects it touched. Whether a session has
// a standing purpose is the analyzer's reading. A session that already is a
// role's standing session (or the workspace's standing agent) is left out; a
// session that reports to a role stays in, with the role named, because a
// manager under a manager is still a manager. The list is the sessions
// with the most evidence of a standing purpose, and `old_enough` says how
// many sessions the age rule let through, so the analyzer can say what it
// did not see. The evidence, strongest first: a routine that still wakes it,
// activity this week, a pinned state, then helpers and messages. Ranking by
// helpers alone listed the largest finished jobs and left out a session a
// routine wakes every day (the Union cold email optimizer, 2026-09-20).
type OrgScanResult = Awaited<ReturnType<typeof collectOrgSessions>>;
const LONG_RUNNING_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
async function longRunningSessions(ctx: Ctx, scan: OrgScanResult, now: number, work: AnalysisHandoff) {
  // The live recurring routines, by the session each wakes, read once ahead
  // of the ranking so every old session is judged by the same facts.
  const routinesBySession = new Map<string, any[]>();
  for (const status of ["scheduled", "running"] as const) {
    const rows: any[] = await ctx.db.query("agent_tasks").withIndex("by_status_run_at", (q: any) => q.eq("status", status)).collect();
    for (const t of rows) {
      if (t.schedule_type === "once" || !t.originating_conversation_id) continue;
      const k = String(t.originating_conversation_id);
      routinesBySession.set(k, [...(routinesBySession.get(k) ?? []), t]);
    }
  }
  const evidence = ({ session, raw }: { session: any; raw: any }) => ({
    routine: routinesBySession.has(String(raw._id)) ? 1 : 0,
    recent: now - (session.updated_at ?? 0) < LONG_RUNNING_RECENT_MS ? 1 : 0,
    pinned: raw.thread_state ? 1 : 0,
    helpers: session.subagent_count as number,
    messages: (raw.message_count ?? 0) as number,
  });
  const old = Array.from(scan.sessions.values())
    .filter(({ raw }) => !raw.anchor_id && !raw.standing_role_id && now - (raw.started_at ?? raw._creationTime ?? now) >= LONG_RUNNING_MIN_AGE_MS)
    .sort((a, b) => {
      const x = evidence(a), y = evidence(b);
      return y.routine - x.routine || y.recent - x.recent || y.pinned - x.pinned || y.helpers - x.helpers || y.messages - x.messages;
    });
  const projectByPath = new Map(work.projects.filter((p) => p.project_path).map((p) => [p.project_path!, p]));
  const projectById = new Map(work.projects.map((p) => [p.id, p]));
  const roleHandle = new Map(scan.roles.map((r: any) => [String(r._id), r.handle]));
  const rows = [];
  for (const { session, raw } of old.slice(0, ANALYSIS_CAPS.long_running)) {
    const startedAt = raw.started_at ?? raw._creationTime;
    const routines: any[] = routinesBySession.get(String(raw._id)) ?? [];
    const opening: any[] = await ctx.db.query("messages").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", raw._id)).order("asc").take(8);
    const first = opening.find((m) => m.role === "user" && typeof m.content === "string" && m.content.trim());
    // The projects it touched, strongest evidence first: the tasks it filed,
    // the task and plans it is bound to, and last its working directory, which
    // on a single repository company names one project for every session and
    // is marked as such so the analyzer weighs it as a hint.
    const task = raw.active_task_id ? await ctx.db.get(raw.active_task_id) : null;
    const touched = new Map<string, { tasks_filed: number; bound: boolean; by_path: boolean }>();
    const touch = (id: unknown) => { const k = String(id); const t = touched.get(k) ?? { tasks_filed: 0, bound: false, by_path: false }; touched.set(k, t); return t; };
    const filed: any[] = await ctx.db.query("tasks").withIndex("by_created_from_conversation", (q: any) => q.eq("created_from_conversation", raw._id)).take(ANALYSIS_CAPS.tasks_filed_per_session);
    for (const t of filed) if (t.project_id) touch(t.project_id).tasks_filed++;
    if (task?.project_id) touch(task.project_id).bound = true;
    for (const planId of new Set([raw.active_plan_id, task?.plan_id, ...(raw.plan_ids ?? [])].filter(Boolean).map(String))) { const plan = await ctx.db.get(planId as Id<"plans">); if (plan?.project_id) touch(plan.project_id).bound = true; }
    if (raw.project_path && projectByPath.has(raw.project_path)) touch(projectByPath.get(raw.project_path)!.id).by_path = true;
    const state = raw.thread_state ? threadStateHeadline(String(raw.thread_state)) : "";
    rows.push({
      short_id: session.short_id ?? undefined,
      title: session.title,
      owner: (await ctx.db.get(session.owner_user_id ?? raw.user_id))?.name ?? undefined,
      started_at: startedAt,
      age_days: Math.floor((now - startedAt) / (24 * 60 * 60 * 1000)),
      last_active_at: session.updated_at,
      messages: raw.message_count ?? 0,
      helpers: session.subagent_count,
      routines: routines.map((t: any) => ({ short_id: t.short_id ?? undefined, title: t.title ?? undefined, schedule: t.schedule_type, every_ms: t.interval_ms ?? undefined })),
      state_line: state || undefined,
      state_status: raw.thread_state_status ?? undefined,
      first_message: first ? String(first.content).trim().slice(0, ANALYSIS_CAPS.first_message_chars) : undefined,
      project_path: session.project_path ?? undefined,
      git_root: raw.git_root ?? undefined,
      projects: Array.from(touched).filter(([id]) => projectById.has(id)).map(([id, how]) => ({ short_id: projectById.get(id)!.short_id, title: projectById.get(id)!.title, tasks_filed: how.tasks_filed, bound: how.bound, by_path_only: how.by_path && !how.bound && !how.tasks_filed }))
        .sort((a, b) => b.tasks_filed - a.tasks_filed || Number(b.bound) - Number(a.bound)),
      tasks_filed: filed.length,
      reports_to_role: raw.org_role_id ? `@${roleHandle.get(String(raw.org_role_id)) ?? "?"}` : undefined,
      private: raw.is_private !== false,
    });
  }
  return { min_age_days: LONG_RUNNING_MIN_AGE_MS / (24 * 60 * 60 * 1000), old_enough: old.length, listed: rows.length, rows };
}

// ── Activity: ground in what is happening, not what was filed (S9) ─────────
// A slice of its own so the commit history and the stale computation get their
// own execution budget on a large workspace. Reads the work rows raw (the org
// slice never reads tasks), the scan, and the commit history of the scanned
// repos, then hands them to the one pure reading of activity (lib/orgActivity).
export async function computeAnalysisActivity(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number) {
  const fetchOpts = teamId ? { userId, workspace: "team" as const, teamId } : { userId, workspace: "personal" as const };
  const [projects, plans, work, scan, initiatives] = await Promise.all([
    scopedFetch(ctx, "projects", { ...fetchOpts, limit: ANALYSIS_CAPS.projects }).then((r) => r.records),
    scopedFetch(ctx, "plans", { ...fetchOpts, limit: ANALYSIS_CAPS.plans }).then((r) => r.records),
    readWorkTasks(ctx, userId, teamId, { perStatus: ANALYSIS_CAPS.tasks, updatedSince: now - ANALYSIS_WINDOW_MS, recentCap: ANALYSIS_CAPS.tasks }),
    collectOrgSessions(ctx, userId, teamId, now),
    scopedFetch(ctx, "initiatives", { ...fetchOpts, limit: ANALYSIS_CAPS.initiatives }).then((r) => r.records),
  ]);
  const tasks = work.tasks;
  const members = [];
  for (const uid of scan.memberIds.slice(0, ANALYSIS_CAPS.members)) {
    const user = await ctx.db.get(uid);
    members.push({ user_id: String(uid), name: user?.name ?? user?.email ?? "", email: user?.email ?? null });
  }
  const commits = await readActivityCommits(ctx, reposFromScan(scan), now - ANALYSIS_WINDOW_MS);
  const activity = computeOrgActivity({
    now,
    commits,
    sessions: activitySessionsFromScan(scan),
    projects: projects.map((p: any) => ({ id: String(p._id), title: p.title, status: p.status, project_path: p.project_path ?? null, updated_at: p.updated_at ?? p._creationTime })),
    plans: plans.map(activityPlanOf),
    tasks: tasks.map((t: any) => ({ id: String(t._id), short_id: t.short_id, title: t.title, status: t.status, plan_id: t.plan_id ? String(t.plan_id) : null, project_id: t.project_id ? String(t.project_id) : null, updated_at: t.updated_at ?? t._creationTime, conversation_ids: (t.conversation_ids ?? []).map((id: any) => String(id)) })),
    members,
    maxAreas: 40,
  });
  // Who answers for the work, from the initiatives down (initiatives-projects-
  // role-page.md I1, I2). This slice already holds every row the reading needs:
  // the raw projects and plans, the open tasks, the roles and the areas.
  const userNames: Record<string, string> = {};
  for (const i of initiatives) if (i.owner?.kind === "user") userNames[String(i.owner.user_id)] ??= (await ctx.db.get(i.owner.user_id))?.name ?? "";
  const coverage = computeCoverage({ projects, plans, tasks, roles: scan.roles, areas: activity.areas, initiatives, userNames });
  return { activity, coverage };
}

// ── Insights, chat channels, open decisions ───────────────────────────────
export async function computeAnalysisSignals(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number) {
  const cutoff = now - ANALYSIS_WINDOW_MS;
  const insightRows: any[] = teamId
    ? await ctx.db.query("session_insights").withIndex("by_team_generated_at", (q: any) => q.eq("team_id", teamId).gte("generated_at", cutoff)).order("desc").take(ANALYSIS_CAPS.insights)
    : await ctx.db.query("session_insights").withIndex("by_actor_generated_at", (q: any) => q.eq("actor_user_id", userId).gte("generated_at", cutoff)).order("desc").take(ANALYSIS_CAPS.insights);
  const themes = new Map<string, number>();
  const outcomes = new Map<string, number>();
  const headlines: Array<{ headline: string; outcome: string; at: number }> = [];
  for (const i of insightRows) {
    for (const t of i.themes ?? []) bump(themes, t);
    bump(outcomes, i.outcome_type ?? "unknown");
    if (headlines.length < 20 && (i.headline || i.goal)) headlines.push({ headline: i.headline ?? i.goal, outcome: i.outcome_type, at: i.generated_at });
  }

  // Chat channels with activity (team only). messages_30d is a floor at the
  // per channel cap.
  const channels: Array<{ id: string; name: string; messages_30d: number; last_at?: number }> = [];
  if (teamId) {
    const rows: any[] = await ctx.db.query("chat_channels").withIndex("by_team_name", (q: any) => q.eq("team_id", teamId)).take(ANALYSIS_CAPS.channels);
    for (const ch of rows) {
      if (!ch.name || ch.archived_at) continue;
      const msgs: any[] = await ctx.db.query("chat_messages").withIndex("by_channel_created", (q: any) => q.eq("channel_id", ch._id).gte("created_at", cutoff)).order("desc").take(ANALYSIS_CAPS.messages_per_channel);
      channels.push({ id: String(ch._id), name: ch.name, messages_30d: msgs.length, last_at: msgs[0]?.created_at });
    }
  }

  // Open decisions by category: one read per member (the asker's account),
  // never the deployment's newest rows; the cap applies per member.
  const memberIds: Id<"users">[] = teamId
    ? (await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect()).map((m: any) => m.user_id)
    : [userId];
  const decisionsByCategory = new Map<string, number>();
  for (const memberId of memberIds) {
    const pending: any[] = await ctx.db.query("session_decisions").withIndex("by_user_status_created", (q: any) => q.eq("user_id", memberId).eq("status", "pending").gte("created_at", cutoff)).order("desc").take(ANALYSIS_CAPS.decisions);
    for (const d of pending) bump(decisionsByCategory, d.category ?? "uncategorized");
  }
  return {
    insights: { total: insightRows.length, themes: topOf(themes, 30), outcomes: objOf(outcomes), headlines },
    insights_truncated: insightRows.length >= ANALYSIS_CAPS.insights,
    channels,
    decisions_open_by_category: objOf(decisionsByCategory),
  };
}

export function mergeAnalysisInputs(
  userId: Id<"users">,
  teamId: Id<"teams"> | undefined,
  workspaceLabel: string,
  work: AnalysisWork,
  org: AnalysisOrg,
  signals: AnalysisSignals,
  now: number,
  activity?: ReturnType<typeof computeOrgActivity>,
  coverage?: ReturnType<typeof computeCoverage>,
) {
  const { handoff: _handoff, truncated, ...rest } = work;
  return {
    workspace: teamId ? { kind: "team" as const, id: String(teamId), name: workspaceLabel } : { kind: "user" as const, id: String(userId), name: workspaceLabel },
    window_days: ANALYSIS_WINDOW_MS / 86_400_000,
    caps: ANALYSIS_CAPS,
    ...rest,
    // A list at its cap is a floor, not a count; the analyzer reports it as
    // "could not verify" rather than as the total.
    truncated: { ...truncated, insights: signals.insights_truncated },
    ...org,
    insights: signals.insights,
    channels: signals.channels,
    decisions_open_by_category: signals.decisions_open_by_category,
    // Ground in what is happening (S9): where code lands, who is in it, and
    // which records the evidence says are done.
    ...(activity ? { activity } : {}),
    // Who answers for it (I1, I2): the initiatives, every project with work
    // and its lead, and the work outside any project.
    ...(coverage ? { coverage } : {}),
    generated_at: now,
  };
}

export async function workspaceLabelOf(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined): Promise<string> {
  return teamId ? (await ctx.db.get(teamId))?.name ?? "" : (await ctx.db.get(userId))?.name ?? "";
}

/** The three slices in one process: tests and server side callers. */
export async function computeAnalysisInputs(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number) {
  const work = await computeAnalysisWork(ctx, userId, teamId);
  const [org, signals, label, activity] = await Promise.all([
    computeAnalysisOrg(ctx, userId, teamId, now, work.handoff),
    computeAnalysisSignals(ctx, userId, teamId, now),
    workspaceLabelOf(ctx, userId, teamId),
    computeAnalysisActivity(ctx, userId, teamId, now),
  ]);
  return mergeAnalysisInputs(userId, teamId, label, work, org, signals, now, activity.activity, activity.coverage);
}

// One slice per call, so each read stays inside the execution limit on a
// large workspace; the action below runs the three and merges them.
export const analysisPart = query({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    part: v.union(v.literal("work"), v.literal("org"), v.literal("signals"), v.literal("activity")),
    work: v.optional(v.any()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    const now = args.now ?? Date.now();
    if (args.part === "work") return computeAnalysisWork(ctx, userId, args.team_id);
    if (args.part === "signals") return { ...(await computeAnalysisSignals(ctx, userId, args.team_id, now)), label: await workspaceLabelOf(ctx, userId, args.team_id), user_id: userId };
    if (args.part === "activity") return computeAnalysisActivity(ctx, userId, args.team_id, now);
    if (!args.work) throw new Error("the org slice needs the work slice's handoff");
    return computeAnalysisOrg(ctx, userId, args.team_id, now, args.work as AnalysisHandoff);
  },
});

export const analysisInputs = action({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args): Promise<any> => {
    const now = Date.now();
    const part = (api as any).orgInit.analysisPart;
    const [work, signals, activity] = await Promise.all([
      ctx.runQuery(part, { ...args, part: "work", now }),
      ctx.runQuery(part, { ...args, part: "signals", now }),
      ctx.runQuery(part, { ...args, part: "activity", now }),
    ]);
    if (!work || !signals) return null;
    const org = await ctx.runQuery(part, { ...args, part: "org", now, work: work.handoff });
    if (!org) return null;
    const { label, user_id, ...rest } = signals;
    return mergeAnalysisInputs(user_id, args.team_id, label, work, org, rest, now, activity?.activity, activity?.coverage);
  },
});

// ── Apply (O2) ────────────────────────────────────────────────────────────────

export type Boundary = { team_id?: Id<"teams">; scope_user_id?: Id<"users"> };
export type ApplyResult =
  | { status: "applied"; note: string; role?: { id: string; short_id: string; handle: string } }
  | { status: "skipped"; note: string }
  | { status: "unanswered" }
  | { status: "error"; error: string };

async function resolveReportsTo(ctx: Ctx, userId: Id<"users">, boundary: Boundary, ref: string | undefined) {
  const trimmed = (ref ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "me") return { kind: "user" as const, user_id: userId };
  const handle = trimmed.replace(/^@/, "").toLowerCase();
  const role = (await rolesInBoundary(ctx, boundary)).find((r) => r.handle === handle || r.short_id === trimmed || String(r._id) === trimmed);
  if (role) return { kind: "role" as const, role_id: role._id as Id<"org_roles"> };
  // A person: a member by name or email inside the boundary.
  const candidates: any[] = boundary.team_id
    ? await Promise.all((await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", boundary.team_id)).collect()).map((m: any) => ctx.db.get(m.user_id)))
    : [await ctx.db.get(userId)];
  const lc = trimmed.toLowerCase();
  const person = candidates.find((u) => u && (String(u._id) === trimmed || (u.name ?? "").toLowerCase() === lc || (u.email ?? "").toLowerCase() === lc));
  if (person) return { kind: "user" as const, user_id: person._id as Id<"users"> };
  throw new Error(`reports_to "${trimmed}" is neither a role nor a member of this workspace`);
}

async function resolveProposalScope(ctx: Ctx, boundary: Boundary, scope: OrgRoleProposal["scope"]) {
  const project_ids: Id<"projects">[] = [];
  const plan_ids: Id<"plans">[] = [];
  for (const ref of scope?.projects ?? []) { const r = await resolveScopeRef(ctx, boundary, `project:${ref}`); if (r.kind === "project") project_ids.push(r.id); }
  for (const ref of scope?.plans ?? []) { const r = await resolveScopeRef(ctx, boundary, `plan:${ref}`); if (r.kind === "plan") plan_ids.push(r.id); }
  return { project_ids, plan_ids };
}

// Taking over a scope takes over its sessions (org-roles-run-work.md R1). The
// sessions in the role's scope that report to its host and to no role are
// filed under the role through the one reparent core, in the same apply that
// gave the role the scope. `dry` counts without writing, for the note a
// person reads before accepting; `leave` is their one edit on the row. A role
// that looks after the whole workspace takes over nothing: it would empty a
// person's inbox into one seat, which is not what gaining a scope means.
const TAKEOVER_NOTE = "It looks after the area you work in. It reads what you need first and decides what reaches a person.";

export async function takeOverSessions(ctx: Ctx, userId: Id<"users">, roleId: Id<"org_roles">, opts: { leave?: boolean; dry?: boolean } = {}): Promise<RehomeResult | null> {
  if (opts.leave) return null;
  const role = await ctx.db.get(roleId);
  if (!role || role.status === "retired" || isWholeWorkspace(role.scope)) return null;
  const resolved = await resolveScope(ctx, userId, { role_id: String(role._id) });
  if (!resolved) return null;
  const candidates = await sessionsInScope(ctx, resolved, Date.now());
  return performRehomeSessions(ctx, userId, role, candidates, { dry: opts.dry, note: TAKEOVER_NOTE });
}

// A bare ref in a change ("pr-1", "pl-7", a project title) in the form the
// scope resolver takes.
const toRef = (s: string) => (/^(project|plan):/.test(s) ? s : /^pl-\d+$/.test(s) ? `plan:${s}` : `project:${s}`);

// The count a person reads BEFORE accepting a role, scope or adopt change. A
// proposed role has no row yet, so this reads a scope and a host rather than a
// role: the live role's scope plus what the change adds, or the proposed
// scope alone with the person applying as the host (performCreateRole's
// default). Always dry.
export async function previewTakeover(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: { handle?: string; add?: string[]; seat?: string }, shared: { scan?: OrgScanResult; roles?: any[] } = {}): Promise<RehomeResult | null> {
  const handle = (p.handle ?? "").replace(/^@/, "").toLowerCase();
  const live = handle ? (shared.roles ?? await rolesInBoundary(ctx, boundary)).find((r) => r.handle === handle || r.short_id === p.handle) : undefined;
  const scope = { project_ids: [...(live?.scope?.project_ids ?? [])], plan_ids: [...(live?.scope?.plan_ids ?? [])] };
  for (const raw of p.add ?? []) {
    const ref = await resolveScopeRef(ctx, boundary, toRef(raw)).catch(() => null);
    if (ref?.kind === "project") scope.project_ids.push(ref.id);
    else if (ref?.kind === "plan") scope.plan_ids.push(ref.id);
  }
  if (isWholeWorkspace(scope)) return null;
  const resolved = await resolveScope(ctx, userId, { scope, team_id: boundary.team_id });
  if (!resolved) return null;
  // The session the role will be seated on (R2) is its standing session by
  // the time the takeover runs, so it is not one of the sessions that move.
  const seat = p.seat?.trim();
  const candidates = (await sessionsInScope(ctx, resolved, Date.now(), shared.scan)).filter(({ raw }) => !seat || ![raw.short_id, String(raw._id), raw.session_id].includes(seat));
  const subject = live ?? { host_user_id: userId, team_id: boundary.team_id };
  // A live role's own sessions are already its; the filter drops them (they
  // carry a role), so only sessions that would newly move are counted.
  return performRehomeSessions(ctx, userId, subject, candidates, { dry: true });
}

// One page asks for every row it shows in ONE call (a proposal's role, scope
// and adopt rows; the one pending edit of Settings or the lead chip), and the
// answers come back in the order asked. The org scan and the boundary's roles
// are read once for all of them: a query per row would each scan the
// workspace's sessions again, live, on every session heartbeat.
export const TAKEOVER_PREVIEW_CAP = 40;
export type TakeoverPreview = { sessions: string[]; kept_in_front: string[]; over_cap: number; phrase: string };

export async function previewTakeovers(ctx: Ctx, userId: Id<"users">, boundary: Boundary, items: Array<{ handle?: string; add?: string[]; seat?: string }>): Promise<Array<TakeoverPreview | null>> {
  const asked = items.slice(0, TAKEOVER_PREVIEW_CAP);
  if (!asked.length) return [];
  const shared = { scan: await collectOrgSessions(ctx, userId, boundary.team_id, Date.now()), roles: await rolesInBoundary(ctx, boundary) };
  const out: Array<TakeoverPreview | null> = [];
  for (const item of asked) {
    const r = await previewTakeover(ctx, userId, boundary, item, shared);
    out.push(r ? { sessions: r.sessions, kept_in_front: r.kept_in_front, over_cap: r.over_cap, phrase: takeoverPhrase((item.handle ?? "").replace(/^@/, "").toLowerCase(), r, false) } : null);
  }
  return out;
}

export const takeoverPreview = query({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    items: v.array(v.object({ handle: v.optional(v.string()), add: v.optional(v.array(v.string())), seat: v.optional(v.string()) })),
  },
  handler: async (ctx, args): Promise<Array<TakeoverPreview | null>> => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return [];
    return previewTakeovers(ctx, userId, { team_id: args.team_id, scope_user_id: args.team_id ? undefined : userId }, args.items);
  },
});

// One writer for the sentence (contracts/orgProposal.takeoverPhrase), so the
// note before accept, the note after apply and every page say the same thing.
export { takeoverPhrase };

export async function applyRole(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgRoleProposal, note: string | undefined, opts: { provision: boolean; human_decision: string; awaiting_adopt?: string }): Promise<ApplyResult> {
  const handle = p.handle.trim().toLowerCase();
  const charter = [p.charter?.trim(), note ? `Changes asked for by the person who approved this role:\n${note}` : undefined].filter(Boolean).join("\n\n") || undefined;
  // A live role with this handle is never adopted: it may be one the person
  // made by hand with its own scope and charter, and the proposal would be
  // silently discarded. The mutation is atomic, so a crash between create and
  // the applied_at stamp cannot leave a half-applied role behind; the only way
  // to get here is a real clash, and the person picks another handle or skips.
  const taken = (await rolesInBoundary(ctx, boundary)).find((r) => r.handle === handle);
  if (taken) return { status: "error", error: `@${handle} is already ${taken.short_id} (${taken.name}); answer with changes to pick another handle, or skip` };
  const scope = await resolveProposalScope(ctx, boundary, p.scope);
  // A role that names its session keeps the session's reporting line: with no
  // reports_to, the parent is the person who runs the session, not whoever
  // accepts the proposal (org-roles-run-work.md R2; the card promises naming
  // changes nothing about how it works).
  const reports_to = p.seat && !p.reports_to?.trim() ? await seatOwnerOf(ctx, p.seat.existing) : await resolveReportsTo(ctx, userId, boundary, p.reports_to);
  const role = await performCreateRole(ctx, userId, { name: p.name, handle, team_id: boundary.team_id, scope, reports_to, charter, tenure: p.tenure, avatar: p.avatar, host_user_id: p.seat ? await seatRunnerOf(ctx, p.seat.existing) : undefined });
  if (p.caps) await performSetCaps(ctx, userId, { role_id: String(role._id), hands: p.caps.hands_per_day, wakes: p.caps.wakes_per_day, tokens: p.caps.tokens_per_day, human_decision: opts.human_decision });
  // A role that names its session (org-roles-run-work.md R2) is seated on it
  // in this same apply, whatever `provision` says: the session IS the role, so
  // a role row without it would be a name for nothing. A session that cannot
  // be seated throws, the mutation rolls back, and the change lands as failed
  // with the reason, never as a role with a fresh session nobody asked for.
  let provisioned = false;
  let seated: string | undefined;
  if (p.seat) {
    seated = await seatExistingSession(ctx, userId, role, p.seat.existing);
  } else if (opts.provision && !opts.awaiting_adopt) {
    const firstProject = role.scope?.project_ids?.[0] ? await ctx.db.get(role.scope.project_ids[0]) : null;
    await performProvisionRole(ctx, userId, { role_id: String(role._id), project_path: firstProject?.project_path ?? undefined });
    provisioned = true;
  }
  // After the seat exists, so the seated session is never a candidate (R1).
  const tookOver = takeoverPhrase(role.handle, await takeOverSessions(ctx, userId, role._id, { leave: p.leave_sessions }), true);
  return {
    status: "applied",
    note: `created @${role.handle} (${role.short_id})${seated ? `; ${seated} is its standing session, with its history and its helper sessions as they were` : provisioned ? ", standing session provisioned" : opts.awaiting_adopt ? `; its standing session is the adopt of ${opts.awaiting_adopt} in this proposal (skip that and provision from the role's page)` : ""}${tookOver ? `; ${tookOver}` : ""}`,
    role: { id: String(role._id), short_id: role.short_id, handle: role.handle },
  };
}

export async function applyProjects(ctx: Ctx, userId: Id<"users">, boundary: Boundary, changes: OrgProjectChange[], note: string | undefined): Promise<ApplyResult> {
  const key = workspaceKey(boundary.team_id ? { type: "team", teamId: boundary.team_id } : { type: "personal", userId });
  const now = Date.now();
  const done: string[] = [];
  const findProject = async (ref: string) => {
    const r = await resolveScopeRef(ctx, boundary, `project:${ref}`);
    return r.kind === "project" ? await ctx.db.get(r.id) : null;
  };
  for (const c of changes) {
    if (c.op === "create") {
      // Idempotent by title: a re-run after a crash must not mint a twin.
      let existing: any = null;
      try { existing = await findProject(c.title); } catch { existing = null; }
      if (existing && existing.title.toLowerCase() === c.title.toLowerCase()) { done.push(`project "${c.title}" already exists`); continue; }
      await ctx.db.insert("projects", {
        user_id: userId,
        team_id: boundary.team_id,
        workspace: key,
        title: c.title.trim(),
        description: [c.description?.trim(), note].filter(Boolean).join("\n\n") || undefined,
        status: "active",
        project_path: c.project_path,
        created_at: now,
        updated_at: now,
      });
      done.push(`created project "${c.title}"`);
    } else {
      const from = await findProject(c.from);
      const into = await findProject(c.into);
      if (!from || !into) throw new Error(`merge: project "${!from ? c.from : c.into}" not found in this workspace`);
      if (String(from._id) === String(into._id)) continue;
      let moved = 0;
      for (const table of ["tasks", "plans", "docs"]) {
        const rows: any[] = await ctx.db.query(table).withIndex("by_project_id", (q: any) => q.eq("project_id", from._id)).collect();
        for (const row of rows) { await ctx.db.patch(row._id, { project_id: into._id, updated_at: now }); moved++; }
      }
      await ctx.db.patch(from._id, { status: "done", description: `${from.description ?? ""}\n\nMerged into ${into.title} by cast org apply.`.trim(), updated_at: now });
      done.push(`merged "${from.title}" into "${into.title}" (${moved} rows moved)`);
    }
  }
  return { status: "applied", note: done.join("; ") || "nothing to change" };
}

export async function applyMove(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: { handle: string; reports_to?: string; scope_add?: string[]; scope_remove?: string[]; leave_sessions?: boolean }, humanDecision: string): Promise<ApplyResult> {
  const handle = p.handle.replace(/^@/, "").toLowerCase();
  const role = (await rolesInBoundary(ctx, boundary)).find((r) => r.handle === handle || r.short_id === p.handle);
  if (!role) throw new Error(`No live role @${handle} in this workspace`);
  const did: string[] = [];
  if (p.scope_add?.length || p.scope_remove?.length) {
    // Gained scope takes over the sessions in it (R1), inside the role update
    // every scope gain goes through; a role that only lost scope takes nothing.
    const updated = await performSetRoleScope(ctx, userId, { role_id: String(role._id), add: (p.scope_add ?? []).map(toRef), remove: (p.scope_remove ?? []).map(toRef), human_decision: humanDecision, leave_sessions: p.leave_sessions });
    did.push(`scope ${[...(p.scope_add ?? []).map((s) => `+${s}`), ...(p.scope_remove ?? []).map((s) => `-${s}`)].join(" ")}`);
    if (updated.took_over?.phrase) did.push(updated.took_over.phrase);
  }
  if (p.reports_to) {
    await performReparentRole(ctx, userId, { role_id: String(role._id), reports_to: await resolveReportsTo(ctx, userId, boundary, p.reports_to) });
    did.push(`now reports to ${p.reports_to}`);
  }
  return { status: "applied", note: `@${role.handle}: ${did.join("; ") || "nothing to change"}`, role: { id: String(role._id), short_id: role.short_id, handle: role.handle } };
}

export async function applyRetire(ctx: Ctx, userId: Id<"users">, boundary: Boundary, handleRef: string): Promise<ApplyResult> {
  const handle = handleRef.replace(/^@/, "").toLowerCase();
  const role = (await rolesInBoundary(ctx, boundary)).find((r) => r.handle === handle || r.short_id === handleRef);
  // No live role by that handle: a mistyped handle must not read as a green
  // applied row while the role it meant stays. Failed stays decidable.
  if (!role) return { status: "error", error: `No live role @${handle} in this workspace: it is already retired, or the handle is wrong; edit the handle or skip` };
  const r = await performRetireRole(ctx, userId, { role_id: String(role._id) });
  return { status: "applied", note: `retired @${role.handle} (${r.cleared} sessions back under their owners, ${r.rehomed} roles re-homed)` };
}

// ── The staffing changes (org-staffing.md S4) ────────────────────────────────
// Six more change kinds, each a thin call into the role writers with the
// person's decision as the human authority. `applyOrgChange` is the one
// dispatcher the proposal mutations use for every kind, old and new.

export type ApplyOpts = {
  provision: boolean;
  human_decision: string;
  /** The session an adopt change of the SAME proposal will seat as this
   *  role's standing session. The role is then created without one: a fresh
   *  session here would make the later adopt a no-op and leave the workspace
   *  with two root agents while the note claimed the anchor was adopted. */
  awaiting_adopt?: string;
};

async function liveRole(ctx: Ctx, boundary: Boundary, handleRef: string) {
  const handle = handleRef.replace(/^@/, "").toLowerCase();
  const role = (await rolesInBoundary(ctx, boundary)).find((r) => r.handle === handle || r.short_id === handleRef);
  if (!role) throw new Error(`No live role @${handle} in this workspace`);
  return role;
}
const roleRef = (role: any) => ({ id: String(role._id), short_id: role.short_id, handle: role.handle });

export async function applyScope(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgScopeChange, opts: ApplyOpts): Promise<ApplyResult> {
  return applyMove(ctx, userId, boundary, { handle: p.handle, scope_add: p.add, scope_remove: p.remove, leave_sessions: p.leave_sessions }, opts.human_decision);
}

export async function applyBudget(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgBudgetChange, opts: ApplyOpts): Promise<ApplyResult> {
  const role = await liveRole(ctx, boundary, p.handle);
  const before = capsFor(role);
  const updated = await performSetCaps(ctx, userId, { role_id: String(role._id), hands: p.caps.hands_per_day, wakes: p.caps.wakes_per_day, tokens: p.caps.tokens_per_day, human_decision: opts.human_decision });
  const moved = (["hands_per_day", "wakes_per_day", "tokens_per_day"] as const).filter((k) => before[k] !== updated.caps[k]).map((k) => `${k.replace("_per_day", "")} ${before[k]} → ${updated.caps[k]}/day`);
  return { status: "applied", note: `@${role.handle}: ${moved.join(", ") || "caps unchanged"}`, role: roleRef(role) };
}

export async function applyTrust(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgTrustChange, opts: ApplyOpts): Promise<ApplyResult> {
  const role = await liveRole(ctx, boundary, p.handle);
  const r = await performSetTrust(ctx, userId, { role_id: String(role._id), trust: p.trust, human_decision: opts.human_decision });
  return { status: "applied", note: `@${role.handle}: trust ${r.previous_trust} → ${p.trust}`, role: roleRef(role) };
}

// A routine is a recurring trigger on the role's standing session, through
// the same insert every `cast trigger add --every` uses. The first run is one
// cadence out: the person accepted a rhythm, not an immediate wake.
export async function applyRoutine(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgRoutineChange, opts: ApplyOpts): Promise<ApplyResult> {
  const role = await liveRole(ctx, boundary, p.handle);
  const interval = orgEveryToMs(p.every);
  if (!interval) throw new Error(`"${p.every}" is not a cadence like 7d, 1d or 12h`);
  const standing = await standingConversationOf(ctx, role);
  if (!standing) throw new Error(`@${role.handle} has no standing session to run a routine on; provision the role first`);
  const now = Date.now();
  const created = await insertTask(ctx as any, standing.user_id, {
    title: p.title.trim(),
    prompt: p.prompt,
    target_conversation_id: String(standing._id),
    originating_conversation_id: String(standing._id),
    project_path: standing.project_path ?? undefined,
    agent_type: standing.agent_type === "claude_code" ? "claude" : standing.agent_type ?? undefined,
    schedule_type: "recurring",
    interval_ms: interval,
    run_at: now + interval,
  });
  return { status: "applied", note: `@${role.handle}: routine "${p.title.trim()}" every ${p.every} (${created.short_id})`, role: roleRef(role) };
}

// The charter fields on a project (org-staffing.md S7), through the one
// charter writer every project and plan update calls (lib/orgCharter).
export async function applyProjectMeta(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgProjectMetaChange, _opts: ApplyOpts): Promise<ApplyResult> {
  const ref = await resolveScopeRef(ctx, boundary, `project:${p.project}`);
  const project = ref.kind === "project" ? await ctx.db.get(ref.id) : null;
  if (!project) throw new Error(`No project "${p.project}" in this workspace`);
  const { project: _ref, kind: _kind, ...fields } = p;
  const patch = await charterPatch(ctx, project, fields, "projects");
  await ctx.db.patch(project._id, { ...patch, updated_at: Date.now() });
  const did = Object.keys(patch).map((k) => (k === "owner_role_id" ? `owner ${p.owner}` : k === "priority" ? String(patch.priority ?? "no priority") : k.replace(/_/g, " ")));
  return { status: "applied", note: `project "${project.title}": ${did.join(", ") || "nothing to change"}` };
}

// This session becomes the role's standing session (org-staffing.md S6):
// the provision path with adopt_conversation_id, which takes a short id, a
// row id or the native session id the CLI knows itself by.
export async function applyAdopt(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgAdoptChange, _opts: ApplyOpts): Promise<ApplyResult> {
  const role = await liveRole(ctx, boundary, p.handle);
  try {
    const seated = await seatExistingSession(ctx, userId, role, p.conversation);
    const tookOver = takeoverPhrase(role.handle, await takeOverSessions(ctx, userId, role._id, { leave: p.leave_sessions }), true);
    return { status: "applied", note: `@${role.handle}: adopted ${seated} as its standing session${tookOver ? `; ${tookOver}` : ""}`, role: roleRef(role) };
  } catch (e: any) {
    if (e instanceof SeatTakenError) return { status: "error", error: e.message };
    throw e;
  }
}

class SeatTakenError extends Error {}
/** The person who runs a session named as a seat: its owner, else the user
 *  who started it. Throws when nothing answers to the ref, so a role is never
 *  created for a session nobody can find. */
async function seatOwnerOf(ctx: Ctx, ref: string): Promise<{ kind: "user"; user_id: Id<"users"> }> {
  const conv = await findConversationByAnyRefWhere(ctx, ref.trim(), async () => true);
  if (!conv) throw new Error(`Session not found: ${ref.trim()}`);
  return { kind: "user", user_id: (conv.owner_user_id ?? conv.user_id) as Id<"users"> };
}
/** Who runs the session a role is named on: the role's host (R2). The
 *  runner, not an added owner: the standing session acts under the runner's
 *  token, and the host is who the role's own writes are checked against. */
async function seatRunnerOf(ctx: Ctx, ref: string): Promise<Id<"users">> {
  const conv = await findConversationByAnyRefWhere(ctx, ref.trim(), async () => true);
  if (!conv) throw new Error(`Session not found: ${ref.trim()}`);
  return conv.user_id as Id<"users">;
}
/** The one seating of an existing session on a role, for an adopt change and
 *  for a role change that names its session. Answers the seated session's
 *  short id. Provision is idempotent per role: a role that already has a
 *  standing session keeps it and adopts nothing. Saying "adopted" then would
 *  be a lie with a second agent behind it, so that case throws. */
async function seatExistingSession(ctx: Ctx, userId: Id<"users">, role: any, conversation: string): Promise<string> {
  const ref = conversation.trim();
  const r = await performProvisionRole(ctx, userId, { role_id: String(role._id), adopt_conversation_id: ref });
  if (!r?.adopted) throw new SeatTakenError(`@${role.handle} already has a standing session, so ${ref} was not adopted; retire that session first (or skip this change) rather than run two agents for one seat`);
  return r?.short_id ?? ref;
}

// File a plan under a project (the review's "18 plans with open work under no
// project"): both refs resolve inside the boundary, the plan row and its doc
// take the project, the way a project merge moves them (applyProjects).
export async function applyFile(ctx: Ctx, _userId: Id<"users">, boundary: Boundary, p: OrgFileChange, _opts: ApplyOpts): Promise<ApplyResult> {
  const planRef = await resolveScopeRef(ctx, boundary, `plan:${p.plan}`);
  const projectRef = await resolveScopeRef(ctx, boundary, `project:${p.project}`);
  const plan = planRef.kind === "plan" ? await ctx.db.get(planRef.id) : null;
  const project = projectRef.kind === "project" ? await ctx.db.get(projectRef.id) : null;
  if (!plan || !project) throw new Error(`No ${!plan ? `plan "${p.plan}"` : `project "${p.project}"`} in this workspace`);
  if (String(plan.project_id ?? "") === String(project._id)) return { status: "applied", note: `${plan.short_id} is already under "${project.title}"` };
  const now = Date.now();
  await ctx.db.patch(plan._id, { project_id: project._id, updated_at: now });
  if (plan.doc_id) { const doc = await ctx.db.get(plan.doc_id); if (doc) await ctx.db.patch(doc._id, { project_id: project._id, updated_at: now }); }
  return { status: "applied", note: `filed ${plan.short_id} "${plan.title}" under "${project.title}"` };
}

// ── Bring records in line (org-staffing.md S9) ──────────────────────────────
// A plan, task or project whose evidence says it is finished gets its status
// set through the same paths a person uses: the status validity, the plan
// progress reconcile, the independent review rule on a task close. The person
// deciding the proposal is the human authority, so a task close carries a
// person's approve verdict (the board's rule), which is outside every role.

const PLAN_STATUSES = new Set(["done", "abandoned", "active"]);
const TASK_STATUSES = new Set(["done", "dropped", "open", "backlog"]);
const PROJECT_STATUSES = new Set(["paused", "done", "active"]);
const OPEN_TASK = (t: any) => t.status !== "done" && t.status !== "dropped";

/** One task's status set the way a person sets it: the team's status
 *  vocabulary (a backlog only where the team has one), the independent
 *  review rule on a close (a person's approve is the verdict from outside
 *  every role), the bound sessions released and the plan's progress
 *  reconciled. Shared by the task change and by a plan close's cascade, so
 *  there is one path a proposal can move a task through. */
async function setTaskStatus(ctx: Ctx, boundary: Boundary, task: any, status: string, now: number): Promise<void> {
  const write = await resolveStatusWrite(ctx, boundary.team_id ?? null, task.status, { status });
  const next = write.status ?? status;
  const closing = next === "done" || next === "dropped";
  const verdict = next === "done" ? { verdict: "approve" as const, at: now, note: "closed by an org proposal" } : undefined;
  await enforceIndependentReview(ctx, task, null, next, verdict);
  const patch: Record<string, any> = { status: next, status_id: write.statusId.set ? write.statusId.value : task.status_id, updated_at: now, closed_at: closing ? now : undefined };
  if (verdict) patch.review_verdict = verdict;
  // A hand's "blocked" or "needs context" is a claim about open work; on a
  // closed task it is history that would read as a live stall.
  if (closing && (task.execution_status === "blocked" || task.execution_status === "needs_context")) patch.execution_status = undefined;
  if (next === "done" && task.started_at) patch.actual_minutes = Math.round((now - task.started_at) / 60000);
  await ctx.db.patch(task._id, patch);
  if (closing) {
    for (const convId of task.conversation_ids ?? []) {
      const conv = await ctx.db.get(convId);
      if (conv && String(conv.active_task_id ?? "") === String(task._id)) await ctx.db.patch(convId, { active_task_id: undefined });
    }
  }
  if (task.plan_id) await recalcPlanProgress(ctx, task.plan_id, task._id, next);
}

// Closing a plan closes its open tasks in the same apply: a plan marked done
// or abandoned with rows still open would otherwise leave the ledger telling
// the old story, and the analyzer had to propose one change per task to
// follow it. The tasks are dropped, never done: the plan closed without them,
// and done would claim work the evidence does not show. A task the proposal
// marks done on its own evidence lands first (task_status ranks before
// plan_status) and is already closed when the cascade reads the plan.
export async function applyPlanStatus(ctx: Ctx, _userId: Id<"users">, boundary: Boundary, p: OrgPlanStatusChange, _opts: ApplyOpts): Promise<ApplyResult> {
  if (!PLAN_STATUSES.has(p.status)) throw new Error(`plan status "${p.status}" is not one of done, abandoned, active`);
  const ref = await resolveScopeRef(ctx, boundary, `plan:${p.plan}`);
  const plan = ref.kind === "plan" ? await ctx.db.get(ref.id) : null;
  if (!plan) throw new Error(`No plan "${p.plan}" in this workspace`);
  const now = Date.now();
  const same = plan.status === p.status;
  const closing = p.status === "done" || p.status === "abandoned";
  if (same && !closing) return { status: "applied", note: `${plan.short_id} is already ${p.status}` };
  if (!same) await ctx.db.patch(plan._id, { status: p.status, updated_at: now });
  // A closed plan with rows still open is the record the evidence contradicts
  // whether the close is new or old (a plan marked done months ago and never
  // swept), so re-asserting done or abandoned sweeps the same way.
  let cascade = "";
  if (closing) {
    const open: any[] = (await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).collect()).filter((t: any) => OPEN_TASK(t) && isActiveTask(t));
    open.sort((a, b) => String(a.short_id).localeCompare(String(b.short_id), undefined, { numeric: true }));
    for (const t of open) await setTaskStatus(ctx, boundary, t, "dropped", now);
    if (open.length) cascade = `; dropped its ${open.length} open task${open.length === 1 ? "" : "s"}: ${open.map((t) => t.short_id).join(", ")}`;
  }
  if (same) return { status: "applied", note: `${plan.short_id} is already ${p.status}${cascade || "; no open tasks under it"}` };
  return { status: "applied", note: `${plan.short_id} "${plan.title}": ${plan.status} → ${p.status}${cascade}` };
}

export async function applyProjectStatus(ctx: Ctx, _userId: Id<"users">, boundary: Boundary, p: OrgProjectStatusChange, _opts: ApplyOpts): Promise<ApplyResult> {
  if (!PROJECT_STATUSES.has(p.status)) throw new Error(`project status "${p.status}" is not one of paused, done, active`);
  const ref = await resolveScopeRef(ctx, boundary, `project:${p.project}`);
  const project = ref.kind === "project" ? await ctx.db.get(ref.id) : null;
  if (!project) throw new Error(`No project "${p.project}" in this workspace`);
  if (project.status === p.status) return { status: "applied", note: `"${project.title}" is already ${p.status}` };
  await ctx.db.patch(project._id, { status: p.status, updated_at: Date.now() });
  return { status: "applied", note: `project "${project.title}": ${project.status} → ${p.status}` };
}

// A task's status from a proposal is a person's act: a close runs the same
// independent review rule a role write goes through (setTaskStatus), and
// open or backlog puts a row that was marked in progress but never worked
// back where it belongs. A backlog only exists where the team's statuses
// have one; elsewhere the write is refused with the team's vocabulary, and
// the change lands as failed for the person to edit.
export async function applyTaskStatus(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgTaskStatusChange, _opts: ApplyOpts): Promise<ApplyResult> {
  if (!TASK_STATUSES.has(p.status)) throw new Error(`task status "${p.status}" is not one of done, dropped, open, backlog`);
  const key = workspaceKey(boundary.team_id ? { type: "team", teamId: boundary.team_id } : { type: "personal", userId });
  const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", p.task.trim())).first();
  if (!task || workspaceKey(workspaceForResource(task)) !== key) throw new Error(`No task "${p.task}" in this workspace`);
  if (task.status === p.status) return { status: "applied", note: `${task.short_id} is already ${p.status}` };
  await setTaskStatus(ctx, boundary, task, p.status, Date.now());
  return { status: "applied", note: `${task.short_id} "${task.title}": ${task.status} → ${p.status}` };
}

/** One change of any kind, applied. Throws on a refusal; the caller records it. */
export async function applyOrgChange(ctx: Ctx, userId: Id<"users">, boundary: Boundary, change: OrgChange, opts: ApplyOpts, note?: string): Promise<ApplyResult> {
  switch (change.kind) {
    case "role": return applyRole(ctx, userId, boundary, change, note, opts);
    case "projects": return applyProjects(ctx, userId, boundary, change.changes, note);
    case "move": return applyMove(ctx, userId, boundary, change, opts.human_decision);
    case "retire": return applyRetire(ctx, userId, boundary, change.handle);
    case "scope": return applyScope(ctx, userId, boundary, change, opts);
    case "budget": return applyBudget(ctx, userId, boundary, change, opts);
    case "trust": return applyTrust(ctx, userId, boundary, change, opts);
    case "routine": return applyRoutine(ctx, userId, boundary, change, opts);
    case "project_meta": return applyProjectMeta(ctx, userId, boundary, change, opts);
    case "adopt": return applyAdopt(ctx, userId, boundary, change, opts);
    case "file": return applyFile(ctx, userId, boundary, change, opts);
    case "plan_status": return applyPlanStatus(ctx, userId, boundary, change, opts);
    case "task_status": return applyTaskStatus(ctx, userId, boundary, change, opts);
    case "project_status": return applyProjectStatus(ctx, userId, boundary, change, opts);
  }
}

// One answered decision → one org change. Reads the proposal block from the
// decision's context, acts on the verdict, and stamps applied_at so a second
// run skips it. Errors come back as values: the CLI walks a whole stack and
// one refusal must not hide the rest.
export async function performApplyDecision(ctx: Ctx, userId: Id<"users">, ref: string, opts: { provision?: boolean } = {}): Promise<ApplyResult & { decision: string }> {
  const decision = await findDecision(ctx, ref);
  if (!decision) return { status: "error", error: `Decision not found: ${ref}`, decision: ref };
  const id = decision.short_id ?? String(decision._id);
  const proposal = extractOrgProposal(decision.context_md);
  if (!proposal) return { status: "error", error: `${id} carries no org proposal block`, decision: id };
  if ((decision as any).applied_at) return { status: "skipped", note: `already applied: ${(decision as any).applied_note ?? ""}`.trim(), decision: id };
  if (decision.status !== "answered") return { status: decision.status === "pending" ? "unanswered" : "skipped", note: decision.status, decision: id } as any;
  const verdict = orgProposalVerdict(decision.answer_index);
  if (!verdict) return { status: "error", error: `${id}: answer index ${decision.answer_index} is not one of the three proposal options`, decision: id };
  // Reshaping the org is a person's act (org-roles-standing.md T4): scope,
  // caps and charters are human only, and the answer is the human act this
  // apply carries. A role's delegated answer or a policy default is not one.
  const by = (decision as any).answered_by;
  if (by?.kind !== "user") return { status: "error", error: `${id}: an org proposal applies only when a person answered it (answered by ${by?.kind ?? "nobody"})`, decision: id };
  const humanDecision = String(decision._id);

  // The boundary is the stack's; a lone decision falls back to the asking
  // session's workspace. The caller must be able to reshape the stack.
  const stack = decision.stack_id ? await ctx.db.get(decision.stack_id) : null;
  const conv = await ctx.db.get(decision.conversation_id);
  const teamId: Id<"teams"> | undefined = stack ? stack.team_id ?? undefined : conv?.team_id ?? undefined;
  const boundary: Boundary = teamId ? { team_id: teamId } : { scope_user_id: userId };
  if (stack && !(await userCanAdminRole(ctx, userId, { host_user_id: stack.owner_user_id, scope_user_id: stack.scope_user_id, team_id: stack.team_id }))) {
    return { status: "error", error: `${id}: only the stack's owner or a team admin can apply it`, decision: id };
  }

  const stamp = async (note: string) => ctx.db.patch(decision._id, { applied_at: Date.now(), applied_note: note.slice(0, 500) });
  if (verdict === "skip") {
    await stamp("skipped by the person");
    return { status: "skipped", note: "skipped by the person", decision: id };
  }
  const changed = verdict === "apply_with_changes" ? applyProposalChanges(proposal, decision.answer_text) : { proposal, note: undefined };
  const p: OrgProposal = changed.proposal;
  try {
    const result = await applyOrgChange(ctx, userId, boundary, p, { provision: opts.provision ?? true, human_decision: humanDecision }, changed.note);
    if (result.status === "applied") await stamp(result.note);
    return { ...result, decision: id };
  } catch (err) {
    return { status: "error", error: `${id}: ${err instanceof Error ? err.message : String(err)}`, decision: id };
  }
}

export const applyDecision = mutation({
  args: { api_token: v.optional(v.string()), decision: v.string(), provision: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    return performApplyDecision(ctx, userId, args.decision, { provision: args.provision });
  },
});
