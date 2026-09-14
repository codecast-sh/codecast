import { mutation, query } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { scopedFetch } from "./data";
import { workspaceKey } from "./lib/access";
import { userCanAdminRole } from "./lib/orgAccess";
import { isWholeWorkspace, scopeIds } from "./lib/orgScope";
import { collectOrgSessions, computeScopeFeed, requireWorkspaceCaller, resolveScope } from "./org";
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
import { capsFor, countersFor, trustOf, utcDay } from "./orgEvents";
import { findDecision } from "./sessionDecisions";
import { extractRepoFromRemoteUrl } from "@codecast/shared/contracts";
import {
  applyProposalChanges,
  extractOrgProposal,
  orgProposalVerdict,
  type OrgProjectChange,
  type OrgProposal,
  type OrgRoleProposal,
} from "@codecast/shared/contracts/orgProposal";

// Org init and update (docs/architecture/org-init.md O1, O2): the evidence an
// analyzer reads before proposing a chart, and the apply path that turns an
// answered proposal into roles, scopes, charters and standing sessions.
//
// The analyzer never writes: it proposes as a decision stack, and nothing is
// created until a person answers. `applyDecision` is the one writer; it is
// idempotent per decision (applied_at); a handle already live is a refusal, never an adoption.

type Ctx = { db: any };

export const ANALYSIS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const IDLE_ROLE_DAYS = 14;
export const WAKE_HISTORY_DAYS = 7;
export const ANALYSIS_CAPS = {
  projects: 100,
  plans: 200,
  tasks: 2000,
  docs: 1000,
  insights: 300,
  channels: 50,
  messages_per_channel: 200,
  decisions: 300,
  labels: 30,
  titles_per_path: 5,
  git_roots: 40,
  members: 50,
} as const;

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const topOf = (m: Map<string, number>, n: number) =>
  Array.from(m.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([name, count]) => ({ name, count }));
const objOf = (m: Map<string, number>): Record<string, number> => Object.fromEntries(m);

