import { labelsOf, noteOrgChange, recordSubject, roleSubject, whereOfRecord, whereOfRole, withOrgChange } from "./lib/orgChangeLog";
import { movedFields } from "@codecast/shared/contracts/orgChange";
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
import { activityPlanOf, computeOrgActivity, namedTextOf, namesRecord, recordWords } from "./lib/orgActivity";
import { canAccessChannel } from "./chatAccess";
import { canReadCall } from "./transcripts";
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
  rolesInBoundary, performSetAuthority, performSetProjectLead } from "./orgRoles";
import { performAcceptUpgrade, performUpsertInstance } from "./orgTemplates";
import { capsFor, countersFor, roleStartsOnItsOwn, trustOf } from "./orgEvents";
import { autonomyChangeWords } from "@codecast/shared/contracts/roleAutonomy";
import { findDecision } from "./sessionDecisions";
import { extractRepoFromRemoteUrl, isRecRoomKey, threadStateHeadline } from "@codecast/shared/contracts";
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
  type OrgTrustChange, authorityWords, type OrgAuthorityChange, type OrgHireChange, type OrgUpgradeChange,
  type OrgInitiativeChange, type OrgInitiativeOwnerChange, type OrgInitiativeProjectsChange } from "@codecast/shared/contracts/orgProposal";
import { performAddProjects, performCreateInitiative, performUpdateInitiative } from "./initiatives";
import { findInitiative } from "./lib/initiativeRef";
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
  open_plans: 600,
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
  use_messages_per_session: 400,
  first_message_chars: 600,
  /** A long running session's commits in the window, for its work share by project. */
  commits_per_session: 200,
  /** The chars of one session message scanned for a project's name. */
  message_scan_chars: 4000,
  /** What people said: the team's ended calls in the window, and the chat threads with a decision, an ask or a name in them, under one byte budget. */
  calls: 40,
  said_bytes: 40_000,
  said_line_chars: 400,
  said_reply_chars: 240,
  said_replies_per_thread: 3,
  call_summary_chars: 1200,
  call_action_items: 10,
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
    // The plan's own stored progress counts every task under it; the window's
    // tasks hold only the open ones and the ones written lately, so a plan
    // whose work landed months ago read as "0 of 75" here against 88 of 164 on
    // its page (Codecast pl-313, 2026-09-21), and a run abandoned it as never
    // started. The window count stands in only where the row carries none.
    const counted = { total: mine.length, done: 0, in_progress: 0, open: 0 };
    for (const t of mine) {
      if (t.status === "done") counted.done++;
      else if (t.status === "in_progress" || t.status === "in_review") counted.in_progress++;
      else counted.open++;
    }
    const progress = pl.progress && pl.progress.total > 0 ? { ...pl.progress, source: "plan" as const } : { ...counted, source: "window" as const };
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
    // The session that is this role (a seat named from a running session, or
    // a standing agent's own conversation), so a review reads it as already
    // named: an update run re-proposed three seated sessions under new handles
    // because nothing on the role row said which session it was (2026-09-22).
    const seatRow: any = await ctx.db.query("conversations").withIndex("by_standing_role", (q: any) => q.eq("standing_role_id", role._id)).first();
    roles.push({
      id: String(role._id),
      short_id: role.short_id,
      name: role.name,
      handle: role.handle,
      status: role.status,
      seat: seatRow ? { session: seatRow.short_id ?? String(seatRow._id), title: seatRow.title ?? "" } : undefined,
      trust: trustOf(role),
      starts_on_its_own: roleStartsOnItsOwn(role),
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
  const longRunning = await longRunningSessions(ctx, scan, now, work, userId, teamId);

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
// ── Measured use: what a long running session spends in a week ─────────────
// A seated session's daily limit must never stop work that runs today, so the
// analyzer needs what the session spends now, not a guess: three Union samples
// set the same session's limit at 300,000 to 1,000,000 tokens a day and the
// letter's cost line moved with it (2026-09-21). The unit is the one the role
// caps count, input plus output tokens (messages.rollUpUsage), over the
// session's messages of the last week. The row says how many days the figure
// covers: usage on messages exists only from 2026-09-13, a session younger
// than the week covers fewer days, and a session read at the cap covers the
// days its newest rows span. A session whose messages carry no usage block
// (another backend, older rows) is not counted, and the analyzer keeps the
// default limit as provisional rather than sizing on nothing.
export const SESSION_USE_DAYS = 7;
export const USAGE_RECORDED_SINCE = Date.UTC(2026, 8, 13);
export type SessionUse = { days: number; tokens: number; calls: number; per_day: { tokens: number; calls: number }; counted: boolean; messages_read: number; truncated: boolean };
type UsageMessage = { timestamp?: number; usage?: { input_tokens?: number; output_tokens?: number } | null };
export function sessionUseOf(rows: UsageMessage[], startedAt: number, now: number, cap: number = ANALYSIS_CAPS.use_messages_per_session): SessionUse {
  const D = 24 * 60 * 60 * 1000;
  let tokens = 0, calls = 0, oldest = now;
  for (const m of rows) {
    if (m.timestamp !== undefined && m.timestamp < oldest) oldest = m.timestamp;
    if (!m.usage) continue;
    calls++;
    tokens += (m.usage.input_tokens || 0) + (m.usage.output_tokens || 0);
  }
  const truncated = rows.length >= cap;
  const covered = truncated ? now - oldest : now - Math.max(startedAt, USAGE_RECORDED_SINCE, now - SESSION_USE_DAYS * D);
  const days = Math.max(1, Math.min(SESSION_USE_DAYS, Math.ceil(covered / D)));
  return { days, tokens, calls, per_day: { tokens: Math.round(tokens / days), calls: Math.round((calls / days) * 10) / 10 }, counted: calls > 0, messages_read: rows.length, truncated };
}
/** A project as the per session read names it: the handoff's rows. */
export type ProjectRef = { id: string; short_id?: string | null; title: string };
export type SessionProjectCounts = { id: string; commits_30d: number; messages_7d: number };
export type SessionEvidence = { use_7d: SessionUse; projects: SessionProjectCounts[] };
/** One session's measured use and its work share by project, from the reads
 *  the session's own query makes: its messages of the week (the same rows the
 *  use is measured on; a user or assistant line that names a project counts
 *  for it) and its commits of the window (a commit names a project by its
 *  short id or two of its title words, or through a task it carries filed
 *  under that project). Counted over every project of the workspace, so a
 *  project the session never filed a task in still shows where its commits
 *  went; the row keeps the projects with a count. */
export async function readSessionEvidence(ctx: Ctx, conversationId: Id<"conversations">, startedAt: number, now: number, projects: ProjectRef[] = []): Promise<SessionEvidence> {
  const since = now - SESSION_USE_DAYS * 24 * 60 * 60 * 1000;
  const rows: any[] = await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conversationId).gte("timestamp", since)).order("desc").take(ANALYSIS_CAPS.use_messages_per_session);
  const use_7d = sessionUseOf(rows, startedAt, now);
  const refs = projects.map((p) => ({ p, words: recordWords(p.title) }));
  const messages = new Map<string, number>();
  const commits = new Map<string, number>();
  for (const m of rows) {
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content) continue;
    const named = namedTextOf(m.content.slice(0, ANALYSIS_CAPS.message_scan_chars));
    for (const { p, words } of refs) if (namesRecord(named, p, words)) bump(messages, p.id);
  }
  const windowSince = now - ANALYSIS_WINDOW_MS;
  const commitRows: any[] = await ctx.db.query("commits").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId)).order("desc").take(ANALYSIS_CAPS.commits_per_session);
  const projectOfTask = new Map<string, string | null>();
  for (const c of commitRows) {
    if ((c.timestamp ?? 0) < windowSince) continue;
    const hit = new Set<string>();
    const named = namedTextOf(c.message);
    for (const { p, words } of refs) if (namesRecord(named, p, words)) hit.add(p.id);
    for (const tid of c.task_ids ?? []) {
      const k = String(tid);
      if (!projectOfTask.has(k)) { const t: any = await ctx.db.get(tid); projectOfTask.set(k, t?.project_id ? String(t.project_id) : null); }
      const pid = projectOfTask.get(k);
      if (pid) hit.add(pid);
    }
    for (const id of hit) bump(commits, id);
  }
  return { use_7d, projects: projects.map((p) => ({ id: p.id, commits_30d: commits.get(p.id) ?? 0, messages_7d: messages.get(p.id) ?? 0 })).filter((p) => p.commits_30d || p.messages_7d) };
}
/** The long running rows with each session's evidence folded in and the
 *  internal ids off them: the ids exist only so the evidence can be read in
 *  its own query, and the analyzer names a seat and a project by short id.
 *  The projects list is the union of what the org slice counted (tasks,
 *  bound) and what the session's own read counted (commits, messages),
 *  biggest share first; a project with nothing counted and no binding leaves
 *  the row. */
