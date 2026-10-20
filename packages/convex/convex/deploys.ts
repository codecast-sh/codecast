// Deploys as objects (docs/architecture/deploys.md). One row per version that
// went live, or was asked to, on one target. Two writers:
//
//  - The line's deploy stage (DP2): `request` takes the project's shipped
//    fixes that no live deploy has carried yet and asks for one deploy that
//    sends them together. The machine that publishes the line profile runs the
//    team's deploy path (`cast line deploy run dp-N`) and reports through
//    `report`.
//  - A deploy marker (DP1): `recordDeployMarker`, called by
//    changesDeploy.markDeploy (`cast ship mark`) and by ingest's deploy items.
//    A marker finishes the line's open deploy on the same target, enriches the
//    deploy it already recorded, or records a deploy nobody asked for, carrying
//    the fixes the history's rule says it carried.
//
// What happened after (DP5) is derived at read: the carried problems'
// findings after the deploy went live, and the error groups that started or
// came back in its window.

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { canAccessProject, resolveWorkspaceKey, workspaceGrantsAccess } from "./lib/access";
import { nextShortId } from "./counters";
import { enqueueConfigCommand } from "./users";
import { normalizeRepository } from "./lib/gitRefs";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { deployIsLive, type DeployRow } from "@codecast/shared/contracts/causeHistory";
import {
  DEPLOY_SHORT_ID_PREFIX,
  DEPLOY_SHORT_ID_RE,
  carriedBy,
  normalizeDeployTarget,
  summarizeAfter,
  waitingMerges,
  type DeployAfter,
  type DeployAfterError,
  type DeployAfterProblem,
  type DeployMerge,
  type DeployStatus,
  type DeployView,
} from "@codecast/shared/contracts/deploys";

const DAY = 24 * 60 * 60 * 1000;
/** How far back merges are read for the waiting set and a marker's carries. */
const MERGE_WINDOW_MS = 90 * DAY;
/** Merged runs read per workspace (by_workspace_merged). */
const MERGES_SCAN = 400;
/** Deploys a project's list and a marker's reconcile read. */
const DEPLOYS_SCAN = 300;
/** A line deploy older than this, still waiting for its marker, no longer takes one. */
const OPEN_DEPLOY_MAX_AGE_MS = DAY;
/** The after window of a deploy with no later one on its target is capped here. */
const AFTER_MAX_MS = 14 * DAY;
/** A carried fix's findings count against its deploy for this long after it went live (the line's default watch). */
const FIX_WATCH_MS = 7 * DAY;
/** Error groups read for one list's after windows. */
const GROUPS_SCAN = 600;
const NOTE_MAX = 2000;
const COMMITS_MAX = 200;

const OPEN: ReadonlySet<DeployStatus> = new Set(["requested", "running"]);

const sameSha = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

/** A deploy row as the history's carry rule reads it. */
export function deployRowOf(d: Doc<"deploys">): DeployRow {
  return {
    _id: String(d._id),
    project_id: d.project_id ? String(d.project_id) : null,
    at: d.live_at ?? d.created_at,
    sha: d.sha ?? null,
    repository: d.repository ?? null,
    surface: d.target,
    environment: null,
    version: d.version ?? null,
    source: d.source,
    via: d.repository ? "repository" : "source",
    title: deployTitle(d),
    url: d.url ?? null,
  };
}

export function deployTitle(d: Pick<Doc<"deploys">, "target" | "sha" | "version">): string {
  const v = d.sha ? d.sha.slice(0, 10) : d.version;
  return v ? `Deployed ${v} to ${d.target}` : `Deploy to ${d.target}`;
}

// ── merges: the shipped fixes a deploy can carry ─────────────────────────────

/**
 * Every line run in a workspace with a recorded merge (workflow_runs.merge)
 * over the merge window, with its problem's project and the card that shipped
 * it. A pull request merged by hand outside a run is not here.
 */