export async function computeAnalysisInputs(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number) {
  const cutoff = now - ANALYSIS_WINDOW_MS;
  const fetchOpts = teamId ? { userId, workspace: "team" as const, teamId } : { userId, workspace: "personal" as const };
  const workspaceLabel = teamId ? (await ctx.db.get(teamId))?.name ?? "" : (await ctx.db.get(userId))?.name ?? "";

  // ── Work items, through the workspace chokepoint ────────────────────────
  const [projects, plans, tasks, docs] = await Promise.all([
    scopedFetch(ctx, "projects", { ...fetchOpts, limit: ANALYSIS_CAPS.projects }).then((r) => r.records),
    scopedFetch(ctx, "plans", { ...fetchOpts, limit: ANALYSIS_CAPS.plans }).then((r) => r.records),
    scopedFetch(ctx, "tasks", { ...fetchOpts, limit: ANALYSIS_CAPS.tasks }).then((r) => r.records),
    scopedFetch(ctx, "docs", { ...fetchOpts, limit: ANALYSIS_CAPS.docs, stripFields: ["content", "entries", "content_embedding"] }).then((r) => r.records),
  ]);

  const tasksByProject = new Map<string, any[]>();
  const tasksByPlan = new Map<string, any[]>();
  let unfiledOpen = 0;
  for (const t of tasks) {
    if (t.project_id) tasksByProject.set(String(t.project_id), [...(tasksByProject.get(String(t.project_id)) ?? []), t]);
    if (t.plan_id) tasksByPlan.set(String(t.plan_id), [...(tasksByPlan.get(String(t.plan_id)) ?? []), t]);
    if (!t.project_id && !t.plan_id && t.status !== "done" && t.status !== "dropped") unfiledOpen++;
  }
  const statusCounts = (rows: any[]) => {
    const m = new Map<string, number>();
    for (const t of rows) bump(m, t.status ?? "open");
    return objOf(m);
  };
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

  // ── Sessions: the org scan (30 days, access filtered, row capped) ───────
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
  // scanned sessions.
  const labels = new Map<string, number>();
  const buckets: any[] = await ctx.db.query("inbox_buckets").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  const bucketName = new Map(buckets.filter((b) => !b.archived_at).map((b) => [String(b._id), b.name]));
  const assignments: any[] = await ctx.db.query("bucket_assignments").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  for (const a of assignments) {
    const name = a.bucket_id ? bucketName.get(String(a.bucket_id)) : undefined;
    if (name && byId.has(String(a.conversation_id))) bump(labels, name);
  }

  // ── Insights: themes and outcomes over the window ───────────────────────
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

  // ── Chat channels with activity (team only) ─────────────────────────────
  const channels: Array<{ id: string; name: string; messages_30d: number; last_at?: number }> = [];
  if (teamId) {
    const rows: any[] = await ctx.db.query("chat_channels").withIndex("by_team_name", (q: any) => q.eq("team_id", teamId)).take(ANALYSIS_CAPS.channels);
    for (const ch of rows) {
      if (!ch.name || ch.archived_at) continue;
      const msgs: any[] = await ctx.db.query("chat_messages").withIndex("by_channel_created", (q: any) => q.eq("channel_id", ch._id).gte("created_at", cutoff)).order("desc").take(ANALYSIS_CAPS.messages_per_channel);
      channels.push({ id: String(ch._id), name: ch.name, messages_30d: msgs.length, last_at: msgs[0]?.created_at });
    }
  }

  // ── Roles, anchors, and each role's health (update mode reads these) ────
  const roleRows = scan.roles;
  const planProjectOf = await planProjectsOf(ctx, roleRows.map((r: any) => r.scope));
  const coveredProjects = new Set<string>();
  let wholeWorkspaceRoles = 0;
  const roles = [];
  for (const role of roleRows) {
    const ids = scopeIds(role.scope);
    if (isWholeWorkspace(ids)) wholeWorkspaceRoles++;
    for (const id of ids.project_ids) coveredProjects.add(id);
    for (const id of ids.plan_ids) { const pr = planProjectOf.get(id); if (pr) coveredProjects.add(pr); }
    const scopeNames = {
      projects: ids.project_ids.map((id) => projects.find((p) => String(p._id) === id)?.title ?? id),
      plans: ids.plan_ids.map((id) => plans.find((p) => String(p._id) === id)?.short_id ?? id),
    };
    // Last activity in the scope: the newest feed row, one read per role.
    let lastScopeEventAt: number | null = null;
    const resolved = await resolveScope(ctx, userId, { role_id: String(role._id) });
    if (resolved) {
      const feed = await computeScopeFeed(ctx, resolved, { limit: 1, now });
      lastScopeEventAt = feed.rows[0]?.updated_at ?? null;
    }
    const wakes: any[] = await ctx.db.query("role_wakes").withIndex("by_role_created", (q: any) => q.eq("role_id", role._id).gte("created_at", now - WAKE_HISTORY_DAYS * 86_400_000)).collect();
    const wakesByDay = new Map<string, number>();
    let held = 0;
    for (const w of wakes) { if (w.status === "held") held++; else bump(wakesByDay, utcDay(w.created_at)); }
    const caps = capsFor(role);
    const daysAtCap = Array.from(wakesByDay.values()).filter((n) => n >= caps.wakes_per_day).length;
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
      last_scope_event_at: lastScopeEventAt,
      idle_days: lastScopeEventAt ? Math.floor((now - lastScopeEventAt) / 86_400_000) : null,
      idle: !lastScopeEventAt || now - lastScopeEventAt > IDLE_ROLE_DAYS * 86_400_000,
      wakes_7d: { total: wakes.length - held, held, days_at_cap: daysAtCap, by_day: objOf(wakesByDay) },
      overlaps: overlapsAmong(role, roleRows, planProjectOf).map((o) => ({ handle: o.handle, projects: o.project_ids.length, plans: o.plan_ids.length })),
    });
  }
  const anchors = scan.anchors.map((a: any) => ({ id: String(a._id), name: a.name, status: a.status, role_id: a.org_role_id ? String(a.org_role_id) : undefined }));
  const projectsWithoutRole = wholeWorkspaceRoles > 0 ? [] : projectRows.filter((p) => !coveredProjects.has(p.id)).map((p) => ({ id: p.id, short_id: p.short_id, title: p.title, open_tasks: p.tasks.open }));
  let sessionsUnfiled = 0;
  for (const [key, list] of scan.byParent) if (key.startsWith("user:")) sessionsUnfiled += list.length;

  // ── Open decisions by category ──────────────────────────────────────────
  const memberSet = new Set(scan.memberIds.map(String));
  const pending: any[] = await ctx.db.query("session_decisions").withIndex("by_status_created", (q: any) => q.eq("status", "pending").gte("created_at", cutoff)).order("desc").take(ANALYSIS_CAPS.decisions);
  const decisionsByCategory = new Map<string, number>();
  for (const d of pending) {
    const people: string[] = (d.asked_user_ids ?? [d.user_id]).map(String);
    if (!people.some((p) => memberSet.has(p))) continue;
    bump(decisionsByCategory, d.category ?? "uncategorized");
  }

  return {
    workspace: teamId ? { kind: "team" as const, id: String(teamId), name: workspaceLabel } : { kind: "user" as const, id: String(userId), name: workspaceLabel },
    window_days: ANALYSIS_WINDOW_MS / 86_400_000,
    caps: ANALYSIS_CAPS,
    projects: projectRows,
    plans: planRows,
    tasks: { total: tasks.length, by_status: statusCounts(tasks), unfiled_open: unfiledOpen, truncated: tasks.length >= ANALYSIS_CAPS.tasks },
    docs_by_type: objOf(docsByType),
    // A list at its cap is a floor, not a count; the analyzer reports it as
    // "could not verify" rather than as the total.
    truncated: {
      projects: projects.length >= ANALYSIS_CAPS.projects,
      plans: plans.length >= ANALYSIS_CAPS.plans,
      tasks: tasks.length >= ANALYSIS_CAPS.tasks,
      docs: docs.length >= ANALYSIS_CAPS.docs,
      insights: insightRows.length >= ANALYSIS_CAPS.insights,
    },
    members,
    labels: topOf(labels, ANALYSIS_CAPS.labels),
    git_roots: Array.from(gitRoots.values()).sort((a, b) => b.sessions - a.sessions).slice(0, ANALYSIS_CAPS.git_roots),
    sessions: { total: scan.sessions.size, truncated: scan.truncated, unfiled: sessionsUnfiled, titles_by_path: Object.fromEntries(titlesByPath) },
    insights: { total: insightRows.length, themes: topOf(themes, 30), outcomes: objOf(outcomes), headlines },
    channels,
    org: { roles, anchors, projects_without_role: projectsWithoutRole, whole_workspace_roles: wholeWorkspaceRoles },
    decisions_open_by_category: objOf(decisionsByCategory),
    generated_at: now,
  };
}