export function withSessionEvidence(rows: any[], evidence: Array<SessionEvidence | null | undefined>, projects: ProjectRef[] = []) {
  const refById = new Map(projects.map((p) => [p.id, p]));
  return rows.map(({ id: _id, ...row }, i) => {
    const ev = evidence[i];
    const byId = new Map<string, any>((row.projects ?? []).map((p: any) => [p.id, { ...p }]));
    for (const c of ev?.projects ?? []) {
      const ref = refById.get(c.id);
      const cur = byId.get(c.id) ?? (ref ? { id: c.id, short_id: ref.short_id ?? undefined, title: ref.title, tasks: 0, commits_30d: 0, messages_7d: 0, bound: false } : null);
      if (!cur) continue;
      cur.commits_30d = c.commits_30d;
      cur.messages_7d = c.messages_7d;
      byId.set(c.id, cur);
    }
    const list = Array.from(byId.values())
      .filter((p) => p.tasks || p.commits_30d || p.messages_7d || p.bound)
      .sort((a, b) => (b.tasks + b.commits_30d + b.messages_7d) - (a.tasks + a.commits_30d + a.messages_7d) || Number(b.bound) - Number(a.bound))
      .map(({ id: _pid, ...p }) => p);
    return { ...row, projects: list, ...(ev ? { use_7d: ev.use_7d } : {}) };
  });
}