async function workspaceMerges(ctx: any, workspace: string, now: number): Promise<DeployMerge[]> {
  const since = now - MERGE_WINDOW_MS;
  const runs = await ctx.db
    .query("workflow_runs")
    .withIndex("by_workspace_merged", (q: any) => q.eq("workspace", workspace).gte("merge.at", since))
    .order("desc")
    .take(MERGES_SCAN);
  const out: DeployMerge[] = [];
  const merged = new Set<string>();
  const taskProject = new Map<string, string | undefined>();
  for (const r of runs) {
    if (!r.merge?.sha || !r.task_id || r.merge.at < since) continue;
    const key = String(r.task_id);
    if (!taskProject.has(key)) {
      const t = await ctx.db.get(r.task_id);
      taskProject.set(key, t?.project_id ? String(t.project_id) : undefined);
    }
    out.push({
      run_id: String(r._id),
      task_id: key,
      ...(r.gate_decision_id ? { decision_id: String(r.gate_decision_id) } : {}),
      project_id: taskProject.get(key),
      sha: r.merge.sha,
      branch: r.merge.branch,
      into: r.merge.into,
      at: r.merge.at,
      ...(r.merge.pr_url ? { pr_url: r.merge.pr_url } : {}),
    });
    merged.add(key);
  }
  // A fix that reached the default branch outside a run's merge step (a commit naming the problem, a pull request
  // merged by hand): tasks.landed, the merge the problem's history reads too (web problemPage fixMerges).
  const landed = await ctx.db
    .query("tasks")
    .withIndex("by_workspace_landed", (q: any) => q.eq("workspace", workspace).gte("landed.at", since))
    .order("desc")
    .take(MERGES_SCAN);
  for (const t of landed) {
    if (!t.landed?.sha || merged.has(String(t._id))) continue;
    out.push({
      run_id: t.workflow_run_id ? String(t.workflow_run_id) : `landed:${t._id}`,
      task_id: String(t._id),
      ...(t.project_id ? { project_id: String(t.project_id) } : {}),
      sha: t.landed.sha,
      branch: t.landed.branch,
      into: t.landed.branch,
      at: t.landed.at,
      ...(t.landed.url ? { pr_url: t.landed.url } : {}),
    });
  }
  return out;
}

/** A merge's run as a carry stores it: only a real run id. */
const runIdOf = (id: string | undefined) => (id && !id.startsWith("landed:") ? (id as Id<"workflow_runs">) : undefined);

/** Whether a deploy is in a project's scope: its own project, else its repository's projects, else (a workspace-wide source) every project. */
function inScope(d: Pick<Doc<"deploys">, "project_id" | "repository">, projectId: string | null, repositories: ReadonlySet<string> | null): boolean {
  if (d.project_id) return !projectId || String(d.project_id) === projectId;
  if (d.repository && repositories) return repositories.has(d.repository);
  return true;
}

/** The deploys of a workspace, newest first. */
async function workspaceDeploys(ctx: any, workspace: string, take = DEPLOYS_SCAN): Promise<Doc<"deploys">[]> {
  return await ctx.db
    .query("deploys")
    .withIndex("by_workspace_created", (q: any) => q.eq("workspace", workspace))
    .order("desc")
    .take(take);
}

const isLiveDeploy = (d: Doc<"deploys">) => d.status === "live";

/** A merge belongs to a deploy's scope when its project matches, or the deploy names no project. */
const mergeInScope = (m: DeployMerge, projectId: string | null) => !projectId || !m.project_id || m.project_id === projectId;

/** The project and every project in its workspace whose line profile publishes from the same checkout. */
async function projectsSharingRoot(ctx: any, project: Doc<"projects">, workspace: string): Promise<Set<string>> {
  const out = new Set([String(project._id)]);
  const root = (project as any).line_profile?.root;
  if (!root) return out;
  const rows = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(500);
  for (const p of rows) if (p.line_profile?.root === root) out.add(String(p._id));
  return out;
}

/** The project's waiting set: its merges no live deploy carried and no open line deploy is sending. */
async function waitingFor(ctx: any, project: Doc<"projects">, workspace: string, now: number) {
  const projectId = String(project._id);
  const [merges, deploys] = await Promise.all([workspaceMerges(ctx, workspace, now), workspaceDeploys(ctx, workspace)]);
  const mine = deploys.filter((d) => inScope(d, projectId, null));
  const live = mine.filter(isLiveDeploy).map(deployRowOf);
  // What an open deploy is sending, by run and by problem (a landed fix has no run).
  const sending = new Set(mine.filter((d) => OPEN.has(d.status)).flatMap((d) => d.carries.flatMap((c) => [String(c.task_id), ...(c.run_id ? [String(c.run_id)] : [])])));
  // One deploy ships one checkout: every project whose line publishes from the same root waits on it (Union's eight lines, one repo).
  const shipped = await projectsSharingRoot(ctx, project, workspace);
  const waiting = waitingMerges(merges.filter((m) => !!m.project_id && shipped.has(m.project_id)), live).filter((m) => !sending.has(m.run_id) && !sending.has(m.task_id));
  const open = mine.find((d) => OPEN.has(d.status)) ?? null;
  return { waiting, open };
}

// ── shaping for readers ──────────────────────────────────────────────────────