export const analysisInputs = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    return computeAnalysisInputs(ctx, userId, args.team_id, Date.now());
  },
});

// ── Apply (O2) ────────────────────────────────────────────────────────────────

type Boundary = { team_id?: Id<"teams">; scope_user_id?: Id<"users"> };
type ApplyResult =
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

async function applyRole(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: OrgRoleProposal, note: string | undefined, opts: { provision: boolean; human_decision: string }): Promise<ApplyResult> {
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
  const reports_to = await resolveReportsTo(ctx, userId, boundary, p.reports_to);
  const role = await performCreateRole(ctx, userId, { name: p.name, handle, team_id: boundary.team_id, scope, reports_to, charter });
  if (p.caps) await performSetCaps(ctx, userId, { role_id: String(role._id), hands: p.caps.hands_per_day, wakes: p.caps.wakes_per_day, tokens: p.caps.tokens_per_day, human_decision: opts.human_decision });
  let provisioned = false;
  if (opts.provision) {
    const firstProject = role.scope?.project_ids?.[0] ? await ctx.db.get(role.scope.project_ids[0]) : null;
    await performProvisionRole(ctx, userId, { role_id: String(role._id), project_path: firstProject?.project_path ?? undefined });
    provisioned = true;
  }
  return {
    status: "applied",
    note: `created @${role.handle} (${role.short_id})${provisioned ? ", standing session provisioned" : ""}`,
    role: { id: String(role._id), short_id: role.short_id, handle: role.handle },
  };
}

async function applyProjects(ctx: Ctx, userId: Id<"users">, boundary: Boundary, changes: OrgProjectChange[], note: string | undefined): Promise<ApplyResult> {
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

async function applyMove(ctx: Ctx, userId: Id<"users">, boundary: Boundary, p: { handle: string; reports_to?: string; scope_add?: string[]; scope_remove?: string[] }, humanDecision: string): Promise<ApplyResult> {
  const handle = p.handle.replace(/^@/, "").toLowerCase();
  const role = (await rolesInBoundary(ctx, boundary)).find((r) => r.handle === handle || r.short_id === p.handle);
  if (!role) throw new Error(`No live role @${handle} in this workspace`);
  const did: string[] = [];
  if (p.scope_add?.length || p.scope_remove?.length) {
    const toRef = (s: string) => (/^(project|plan):/.test(s) ? s : /^pl-\d+$/.test(s) ? `plan:${s}` : `project:${s}`);
    await performSetRoleScope(ctx, userId, { role_id: String(role._id), add: (p.scope_add ?? []).map(toRef), remove: (p.scope_remove ?? []).map(toRef), human_decision: humanDecision });
    did.push(`scope ${[...(p.scope_add ?? []).map((s) => `+${s}`), ...(p.scope_remove ?? []).map((s) => `-${s}`)].join(" ")}`);
  }
  if (p.reports_to) {
    await performReparentRole(ctx, userId, { role_id: String(role._id), reports_to: await resolveReportsTo(ctx, userId, boundary, p.reports_to) });
    did.push(`now reports to ${p.reports_to}`);
  }
  return { status: "applied", note: `@${role.handle}: ${did.join("; ") || "nothing to change"}`, role: { id: String(role._id), short_id: role.short_id, handle: role.handle } };
}

async function applyRetire(ctx: Ctx, userId: Id<"users">, boundary: Boundary, handleRef: string): Promise<ApplyResult> {
  const handle = handleRef.replace(/^@/, "").toLowerCase();
  const role = (await rolesInBoundary(ctx, boundary)).find((r) => r.handle === handle || r.short_id === handleRef);
  if (!role) return { status: "applied", note: `@${handle} is already retired or never existed` };
  const r = await performRetireRole(ctx, userId, { role_id: String(role._id) });
  return { status: "applied", note: `retired @${role.handle} (${r.cleared} sessions back under their owners, ${r.rehomed} roles re-homed)` };
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
    let result: ApplyResult;
    if (p.kind === "role") result = await applyRole(ctx, userId, boundary, p, changed.note, { provision: opts.provision ?? true, human_decision: humanDecision });
    else if (p.kind === "projects") result = await applyProjects(ctx, userId, boundary, p.changes, changed.note);
    else if (p.kind === "move") result = await applyMove(ctx, userId, boundary, p, humanDecision);
    else result = await applyRetire(ctx, userId, boundary, p.handle);
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