type OrgScanResult = Awaited<ReturnType<typeof collectOrgSessions>>;
const LONG_RUNNING_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
async function longRunningSessions(ctx: Ctx, scan: OrgScanResult, now: number, work: AnalysisHandoff, userId: Id<"users">, teamId: Id<"teams"> | undefined) {
  // The live recurring routines, by the session each wakes, read once ahead
  // of the ranking so every old session is judged by the same facts.
  const routinesBySession = new Map<string, any[]>();
  for (const status of ["scheduled", "running"] as const) {
    const routineRows: any[] = await ctx.db.query("agent_tasks").withIndex("by_status_run_at", (q: any) => q.eq("status", status)).collect();
    for (const routine of routineRows) {
      if (routine.schedule_type === "once" || !routine.originating_conversation_id) continue;
      const k = String(routine.originating_conversation_id);
      routinesBySession.set(k, [...(routinesBySession.get(k) ?? []), routine]);
    }
  }
  // A session a live routine wakes is a standing job whatever its process is
  // doing between wakes, and the scan reads only rows whose status is active
  // and that nobody dismissed from the inbox: a weekly job is parked six days
  // in seven, and a loop a person has reviewed is often tidied away. Two of
  // Codecast's four routine driven growth sessions were missing for that
  // reason (2026-09-21). Such a session is read from its own row here, with
  // its helpers uncounted (null, not zero), when it belongs to this workspace.
  type Candidate = { session: OrgScanResult["sessions"] extends Map<string, infer V> ? (V extends { session: infer S } ? S & { routine_only?: boolean } : never) : never; raw: any };
  const candidates = new Map<string, Candidate>(scan.sessions);
  for (const key of routinesBySession.keys()) {
    if (candidates.has(key)) continue;
    const raw: any = await ctx.db.get(key as Id<"conversations">);
    if (!raw || raw.parent_conversation_id || raw.is_subagent || raw.inbox_killed_at) continue;
    const ours = teamId ? String(raw.team_id ?? "") === String(teamId) : !raw.team_id && String(raw.user_id) === String(userId);
    if (!ours) continue;
    candidates.set(key, { raw, session: { short_id: raw.short_id ?? null, title: raw.title ?? "", updated_at: raw.updated_at, owner_user_id: raw.owner_user_id ?? raw.user_id ?? null, subagent_count: null, project_path: raw.project_path ?? null, routine_only: true } as any });
  }
  const evidence = ({ session, raw }: { session: any; raw: any }) => ({
    routine: routinesBySession.has(String(raw._id)) ? 1 : 0,
    recent: now - (session.updated_at ?? 0) < LONG_RUNNING_RECENT_MS ? 1 : 0,
    pinned: raw.thread_state ? 1 : 0,
    helpers: (session.subagent_count ?? 0) as number,
    messages: (raw.message_count ?? 0) as number,
  });
  const old = Array.from(candidates.values())
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
    // Its work share by project (org-eval, 2026-09-23): the tasks it touched
    // in each (filed there, or bound to), joined below with the commits and
    // messages the per session read counts (readSessionEvidence), so a row
    // with one task in each of four projects and every commit in one reads
    // as one area, not four. A working directory that names a project is a
    // candidate only: it enters the list when the counts give it something.
    const task = raw.active_task_id ? await ctx.db.get(raw.active_task_id) : null;
    const touched = new Map<string, { tasks: Set<string>; bound: boolean }>();
    const touch = (id: unknown) => { const k = String(id); const t = touched.get(k) ?? { tasks: new Set<string>(), bound: false }; touched.set(k, t); return t; };
    const filed: any[] = await ctx.db.query("tasks").withIndex("by_created_from_conversation", (q: any) => q.eq("created_from_conversation", raw._id)).take(ANALYSIS_CAPS.tasks_filed_per_session);
    for (const t of filed) if (t.project_id) touch(t.project_id).tasks.add(String(t._id));
    if (task?.project_id) { const t = touch(task.project_id); t.tasks.add(String(task._id)); t.bound = true; }
    for (const planId of new Set([raw.active_plan_id, task?.plan_id, ...(raw.plan_ids ?? [])].filter(Boolean).map(String))) { const plan = await ctx.db.get(planId as Id<"plans">); if (plan?.project_id) touch(plan.project_id).bound = true; }
    if (raw.project_path && projectByPath.has(raw.project_path)) touch(projectByPath.get(raw.project_path)!.id);
    const state = raw.thread_state ? threadStateHeadline(String(raw.thread_state)) : "";
    rows.push({
      id: String(raw._id),
      short_id: session.short_id ?? undefined,
      title: session.title,
      owner: (await ctx.db.get(session.owner_user_id ?? raw.user_id))?.name ?? undefined,
      started_at: startedAt,
      age_days: Math.floor((now - startedAt) / (24 * 60 * 60 * 1000)),
      last_active_at: session.updated_at,
      messages: raw.message_count ?? 0,
      // null when the scan did not read it (a routine woke it in), so a reader knows the count is unknown rather than none.
      helpers: session.subagent_count,
      scanned: session.routine_only ? false : undefined,
      routines: routines.map((t: any) => ({ short_id: t.short_id ?? undefined, title: t.title ?? undefined, schedule: t.schedule_type, every_ms: t.interval_ms ?? undefined })),
      state_line: state || undefined,
      state_status: raw.thread_state_status ?? undefined,
      first_message: first ? String(first.content).trim().slice(0, ANALYSIS_CAPS.first_message_chars) : undefined,
      project_path: session.project_path ?? undefined,
      git_root: raw.git_root ?? undefined,
      projects: Array.from(touched).filter(([id]) => projectById.has(id)).map(([id, how]) => ({ id, short_id: projectById.get(id)!.short_id, title: projectById.get(id)!.title, tasks: how.tasks.size, commits_30d: 0, messages_7d: 0, bound: how.bound })),
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
/** The plans the activity reading judges: every open one (active, draft) up
 *  to the cap, and the newest of any status for the done plans a live task
 *  may still work under. The newest 200 alone hid every plan older than the
 *  200th: on Union six landed plans from June and July never reached the
 *  stale list, so no run could close them (2026-09-21). Bodies are stripped:
 *  the reading needs the title, status, project, timestamps and entries. */
export const ACTIVITY_PLAN_STRIP = ["body"];
export async function readActivityPlans(ctx: Ctx, fetchOpts: { userId: Id<"users">; workspace: "team" | "personal"; teamId?: Id<"teams"> }): Promise<any[]> {
  const byId = new Map<string, any>();
  for (const status of ["active", "draft"] as const) {
    const { records } = await scopedFetch(ctx, "plans", { ...fetchOpts, status, limit: ANALYSIS_CAPS.open_plans, stripFields: ACTIVITY_PLAN_STRIP });
    for (const p of records) byId.set(String(p._id), p);
  }
  const { records: newest } = await scopedFetch(ctx, "plans", { ...fetchOpts, limit: ANALYSIS_CAPS.plans, stripFields: ACTIVITY_PLAN_STRIP });
  for (const p of newest) if (!byId.has(String(p._id))) byId.set(String(p._id), p);
  return Array.from(byId.values());
}

export async function computeAnalysisActivity(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number) {
  const fetchOpts = teamId ? { userId, workspace: "team" as const, teamId } : { userId, workspace: "personal" as const };
  const [projects, plans, work, scan, initiatives] = await Promise.all([
    scopedFetch(ctx, "projects", { ...fetchOpts, limit: ANALYSIS_CAPS.projects }).then((r) => r.records),
    readActivityPlans(ctx, fetchOpts),
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
  const commits = await readActivityCommits(ctx, reposFromScan(scan), now - ANALYSIS_WINDOW_MS, { teamId, userId, sessionIds: new Set(scan.sessions.keys()) });
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
export async function computeAnalysisSignals(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number, handoff?: Pick<AnalysisHandoff, "projects">) {
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

  // Chat channels with activity (team only), the ones the caller may read
  // (chatAccess: a private channel needs a member row; a personal workspace
  // has no team chat). messages_30d is a floor at the per channel cap. The
  // same rows feed `said`: the threads where a person decided, asked or
  // named a role or project (saidChatFrom), so chat is read once.
  const channels: Array<{ id: string; name: string; messages_30d: number; last_at?: number }> = [];
  const chatRead: Array<{ channel: any; msgs: any[] }> = [];
  if (teamId) {
    const rows: any[] = await ctx.db.query("chat_channels").withIndex("by_team_name", (q: any) => q.eq("team_id", teamId)).take(ANALYSIS_CAPS.channels);
    for (const ch of rows) {
      if (!ch.name || ch.archived_at) continue;
      if (!(await canAccessChannel(ctx as any, userId, ch))) continue;
      const msgs: any[] = (await ctx.db.query("chat_messages").withIndex("by_channel_created", (q: any) => q.eq("channel_id", ch._id).gte("created_at", cutoff)).order("desc").take(ANALYSIS_CAPS.messages_per_channel)).filter((m: any) => (m.created_at ?? 0) >= cutoff);
      channels.push({ id: String(ch._id), name: ch.name, messages_30d: msgs.length, last_at: msgs[0]?.created_at });
      if (ch.kind !== "dm") chatRead.push({ channel: ch, msgs });
    }
  }
  const said = teamId ? await readSaid(ctx, userId, teamId, now, chatRead, handoff?.projects ?? []) : { calls: [], chat: [], truncated: false };

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
    said,
    decisions_open_by_category: objOf(decisionsByCategory),
  };
}

// ── What people said: calls and chat (org-eval, 2026-09-23) ────────────────
// The reviewer never read a word a person wrote: it judged the company from
// records and commits. `said` hands it the team's calls of the window (the
// generated summary and action items, never the transcript) and the chat
// threads where a person decided something, asked for something, or named a
// role or a project, each as its root line, who wrote it, the channel, and
// up to three replies that carry a decision or an ask. One byte budget over
// both, calls first, newest first, with `truncated` when threads were left
// out. Access is the caller's: a call the caller may not read (a private
// channel's huddle, a recording its creator never shared) is not here, and
// the chat rows came through the channel access check above.
const DECIDED_RE = /\b(decid(?:e|ed|es|ing|sion|sions)|agreed?|approv(?:e|ed|es|al)|go(?:ing)? with|let'?s (?:go|do|use|ship|keep|drop|make|move|start|stop|try|not)|we(?:'ll| will| should| are going to| won'?t| decided| agreed)|from now on|instead of|settled|ship it|the plan is|final(?:ly|ized|ised)?|no longer|not going to)\b/i;
const ASKED_RE = /\?|\b(?:can|could|would|will) (?:you|someone|anyone|we)\b|\bplease\b|\bneed(?:s|ed)? (?:a|an|to|you|someone|help)\b|\bshould we\b|\bwho (?:owns|has|can)\b|\b(?:thoughts|wdyt|eta)\b/i;
export type SaidWhy = "decided" | "asked" | "named";
export type SaidLine = { at: number; by: string; line: string };
export type SaidThread = SaidLine & { channel: string; why: SaidWhy[]; replies: SaidLine[] };
export type SaidCall = { title: string | null; started_at: number; ended_at: number | null; participants: string[]; summary: string | null; action_items: string[] };
export type Said = { calls: SaidCall[]; chat: SaidThread[]; truncated: boolean };
/** Why a line matters: what it decides, asks, or names (a role by handle or
 *  mention, a project by short id or two title words). Empty when nothing. */
export function saidWhyOf(m: { content?: string; mentions?: any[] }, roles: string[], projects: Array<{ ref: ProjectRef; words: string[] }>): SaidWhy[] {
  const text = m.content ?? "";
  const why: SaidWhy[] = [];
  if (DECIDED_RE.test(text)) why.push("decided");
  if (ASKED_RE.test(text)) why.push("asked");
  const lower = text.toLowerCase();
  const named = namedTextOf(text);
  const namesRole = (m.mentions ?? []).some((x: any) => x && typeof x === "object" && x.kind === "role") || roles.some((h) => lower.includes(`@${h.toLowerCase()}`));
  if (namesRole || projects.some(({ ref, words }) => namesRecord(named, ref, words))) why.push("named");
  return why;
}
/** The threads worth the reviewer's eye from the rows the channel loop read.
 *  A thread is its root (in the read, or fetched when only its replies are)
 *  and the person written replies that decide or ask, newest three in time
 *  order; it qualifies when the root or such a reply carries a signal. An
 *  agent's line is context, never a signal. */
export async function saidChatFrom(ctx: Ctx, read: Array<{ channel: any; msgs: any[] }>, roles: string[], projects: ProjectRef[]): Promise<SaidThread[]> {
  const refs = projects.map((ref) => ({ ref, words: recordWords(ref.title) }));
  const users = new Map<string, any>();
  const userOf = async (id: any) => { const k = String(id); if (!users.has(k)) users.set(k, await ctx.db.get(id)); return users.get(k); };
  const nameOf = async (m: any) => { const u = await userOf(m.user_id); return (u?.name ?? u?.email ?? "?") as string; };
  const isPerson = async (m: any) => m.author_kind !== "agent" && !(await userOf(m.user_id))?.is_bot;
  const usable = (m: any) => m && !m.deleted_at && typeof m.content === "string" && m.content.trim();
  const out: SaidThread[] = [];
  for (const { channel, msgs } of read) {
    const roots = new Map<string, any>();
    const replies = new Map<string, any[]>();
    for (const m of msgs) {
      if (!usable(m)) continue;
      if (m.thread_root_id) replies.set(String(m.thread_root_id), [...(replies.get(String(m.thread_root_id)) ?? []), m]);
      else roots.set(String(m._id), m);
    }
    for (const rootId of replies.keys()) if (!roots.has(rootId)) { const root = await ctx.db.get(rootId as Id<"chat_messages">); if (usable(root)) roots.set(rootId, root); }
    for (const [rootId, root] of roots) {
      const rootWhy = (await isPerson(root)) ? saidWhyOf(root, roles, refs) : [];
      const picked: SaidLine[] = [];
      const why = new Set<SaidWhy>(rootWhy);
      const inThread = (replies.get(rootId) ?? []).sort((a, b) => b.created_at - a.created_at);
      for (const r of inThread) {
        if (picked.length >= ANALYSIS_CAPS.said_replies_per_thread) break;
        if (!(await isPerson(r))) continue;
        const w = saidWhyOf(r, roles, refs).filter((x) => x !== "named");
        if (!w.length) continue;
        for (const x of w) why.add(x);
        picked.push({ at: r.created_at, by: await nameOf(r), line: r.content.trim().slice(0, ANALYSIS_CAPS.said_reply_chars) });
      }
      if (!why.size) continue;
      out.push({ channel: `#${channel.name}`, at: root.created_at, by: await nameOf(root), line: root.content.trim().slice(0, ANALYSIS_CAPS.said_line_chars), why: Array.from(why), replies: picked.reverse() });
    }
  }
  const newest = (t: SaidThread) => Math.max(t.at, ...t.replies.map((r) => r.at));
  return out.sort((a, b) => newest(b) - newest(a));
}
export async function readSaid(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams">, now: number, chatRead: Array<{ channel: any; msgs: any[] }>, projects: ProjectRef[]): Promise<Said> {
  const cutoff = now - ANALYSIS_WINDOW_MS;
  const calls: SaidCall[] = [];
  const callRows: any[] = await ctx.db.query("transcripts").withIndex("by_team_started", (q: any) => q.eq("team_id", teamId).gte("started_at", cutoff)).order("desc").take(ANALYSIS_CAPS.calls);
  for (const t of callRows) {
    if ((t.started_at ?? 0) < cutoff || t.status !== "ended") continue;
    if (isRecRoomKey(t.room_key) && !t.rec_shared) continue;
    // A call nobody spoke in and nothing was written about (a huddle that
    // ended before words) is not something said: Union had 30 such rows.
    if (!t.summary && !(t.action_items ?? []).length && !(t.participants ?? []).length) continue;
    if (!(await canReadCall(ctx as any, userId, t))) continue;
    calls.push({ title: t.title ?? null, started_at: t.started_at, ended_at: t.ended_at ?? null, participants: (t.participants ?? []).map((p: any) => p.name), summary: t.summary ? String(t.summary).slice(0, ANALYSIS_CAPS.call_summary_chars) : null, action_items: (t.action_items ?? []).slice(0, ANALYSIS_CAPS.call_action_items).map((a: any) => String(a).slice(0, 200)) });
  }
  const roleRows: any[] = await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).collect();
  const threads = await saidChatFrom(ctx, chatRead, roleRows.map((r) => r.handle).filter(Boolean), projects);
  // One budget over both: the calls are few and dated, the threads fill the rest newest first.
  let bytes = JSON.stringify(calls).length;
  const chat: SaidThread[] = [];
  let truncated = false;
  for (const t of threads) {
    const size = JSON.stringify(t).length;
    if (bytes + size > ANALYSIS_CAPS.said_bytes) { truncated = true; break; }
    bytes += size;
    chat.push(t);
  }
  return { calls, chat, truncated };
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
    // What people said (calls and chat), read for the reviewer's eye.
    said: signals.said,
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
    computeAnalysisSignals(ctx, userId, teamId, now, work.handoff),
    workspaceLabelOf(ctx, userId, teamId),
    computeAnalysisActivity(ctx, userId, teamId, now),
  ]);
  const evidence = await Promise.all(org.sessions.long_running.rows.map((r: any) => readSessionEvidence(ctx, r.id, r.started_at, now, work.handoff.projects)));
  org.sessions.long_running.rows = withSessionEvidence(org.sessions.long_running.rows, evidence, work.handoff.projects);
  return mergeAnalysisInputs(userId, teamId, label, work, org, signals, now, activity.activity, activity.coverage);
}

// One slice per call, so each read stays inside the execution limit on a
// large workspace; the action below runs the three and merges them.
export const analysisPart = query({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    part: v.union(v.literal("work"), v.literal("org"), v.literal("signals"), v.literal("activity"), v.literal("use")),
    work: v.optional(v.any()),
    now: v.optional(v.number()),
    session: v.optional(v.id("conversations")),
    started_at: v.optional(v.number()),
    projects: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<any> => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    const now = args.now ?? Date.now();
    if (args.part === "use") {
      // One session's measured use, read in its own query so twelve sessions'
      // messages never share one execution budget. Only a session of this
      // workspace answers: the id came from the org slice, and a caller who
      // names another workspace's session learns nothing.
      if (!args.session) return null;
      const conv: any = await ctx.db.get(args.session);
      const ours = !!conv && (args.team_id ? String(conv.team_id ?? "") === String(args.team_id) : !conv.team_id && String(conv.user_id) === String(userId));
      return ours ? readSessionEvidence(ctx, args.session, args.started_at ?? conv.started_at ?? conv._creationTime, now, (args.projects as ProjectRef[] | undefined) ?? []) : null;
    }
    if (args.part === "work") return computeAnalysisWork(ctx, userId, args.team_id);
    if (args.part === "signals") return { ...(await computeAnalysisSignals(ctx, userId, args.team_id, now, args.work as AnalysisHandoff | undefined)), label: await workspaceLabelOf(ctx, userId, args.team_id), user_id: userId };
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
    // The work slice first: the org and signals slices read its handoff (the
    // projects, for the chat threads that name one and a session's work share).
    const [work, activity] = await Promise.all([
      ctx.runQuery(part, { ...args, part: "work", now }),
      ctx.runQuery(part, { ...args, part: "activity", now }),
    ]);
    if (!work) return null;
    const [org, signals] = await Promise.all([
      ctx.runQuery(part, { ...args, part: "org", now, work: work.handoff }),
      ctx.runQuery(part, { ...args, part: "signals", now, work: work.handoff }),
    ]);
    if (!org || !signals) return null;
    const evidence = await Promise.all(org.sessions.long_running.rows.map((r: any) => ctx.runQuery(part, { ...args, part: "use", now, session: r.id, started_at: r.started_at, projects: work.handoff.projects })));
    org.sessions.long_running.rows = withSessionEvidence(org.sessions.long_running.rows, evidence, work.handoff.projects);
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
    await withOrgChange(ctx, userId, { kind: "projects", door: "proposal", gesture: "accept_change" }, async () => {
      if (c.op === "create") {
        // Idempotent by title: a re-run after a crash must not mint a twin.
        let existing: any = null;
        try { existing = await findProject(c.title); } catch { existing = null; }
        if (existing && existing.title.toLowerCase() === c.title.toLowerCase()) { done.push(`project "${c.title}" already exists`); return; }
        const id = await ctx.db.insert("projects", {
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
        const project = await ctx.db.get(id);
        await noteOrgChange(ctx, userId, whereOfRecord(project), { kind: "projects", subject: recordSubject("project", project), before: { status: null }, after: { status: "active", projects: [{ op: "create", project_id: String(id), title: project.title }] } });
        done.push(`created project "${c.title}"`);
      } else {
        const from = await findProject(c.from);
        const into = await findProject(c.into);
        if (!from || !into) throw new Error(`merge: project "${!from ? c.from : c.into}" not found in this workspace`);
        if (String(from._id) === String(into._id)) return;
        let moved = 0;
        const rows_moved: Array<{ table: "tasks" | "plans" | "docs"; id: string }> = [];
        for (const table of ["tasks", "plans", "docs"] as const) {
          const rows: any[] = await ctx.db.query(table).withIndex("by_project_id", (q: any) => q.eq("project_id", from._id)).collect();
          for (const row of rows) { if (row.workspace !== key) continue; await ctx.db.patch(row._id, { project_id: into._id, updated_at: now }); rows_moved.push({ table, id: String(row._id) }); moved++; }
        }
        await ctx.db.patch(from._id, { status: "done", description: `${from.description ?? ""}\n\nMerged into ${into.title} by cast org apply.`.trim(), updated_at: now });
        await noteOrgChange(ctx, userId, whereOfRecord(from), { kind: "projects", subject: recordSubject("project", from), before: { status: from.status }, after: { status: "done", projects: [{ op: "merge", from_id: String(from._id), into_id: String(into._id) }] }, effects: { rows_moved } });
        done.push(`merged "${from.title}" into "${into.title}" (${moved} rows moved)`);
      }
    });
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
  return { status: "applied", note: `@${role.handle}: ${autonomyChangeWords(!!r.on)}`, role: roleRef(role) };
}

// Hiring from a template (docs/architecture/org-hire.md). Authority is the
// role's, written through the same human only writer as trust; a hire writes
// the instance row awaiting its host step and makes the role the project's
// lead when it has none (H3); an accepted upgrade waits on the row for the host.
export async function applyAuthority(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgAuthorityChange, opts: ApplyOpts): Promise<ApplyResult> {
  const role = await liveRole(ctx, boundary, p.handle);
  const r = await performSetAuthority(ctx, userId, { role_id: String(role._id), authority: p.authority, human_decision: opts.human_decision });
  return { status: "applied", note: `@${role.handle} may ${authorityWords(r.authority)}`, role: roleRef(role) };
}
export async function applyHire(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgHireChange, _opts: ApplyOpts): Promise<ApplyResult> {
  const role = await liveRole(ctx, boundary, p.handle);
  const ref = await resolveScopeRef(ctx, boundary, `project:${p.project}`);
  const project = ref.kind === "project" ? await ctx.db.get(ref.id) : null;
  if (!project) throw new Error(`No project "${p.project}" in this workspace`);
  if (!(role.scope?.project_ids ?? []).some((id: any) => String(id) === String(project._id))) throw new Error(`@${role.handle} does not look after ${project.title}; the role change of this hire names the project`);
  const row = await performUpsertInstance(ctx, userId, {
    instance_key: `pending:${String(project._id)}:${p.instance}`, instance: p.instance, template_id: p.template, version: p.version, digest: p.digest,
    project_id: project._id, role_id: role._id, phase: "awaiting_host", update_policy: p.update_policy ?? "manual", config: p.config ?? {},
  });
  // The hire is recorded on the role (org-staffing.md S21); its way back is the host step, so the row carries the instance and no snapshot of it.
  await noteOrgChange(ctx, userId, whereOfRole(role), { kind: "hire", subject: roleSubject(role), before: { instance: null }, after: { instance: { instance: p.instance, template_id: p.template, version: p.version, project_id: String(project._id) } }, labels: await labelsOf(ctx, [String(role._id), String(project._id)]) });
  const lead = project.owner_role_id ? null : await performSetProjectLead(ctx, userId, { project_id: project._id, role_id: String(role._id) });
  return { status: "applied", note: `hired @${role.handle} from ${p.template}@${p.version} as ${p.instance}${lead ? `; it leads ${project.title}` : ""}; run cast org template bind ${p.instance} in the checkout (row ${row._id})`, role: roleRef(role) };
}
export async function applyUpgrade(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgUpgradeChange): Promise<ApplyResult> {
  const row = await performAcceptUpgrade(ctx, userId, { access: boundary.team_id ? `team:${boundary.team_id}` : `user:${boundary.scope_user_id}`, instance: p.instance, template_id: p.template, to: p.to, digest: p.digest });
  // Recorded on the instance's role, or its project when the row names none; the acceptance is withdrawn by undo until the host step runs it.
  const role = row.role_id ? await ctx.db.get(row.role_id) : null;
  const project = role ? null : await ctx.db.get(row.project_id);
  await noteOrgChange(ctx, userId, role ? whereOfRole(role) : whereOfRecord(project), { kind: "upgrade", subject: role ? roleSubject(role) : recordSubject("project", project), before: { upgrade: null }, after: { upgrade: { instance: p.instance, template_id: p.template, to: p.to } } });
  return { status: "applied", note: `instance ${p.instance} moves to ${p.template}@${p.to} on its next host step (cast org template bind ${p.instance} --to ${p.to}; row ${row._id})` };
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
  await noteOrgChange(ctx, userId, whereOfRole(role), { kind: "routine", subject: roleSubject(role), before: { routine: null }, after: { routine: { agent_task_id: String(created.id), title: p.title.trim(), every: p.every } }, effects: { routines_started: [{ agent_task_id: String(created.id), title: p.title.trim() }] } });
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
  await noteOrgChange(ctx, userId, whereOfRecord(project), { kind: "project_meta", subject: recordSubject("project", project), ...movedFields(Object.fromEntries(Object.keys(patch).map((k) => [k, project[k] ?? null])), patch), labels: await labelsOf(ctx, [project.owner_role_id, patch.owner_role_id]) });
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
  await noteOrgChange(ctx, _userId, whereOfRecord(plan), { kind: "file", subject: recordSubject("plan", plan), before: { project_id: plan.project_id ?? null }, after: { project_id: String(project._id) }, labels: await labelsOf(ctx, [plan.project_id, project._id]) });
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
export async function setTaskStatus(ctx: Ctx, boundary: Boundary, task: any, status: string, now: number): Promise<void> {
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
  const tasks_closed: Array<{ task_id: string; short_id: string; before_status: string }> = [];
  if (closing) {
    const open: any[] = (await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).collect()).filter((t: any) => OPEN_TASK(t) && isActiveTask(t));
    open.sort((a, b) => String(a.short_id).localeCompare(String(b.short_id), undefined, { numeric: true }));
    for (const t of open) { await setTaskStatus(ctx, boundary, t, "dropped", now); tasks_closed.push({ task_id: String(t._id), short_id: t.short_id, before_status: t.status }); }
    if (open.length) cascade = `; dropped its ${open.length} open task${open.length === 1 ? "" : "s"}: ${open.map((t) => t.short_id).join(", ")}`;
  }
  await noteOrgChange(ctx, _userId, whereOfRecord(plan), { kind: "plan_status", subject: recordSubject("plan", plan), ...movedFields({ status: plan.status }, { status: p.status }), effects: { tasks_closed } });
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
  await noteOrgChange(ctx, _userId, whereOfRecord(project), { kind: "project_status", subject: recordSubject("project", project), before: { status: project.status }, after: { status: p.status } });
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
  await noteOrgChange(ctx, userId, whereOfRecord(task), { kind: "task_status", subject: recordSubject("task", task), before: { status: task.status }, after: { status: p.status } });
  return { status: "applied", note: `${task.short_id} "${task.title}": ${task.status} → ${p.status}` };
}

// ── The company's goals (initiatives-projects-role-page.md "I1, revised") ──
// Three changes, each a thin call into the initiatives module's own cores, so
// a goal a review proposes is made the way a goal set on the page is made and
// logged the same way (S21). Refs resolve inside the boundary: a project by
// short id, id or title through the scope resolver; an initiative by in-N,
// id or its title; an owner the way a role's parent resolves ("@handle",
// "me", a member's name). The core reports the log row and grows the owner
// role's scope; nothing here writes an initiative itself.

async function initiativeByRef(ctx: Ctx, userId: Id<"users">, boundary: Boundary, ref: string): Promise<any> {
  const key = workspaceKey(boundary.team_id ? { type: "team", teamId: boundary.team_id } : { type: "personal", userId });
  const trimmed = ref.trim();
  const direct = /^in-\d+$/i.test(trimmed) || ctx.db.normalizeId("initiatives", trimmed) ? await findInitiative(ctx, userId, trimmed) : null;
  if (direct && direct.workspace === key) return direct;
  const rows: any[] = await ctx.db.query("initiatives").withIndex("by_workspace", (q: any) => q.eq("workspace", key)).collect();
  const lc = trimmed.toLowerCase();
  const hits = rows.filter((r) => r.status !== "cancelled" && r.title.trim().toLowerCase() === lc);
  if (hits.length > 1) throw new Error(`"${trimmed}" names ${hits.length} initiatives in this workspace; use the short id (${hits.map((r) => r.short_id).join(", ")})`);
  if (!hits.length) throw new Error(`No initiative "${trimmed}" in this workspace`);
  return hits[0];
}
const initiativeWorkspace = (boundary: Boundary): { workspace: "personal" | "team"; team_id?: Id<"teams"> } => boundary.team_id ? { workspace: "team", team_id: boundary.team_id } : { workspace: "personal" };
async function projectIdsOf(ctx: Ctx, boundary: Boundary, refs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs) { const r = await resolveScopeRef(ctx, boundary, `project:${ref}`); if (r.kind === "project") out.push(String(r.id)); }
  return out;
}

export async function applyInitiative(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgInitiativeChange, _opts: ApplyOpts): Promise<ApplyResult> {
  // Idempotent by title: a re-run after a crash must not set the goal twice.
  const existing = await initiativeByRef(ctx, userId, boundary, p.title).catch(() => null);
  if (existing) return { status: "applied", note: `the goal "${existing.title}" already exists (${existing.short_id})` };
  const project_ids = await projectIdsOf(ctx, boundary, p.projects);
  const owner = p.owner?.trim() ? await resolveReportsTo(ctx, userId, boundary, p.owner) : undefined;
  const r = await performCreateInitiative(ctx, userId, initiativeWorkspace(boundary), { title: p.title, description: p.description, project_ids, ...(owner ? { owner: { ...owner, ...(owner.kind === "role" ? { role_id: String(owner.role_id) } : { user_id: String(owner.user_id) }) } as any } : {}), ...(p.target_date ? { target_date: p.target_date } : {}) });
  return { status: "applied", note: `set the goal "${r.row.title}" (${r.short_id}) with ${project_ids.length} project${project_ids.length === 1 ? "" : "s"}${owner ? `, owned by ${p.owner}` : ""}${coverNote(r.scope)}` };
}

export async function applyInitiativeProjects(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgInitiativeProjectsChange, _opts: ApplyOpts): Promise<ApplyResult> {
  const initiative = await initiativeByRef(ctx, userId, boundary, p.initiative);
  const project_ids = await projectIdsOf(ctx, boundary, p.projects);
  const r = await performAddProjects(ctx, userId, initiative, project_ids);
  if (!r.added) return { status: "applied", note: `${initiative.short_id} "${initiative.title}" already carries ${andListOf(p.projects)}` };
  return { status: "applied", note: `added ${andListOf(p.projects)} to the goal "${initiative.title}" (${initiative.short_id})${coverNote(r.scope)}` };
}

export async function applyInitiativeOwner(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgInitiativeOwnerChange, _opts: ApplyOpts): Promise<ApplyResult> {
  const initiative = await initiativeByRef(ctx, userId, boundary, p.initiative);
  const owner = await resolveReportsTo(ctx, userId, boundary, p.owner);
  const same = initiative.owner && initiative.owner.kind === owner.kind && String(owner.kind === "role" ? initiative.owner.role_id : initiative.owner.user_id) === String(owner.kind === "role" ? owner.role_id : owner.user_id);
  if (same) return { status: "applied", note: `${p.owner} already owns ${initiative.short_id} "${initiative.title}"` };
  const r = await performUpdateInitiative(ctx, userId, initiative, { owner: { ...owner, ...(owner.kind === "role" ? { role_id: String(owner.role_id) } : { user_id: String(owner.user_id) }) } as any });
  return { status: "applied", note: `${p.owner} now owns the goal "${initiative.title}" (${initiative.short_id})${coverNote(r.scope)}` };
}
/** What the owner role's area gained, and the sessions it took over with it, as the core reported them. */
const coverNote = (scope: { added: string[]; took_over?: string } | null | undefined) => `${scope?.added.length ? `; the owner now looks after ${scope.added.length} more project${scope.added.length === 1 ? "" : "s"}` : ""}${scope?.took_over ? `; ${scope.took_over}` : ""}`;
const andListOf = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** One change of any kind, applied. Throws on a refusal; the caller records it. */
export async function applyOrgChange(ctx: Ctx, userId: Id<"users">, boundary: Boundary, change: OrgChange, opts: ApplyOpts, note?: string): Promise<ApplyResult> {
  if (change.kind === "projects") return applyProjects(ctx, userId, boundary, change.changes, note);
  return withOrgChange(ctx, userId, { kind: change.kind, door: "proposal", gesture: "accept_change" }, () => applyOrgChangeCore(ctx, userId, boundary, change, opts, note));
}

async function applyOrgChangeCore(ctx: Ctx, userId: Id<"users">, boundary: Boundary, change: OrgChange, opts: ApplyOpts, note?: string): Promise<ApplyResult> {
  switch (change.kind) {
    case "role": return applyRole(ctx, userId, boundary, change, note, opts);
    case "projects": return applyProjects(ctx, userId, boundary, change.changes, note);
    case "move": return applyMove(ctx, userId, boundary, change, opts.human_decision);
    case "retire": return applyRetire(ctx, userId, boundary, change.handle);
    case "scope": return applyScope(ctx, userId, boundary, change, opts);
    case "budget": return applyBudget(ctx, userId, boundary, change, opts);
    case "trust": return applyTrust(ctx, userId, boundary, change, opts);
    case "authority": return applyAuthority(ctx, userId, boundary, change, opts);
    case "hire": return applyHire(ctx, userId, boundary, change, opts);
    case "upgrade": return applyUpgrade(ctx, userId, boundary, change);
    case "routine": return applyRoutine(ctx, userId, boundary, change, opts);
    case "project_meta": return applyProjectMeta(ctx, userId, boundary, change, opts);
    case "adopt": return applyAdopt(ctx, userId, boundary, change, opts);
    case "file": return applyFile(ctx, userId, boundary, change, opts);
    case "plan_status": return applyPlanStatus(ctx, userId, boundary, change, opts);
    case "task_status": return applyTaskStatus(ctx, userId, boundary, change, opts);
    case "project_status": return applyProjectStatus(ctx, userId, boundary, change, opts);
    case "initiative": return applyInitiative(ctx, userId, boundary, change, opts);
    case "initiative_projects": return applyInitiativeProjects(ctx, userId, boundary, change, opts);
    case "initiative_owner": return applyInitiativeOwner(ctx, userId, boundary, change, opts);
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