async function shapeView(ctx: any, d: Doc<"deploys">): Promise<DeployView> {
  const carries = [];
  for (const c of d.carries) {
    const task = await ctx.db.get(c.task_id);
    const decision = c.decision_id ? await ctx.db.get(c.decision_id) : null;
    carries.push({
      task_id: String(c.task_id),
      ...(c.run_id ? { run_id: String(c.run_id) } : {}),
      ...(c.decision_id ? { decision_id: String(c.decision_id) } : {}),
      ...(c.merge_sha ? { merge_sha: c.merge_sha } : {}),
      ...(c.merged_at ? { merged_at: c.merged_at } : {}),
      ...(c.pr_url ? { pr_url: c.pr_url } : {}),
      how: c.how,
      task_short_id: task?.short_id ?? null,
      task_title: task?.title ?? null,
      decision_short_id: decision?.short_id ?? null,
    });
  }
  return {
    _id: String(d._id),
    short_id: d.short_id,
    ...(d.client_key ? { client_key: d.client_key } : {}),
    project_id: d.project_id ? String(d.project_id) : null,
    target: d.target,
    status: d.status,
    trigger: d.trigger,
    started_by: d.started_by
      ? { kind: d.started_by.kind, name: d.started_by.name, ...(d.started_by.user_id ? { user_id: String(d.started_by.user_id) } : {}), ...(d.started_by.role_id ? { role_id: String(d.started_by.role_id) } : {}) }
      : null,
    source: d.source,
    repository: d.repository ?? null,
    sha: d.sha ?? null,
    previous_sha: d.previous_sha ?? null,
    version: d.version ?? null,
    url: d.url ?? null,
    commits: d.commits ?? [],
    carries,
    note: d.note ?? null,
    created_at: d.created_at,
    live_at: d.live_at ?? null,
    finished_at: d.finished_at ?? null,
  };
}

/**
 * What happened after each live deploy: per carried problem its findings in
 * the window and whether one reopened it, and the error groups that started
 * or came back in the window. `deploys` newest first, all on one workspace.
 */
async function afterFor(ctx: any, workspace: string, deploys: Doc<"deploys">[], now: number): Promise<Map<string, DeployAfter>> {
  const out = new Map<string, DeployAfter>();
  const live = deploys.filter(isLiveDeploy).sort((a, b) => (a.live_at ?? a.created_at) - (b.live_at ?? b.created_at));
  if (!live.length) return out;
  const earliest = live[0].live_at ?? live[0].created_at;
  const groups = await ctx.db
    .query("event_groups")
    .withIndex("by_workspace_last_seen", (q: any) => q.eq("workspace", workspace).gte("last_seen", earliest))
    .order("desc")
    .take(GROUPS_SCAN);
  for (let i = 0; i < live.length; i++) {
    const d = live[i];
    const from = d.live_at ?? d.created_at;
    const next = live.slice(i + 1).find((n) => n.target === d.target);
    const to = next ? next.live_at ?? next.created_at : Math.min(now, from + AFTER_MAX_MS);
    const problems: DeployAfterProblem[] = [];
    for (const c of d.carries) {
      const signals = await ctx.db
        .query("signals")
        .withIndex("by_task", (q: any) => q.eq("task_id", c.task_id).gte("created_at", from))
        .take(200);
      // A fix is judged over the week after it went live (the line's watch), whatever deploys came next.
      const fixTo = Math.min(now, from + FIX_WATCH_MS);
      const inWindow = signals.filter((s: any) => !s.retired && (s.observed_at ?? s.created_at) >= from && (s.observed_at ?? s.created_at) < fixTo);
      const times = inWindow.map((s: any) => s.observed_at ?? s.created_at).sort((a: number, b: number) => a - b);
      problems.push({ task_id: String(c.task_id), findings: inWindow.length, reopened: inWindow.some((s: any) => s.reopened), first_at: times[0] ?? null });
    }
    const errors: DeployAfterError[] = [];
    for (const g of groups) {
      if (d.source_id && String(g.source_id) !== String(d.source_id)) continue;
      if (g.kind !== "error") continue;
      const isNew = g.first_seen >= from && g.first_seen < to;
      const regressed = !isNew && g.regressed_at != null && g.regressed_at >= from && g.regressed_at < to;
      if (!isNew && !regressed) continue;
      errors.push({ group_id: String(g._id), short_id: g.short_id, title: g.title, kind: isNew ? "new" : "regressed", at: isNew ? g.first_seen : g.regressed_at, count: g.count });
    }
    errors.sort((a, b) => a.at - b.at);
    out.set(String(d._id), summarizeAfter(from, to, !next && to >= now, problems, errors.slice(0, 20)));
  }
  return out;
}

// ── the marker path (DP1) ─────────────────────────────────────────────────────

export type DeployMarker = {
  workspace: string;
  team_id?: Id<"teams">;
  project_id?: Id<"projects">;
  /** The surface or environment the marker names. */
  target: string;
  sha?: string;
  version?: string;
  repository?: string;
  source: string;
  source_id?: Id<"event_sources">;
  event_id?: Id<"external_events">;
  url?: string;
  previous_sha?: string;
  commits?: Array<{ sha: string; subject: string; author?: string }>;
  started_by?: Doc<"deploys">["started_by"];
  at: number;
};

/**
 * Record a deploy marker as a deploy object, once. Returns the deploy's short
 * id, or null when the marker names a place no user reaches (a laptop's boot).
 *
 *  1. The deploy this marker already recorded (same target and sha or
 *     version): enriched with what the marker adds.
 *  2. An open line deploy on the same target, asked for within a day: the
 *     marker finishes it (live, with the sha).
 *  3. Otherwise a deploy of its own, started outside the line, carrying the
 *     fixes the history's rule says it carried.
 */
export async function recordDeployMarker(ctx: any, m: DeployMarker): Promise<string | null> {
  const target = normalizeDeployTarget(m.target);
  if (!target || !deployIsLive({ environment: target })) return null;
  const now = Date.now();
  const repository = m.repository ? normalizeRepository(m.repository) : undefined;
  const recent = await workspaceDeploys(ctx, m.workspace, 100);

  const same = recent.find((d) =>
    d.target === target && (d.status === "live" || OPEN.has(d.status))
    && ((m.sha && sameSha(d.sha, m.sha)) || (!m.sha && m.version && d.version === m.version)),
  );
  const open = same ?? recent.find((d) =>
    d.target === target && OPEN.has(d.status) && now - d.created_at < OPEN_DEPLOY_MAX_AGE_MS
    && (!d.repository || !repository || d.repository === repository),
  );

  if (open) {
    const patch: Partial<Doc<"deploys">> = { updated_at: now };
    if (m.event_id && !open.event_ids.some((e) => String(e) === String(m.event_id))) patch.event_ids = [...open.event_ids, m.event_id];
    if (OPEN.has(open.status)) { patch.status = "live"; patch.live_at = m.at; patch.finished_at = now; }
    if (m.sha && !open.sha) patch.sha = m.sha;
    if (m.version && !open.version) patch.version = m.version;
    if (repository && !open.repository) patch.repository = repository;
    if (m.url && !open.url) patch.url = m.url;
    if (m.previous_sha && !open.previous_sha) patch.previous_sha = m.previous_sha;
    if (m.commits?.length && !open.commits?.length) patch.commits = m.commits.slice(0, COMMITS_MAX);
    if (m.source_id && !open.source_id) patch.source_id = m.source_id;
    await ctx.db.patch(open._id, patch);
    await stampEvent(ctx, m.event_id, open.short_id);
    return open.short_id;
  }

  const shortId = await nextShortId(ctx.db, DEPLOY_SHORT_ID_PREFIX);
  const base = {
    short_id: shortId,
    workspace: m.workspace,
    ...(m.team_id ? { team_id: m.team_id } : {}),
    ...(m.project_id ? { project_id: m.project_id } : {}),
    target,
    status: "live" as const,
    trigger: "outside" as const,
    ...(m.started_by ? { started_by: m.started_by } : {}),
    source: m.source,
    ...(m.source_id ? { source_id: m.source_id } : {}),
    event_ids: m.event_id ? [m.event_id] : [],
    ...(repository ? { repository } : {}),
    ...(m.sha ? { sha: m.sha } : {}),
    ...(m.previous_sha ? { previous_sha: m.previous_sha } : {}),
    ...(m.version ? { version: m.version } : {}),
    ...(m.url ? { url: m.url } : {}),
    ...(m.commits?.length ? { commits: m.commits.slice(0, COMMITS_MAX) } : {}),
    carries: [],
    created_at: m.at,
    live_at: m.at,
    finished_at: m.at,
    updated_at: now,
  };
  const id = await ctx.db.insert("deploys", base);
  const row = (await ctx.db.get(id))!;
  const carries = await carriesForMarker(ctx, row, now);
  if (carries.length) await ctx.db.patch(id, { carries });
  await stampEvent(ctx, m.event_id, shortId);
  return shortId;
}

/** The fixes a deploy recorded from a marker carried, by the history's rule over the workspace's merges and live deploys. */
async function carriesForMarker(ctx: any, row: Doc<"deploys">, now: number): Promise<Doc<"deploys">["carries"]> {
  const merges = (await workspaceMerges(ctx, row.workspace, now)).filter((m) => mergeInScope(m, row.project_id ? String(row.project_id) : null));
  // (A marker's deploy names no project: it ships the code, so it carries every fix in the workspace.)
  if (!merges.length) return [];
  const deploys = (await workspaceDeploys(ctx, row.workspace)).filter(isLiveDeploy).map(deployRowOf);
  return carriedBy(deployRowOf(row), merges, deploys).map((c) => ({
    task_id: c.task_id as Id<"tasks">,
    ...(runIdOf(c.run_id) ? { run_id: runIdOf(c.run_id) } : {}),
    ...(c.decision_id ? { decision_id: c.decision_id as Id<"session_decisions"> } : {}),
    ...(c.merge_sha ? { merge_sha: c.merge_sha } : {}),
    ...(c.merged_at ? { merged_at: c.merged_at } : {}),
    ...(c.pr_url ? { pr_url: c.pr_url } : {}),
    how: c.how,
  }));
}

async function stampEvent(ctx: any, eventId: Id<"external_events"> | undefined, shortId: string): Promise<void> {
  if (!eventId) return;
  const e = await ctx.db.get(eventId);
  if (!e || e.meta?.deploy === shortId) return;
  await ctx.db.patch(eventId, { meta: { ...(e.meta ?? {}), deploy: shortId } });
}

// ── the line's deploy stage (DP2) ────────────────────────────────────────────

/** A project by name in any of the caller's workspaces, when a profile names no team; two matches ask for the team. */
async function projectByNameAnywhere(ctx: any, userId: Id<"users">, name: string): Promise<Doc<"projects"> | null> {
  const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).take(50);
  const keys = [`user:${userId}`, ...memberships.map((m: any) => `team:${m.team_id}`)];
  const found: Doc<"projects">[] = [];
  for (const k of keys) {
    // A workspace without the project answers by throwing; only a match counts.
    const p = await resolveWorkspaceProject(ctx, k, name).catch(() => null);
    if (p) found.push(p);
  }
  if (found.length > 1) throw new Error(`More than one of your workspaces has a project named ${name}; set [line] team in .codecast/line.toml`);
  return found[0] ?? null;
}

/** A project by id, short id, or (with the profile's team) its name. */
async function readableProjectFor(ctx: any, userId: Id<"users">, projectRef: string, teamId?: Id<"teams">): Promise<Doc<"projects">> {
  const id = ctx.db.normalizeId("projects", projectRef);
  const project = id
    ? await ctx.db.get(id)
    : (await ctx.db.query("projects").withIndex("by_short_id", (q: any) => q.eq("short_id", projectRef)).first())
      ?? (teamId ? await resolveWorkspaceProject(ctx, `team:${teamId}`, projectRef) : await projectByNameAnywhere(ctx, userId, projectRef));
  if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error(`No project ${projectRef} you can read`);
  return project;
}

async function personName(ctx: any, userId: Id<"users">): Promise<string> {
  const u = await ctx.db.get(userId);
  return u?.name ?? u?.github_username ?? u?.email ?? "someone";
}

/**
 * The deploy stage of a project's line: the shipped fixes waiting to go out,
 * the deploy already on its way, and the profile's deploy path.
 */
export const stage = query({
  args: { project_id: v.string(), team_id: v.optional(v.id("teams")), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const project = await readableProjectFor(ctx, userId, args.project_id, args.team_id);
    const workspace = await resolveWorkspaceKey(ctx, project);
    const now = Date.now();
    const { waiting, open } = await waitingFor(ctx, project, workspace, now);
    const tasks = new Map<string, any>();
    for (const m of waiting) if (!tasks.has(m.task_id)) tasks.set(m.task_id, await ctx.db.get(m.task_id as Id<"tasks">));
    const profile: any = project.line_profile ?? null;
    return {
      project: { _id: String(project._id), short_id: project.short_id ?? null, title: project.title ?? null },
      deploy: profile?.deploy ?? null,
      device_id: profile?.device_id ?? null,
      root: profile?.root ?? null,
      waiting: waiting.map((m) => ({ ...m, task_short_id: tasks.get(m.task_id)?.short_id ?? null, task_title: tasks.get(m.task_id)?.title ?? null })),
      open: open ? await shapeView(ctx, open) : null,
    };
  },
});

/**
 * Ask for one deploy that sends the project's waiting fixes together. The web
 * path also queues `line_deploy` on the machine that publishes the profile;
 * the CLI path (`here`) runs the command itself. `clientKey` is the store's
 * stub of the row, which the server row supersedes (lineDeploys altKey).
 */
export async function requestDeployCore(
  ctx: any,
  userId: Id<"users">,
  projectRef: string,
  opts: { teamId?: Id<"teams">; here?: boolean; cli?: boolean; clientKey?: string; requestId?: string } = {},
): Promise<{ _id: string; short_id: string; carries: number }> {
  const project = await readableProjectFor(ctx, userId, projectRef, opts.teamId);
  const profile: any = project.line_profile ?? null;
  const deploy = profile?.deploy;
  if (!deploy?.command) throw new Error("This line has no deploy stage: add [line.deploy] command to .codecast/line.toml and publish it");
  const workspace = await resolveWorkspaceKey(ctx, project);
  const now = Date.now();
  const { waiting, open } = await waitingFor(ctx, project, workspace, now);
  if (open) throw new Error(`${open.short_id} is already going out (${open.status}); wait for it to finish`);
  if (!waiting.length) throw new Error("Nothing is waiting to go out: every shipped fix is live");
  if (!opts.here && (!profile.device_id || !profile.root)) throw new Error("No machine publishes this line's profile, so nothing can run its deploy path");

  const shortId = await nextShortId(ctx.db, DEPLOY_SHORT_ID_PREFIX);
  const id = await ctx.db.insert("deploys", {
    short_id: shortId,
    ...(opts.clientKey ? { client_key: opts.clientKey } : {}),
    workspace,
    ...(project.team_id ? { team_id: project.team_id } : {}),
    project_id: project._id,
    target: normalizeDeployTarget(deploy.target) ?? "deploy",
    status: "requested",
    trigger: "person",
    started_by: { kind: opts.cli ? "cli" : "person", name: await personName(ctx, userId), user_id: userId },
    source: "line",
    event_ids: [],
    carries: waiting.map((m) => ({
      task_id: m.task_id as Id<"tasks">,
      ...(runIdOf(m.run_id) ? { run_id: runIdOf(m.run_id) } : {}),
      ...(m.decision_id ? { decision_id: m.decision_id as Id<"session_decisions"> } : {}),
      merge_sha: m.sha,
      merged_at: m.at,
      ...(m.pr_url ? { pr_url: m.pr_url } : {}),
      how: "sent" as const,
    })),
    created_at: now,
    updated_at: now,
  });
  if (!opts.here) {
    try {
      await enqueueConfigCommand(ctx, userId, "line_deploy", JSON.stringify({ deploy: shortId, root: profile.root }), profile.device_id, opts.requestId);
    } catch (err) {
      throw new Error(`The deploy runs on the machine that publishes this line, which is not yours: ask its owner, or run \`cast line deploy --go\` there (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { _id: String(id), short_id: shortId, carries: waiting.length };
}

export const request = mutation({
  args: {
    project_id: v.string(),
    team_id: v.optional(v.id("teams")),
    api_token: v.optional(v.string()),
    here: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    return await requestDeployCore(ctx, userId, args.project_id, { teamId: args.team_id, here: args.here, cli: !!args.api_token });
  },
});

/** The deploy path's report: started (running, with its run's url), done (live, with the sha it put out) or failed. */
export const report = mutation({
  args: {
    api_token: v.optional(v.string()),
    deploy: v.string(),
    status: v.union(v.literal("running"), v.literal("live"), v.literal("failed"), v.literal("cancelled")),
    sha: v.optional(v.string()),
    previous_sha: v.optional(v.string()),
    url: v.optional(v.string()),
    note: v.optional(v.string()),
    commits: v.optional(v.array(v.object({ sha: v.string(), subject: v.string(), author: v.optional(v.string()) }))),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const d = await deployByRef(ctx, args.deploy);
    if (!d || !(await workspaceGrantsAccess(ctx, userId, d.workspace))) throw new Error(`No deploy ${args.deploy} you can read`);
    const now = Date.now();
    const patch: Partial<Doc<"deploys">> = { updated_at: now };
    if (args.url) patch.url = args.url;
    if (args.sha && !d.sha) patch.sha = args.sha.toLowerCase();
    if (args.previous_sha && !d.previous_sha) patch.previous_sha = args.previous_sha.toLowerCase();
    if (args.commits?.length && !d.commits?.length) patch.commits = args.commits.slice(0, COMMITS_MAX);
    if (args.note) patch.note = args.note.slice(-NOTE_MAX);
    // A marker may have finished it already; a report never moves a deploy backwards.
    if (OPEN.has(d.status)) {
      if (args.status === "running") patch.status = "running";
      else {
        patch.status = args.status;
        patch.finished_at = now;
        if (args.status === "live") patch.live_at = now;
      }
    }
    await ctx.db.patch(d._id, patch);
    return { short_id: d.short_id, status: patch.status ?? d.status };
  },
});

async function deployByRef(ctx: any, ref: string): Promise<Doc<"deploys"> | null> {
  if (DEPLOY_SHORT_ID_RE.test(ref)) return await ctx.db.query("deploys").withIndex("by_short_id", (q: any) => q.eq("short_id", ref.toLowerCase())).first();
  const id = ctx.db.normalizeId("deploys", ref);
  return id ? await ctx.db.get(id) : null;
}

// ── reads ────────────────────────────────────────────────────────────────────

/** One deploy, whole: what went out, who started it, what happened after. */
export const get = query({
  args: { ref: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const d = await deployByRef(ctx, args.ref.trim());
    if (!d || !(await workspaceGrantsAccess(ctx, userId, d.workspace))) return null;
    const around = (await workspaceDeploys(ctx, d.workspace)).filter((x) => x.target === d.target);
    const after = await afterFor(ctx, d.workspace, around.some((x) => String(x._id) === String(d._id)) ? around : [...around, d], Date.now());
    const events = [];
    for (const e of d.event_ids) {
      const row = await ctx.db.get(e);
      if (row) events.push({ _id: String(row._id), title: row.title, url: row.url ?? null, at: row.created_at, source: row.data?.source_name ?? row.source });
    }
    const project = d.project_id ? await ctx.db.get(d.project_id) : null;
    return {
      ...(await shapeView(ctx, d)),
      after: after.get(String(d._id)) ?? null,
      events,
      project: project ? { _id: String(project._id), short_id: project.short_id ?? null, title: project.title ?? null } : null,
    };
  },
});

/** The deploys that carried a problem's fixes, newest first: what the problem and its decision link to. */
export const forTask = query({
  args: { task_id: v.id("tasks") },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, undefined);
    const task = await ctx.db.get(args.task_id);
    if (!task) return [];
    const workspace = await resolveWorkspaceKey(ctx, task);
    if (!(await workspaceGrantsAccess(ctx, userId, workspace))) return [];
    const deploys = await workspaceDeploys(ctx, workspace);
    return deploys
      .filter((d) => d.carries.some((c) => String(c.task_id) === String(args.task_id)))
      .map((d) => ({ _id: String(d._id), short_id: d.short_id, target: d.target, status: d.status, sha: d.sha ?? null, at: d.live_at ?? d.created_at }));
  },
});

/**
 * A project's deploys over the history window, newest first, each with what
 * it carried and what happened after: the rows the Line page, a problem's
 * timeline and the charts read (store collection lineDeploys).
 */
export async function projectDeployViews(ctx: any, project: Doc<"projects">, repositories: ReadonlyArray<string>, since: number) {
  const workspace = await resolveWorkspaceKey(ctx, project);
  const repos = repositories.length ? new Set(repositories.map((r) => normalizeRepository(r))) : null;
  const all = (await workspaceDeploys(ctx, workspace)).filter((d) => (d.live_at ?? d.created_at) >= since || OPEN.has(d.status));
  const mine = all.filter((d) => inScope(d, String(project._id), repos));
  const after = await afterFor(ctx, workspace, mine, Date.now());
  const out = [];
  for (const d of mine) {
    const view = await shapeView(ctx, d);
    // One row per deploy, whichever project's feed brought it: its own project when the line sent it, none when it
    // ships the whole workspace's code. The store scopes rows by `workspace` (lineDeploys workspaceScoped).
    out.push({ ...deployRowOf(d), ...view, workspace: d.workspace, after: after.get(String(d._id)) ?? null });
  }
  return out;
}

// ── backfill (DP6) ───────────────────────────────────────────────────────────

/**
 * Record every deploy marker already in external_events as a deploy object,
 * oldest first so each one's carries read the deploys before it. Idempotent:
 * a marker whose meta.deploy is set is skipped. One source or repository per
 * call; `dry` counts without writing.
 */
export const backfill = internalMutation({
  args: {
    source_id: v.optional(v.id("event_sources")),
    repository: v.optional(v.string()),
    // Resume after this created_at (the last call's `next`).
    since: v.optional(v.number()),
    dry: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const PAGE = 3000;
    const since = args.since ?? 0;
    let events: any[] = [];
    if (args.source_id) {
      events = await ctx.db.query("external_events").withIndex("by_source_created", (q: any) => q.eq("source_id", args.source_id).gt("created_at", since)).order("asc").take(PAGE);
    } else if (args.repository) {
      events = await ctx.db.query("external_events").withIndex("by_repository_created", (q: any) => q.eq("repository", normalizeRepository(args.repository!)).gt("created_at", since)).order("asc").take(PAGE);
    } else throw new Error("pass source_id or repository");
    let next: number | null = events.length === PAGE ? events[events.length - 1].created_at : null;
    const markers = events.filter((e) => e.kind === "deploy");
    // Each recorded marker reads the workspace's merges and deploys: a few per call keeps a call well under its read limit.
    const PER_CALL = 10;
    let recorded = 0, skipped = 0, notLive = 0;
    for (const e of markers) {
      if (e.meta?.deploy) { skipped++; continue; }
      if (recorded >= PER_CALL) { next = e.created_at - 1; break; }
      const marker = await markerOfEvent(ctx, e);
      if (!marker) { notLive++; continue; }
      if (args.dry) { recorded++; continue; }
      const id = await recordDeployMarker(ctx, marker);
      if (id) recorded++; else notLive++;
    }
    return { markers: markers.length, recorded, skipped, not_live: notLive, dry: !!args.dry, next };
  },
});

/** The marker a stored deploy event describes, in the shape recordDeployMarker takes. */
export async function markerOfEvent(ctx: any, e: any): Promise<DeployMarker | null> {
  const target = normalizeDeployTarget(e.meta?.surface ?? e.data?.environment ?? null) ?? "deploy";
  let workspace: string | null = e.workspace ?? null;
  if (e.source_id) {
    const source = await ctx.db.get(e.source_id);
    workspace = workspace ?? source?.workspace ?? null;
  }
  if (!workspace && e.team_id) workspace = `team:${e.team_id}`;
  if (!workspace) return null;
  const actor = e.actor_user_id ? await ctx.db.get(e.actor_user_id) : null;
  return {
    workspace,
    ...(e.team_id ? { team_id: e.team_id } : {}),
    target,
    ...(e.sha ? { sha: e.sha } : {}),
    ...(e.meta?.version ?? e.data?.release ? { version: e.meta?.version ?? e.data?.release } : {}),
    ...(e.repository ? { repository: e.repository } : {}),
    source: e.data?.source_name ?? (e.source === "codecast" ? "cast ship mark" : e.source),
    ...(e.source_id ? { source_id: e.source_id } : {}),
    event_id: e._id,
    ...(actor ? { started_by: { kind: "person" as const, name: actor.name ?? actor.github_username ?? "someone", user_id: actor._id } } : e.source_id ? { started_by: { kind: "source" as const, name: e.data?.source_name ?? "source" } } : {}),
    at: e.created_at,
  };
}

/** The sources and repositories the backfill walks (deploys.md DP6): run.sh deploys:backfillTargets. */
export const backfillTargets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const sources = await ctx.db.query("event_sources").take(500);
    const repos = new Set<string>();
    for (const r of await ctx.db.query("repo_sources").take(2000)) repos.add(normalizeRepository(r.repository));
    return { sources: sources.map((s: any) => ({ _id: String(s._id), name: s.name })), repositories: [...repos].sort() };
  },
});

/**
 * Recompute the carries of deploys recorded from markers (trigger outside),
 * oldest first, after the merges the rule reads changed (landed fixes joined
 * them). A deploy the line sent keeps what it sent. Ten per call; pass the
 * returned `next` as `since` until it is null.
 */
export const recarry = internalMutation({
  args: { workspace: v.string(), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const PER_CALL = 10;
    const rows = await ctx.db
      .query("deploys")
      .withIndex("by_workspace_created", (q: any) => q.eq("workspace", args.workspace).gt("created_at", args.since ?? 0))
      .order("asc")
      .take(PER_CALL);
    const now = Date.now();
    let changed = 0;
    for (const d of rows) {
      if (d.trigger !== "outside" || d.status !== "live") continue;
      // A marker's deploy names no project (it ships the code); one recorded before that rule lets go of its project.
      const wide = d.project_id ? { ...d, project_id: undefined } : d;
      const carries = await carriesForMarker(ctx, wide, now);
      if (d.project_id || JSON.stringify(carries) !== JSON.stringify(d.carries)) { await ctx.db.patch(d._id, { carries, project_id: undefined, updated_at: now }); changed++; }
    }
    return { read: rows.length, changed, next: rows.length === PER_CALL ? rows[rows.length - 1].created_at : null };
  },
});
