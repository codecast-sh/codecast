// What a deploy carried: the shipped fixes a workspace merged over the merge
// window, and the rule that assigns them to the deploy that sent them out. Read
// by deploys.ts (a marker's carries, the waiting set) and by deploysBackfill.ts.

import type { Doc, Id } from "./_generated/dataModel";
import { extractTaskShortIds } from "./lib/gitRefs";
import type { DeployRow } from "@codecast/shared/contracts/causeHistory";
import { mainAtOf } from "./deployTargetsState";
import { DAY, carriedBy, normalizeDeployTarget, type DeployMerge } from "@codecast/shared/contracts/deploys";

/** How far back merges are read for the waiting set and a marker's carries. */
const MERGE_WINDOW_MS = 90 * DAY;
/** Merged runs read per workspace (by_workspace_merged). */
const MERGES_SCAN = 400;
/** Deploys a project's list and a marker's reconcile read. */
const DEPLOYS_SCAN = 300;

export const sameSha = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

/** A deploy row as the history's carry rule reads it. */
export function deployRowOf(d: Doc<"deploys">): DeployRow {
  return {
    _id: String(d._id),
    project_id: d.project_id ? String(d.project_id) : null,
    at: d.live_at ?? d.created_at,
    sha: d.sha ?? null,
    cut_at: d.cut_at ?? null,
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
export async function workspaceMerges(ctx: any, workspace: string, now: number): Promise<DeployMerge[]> {
  return (await workspaceMergeWindow(ctx, workspace, now)).merges;
}

/** The workspace's merges and the time they are complete from: the window's start, or the oldest a full scan reached. */
export async function workspaceMergeWindow(ctx: any, workspace: string, now: number): Promise<{ merges: DeployMerge[]; from: number }> {
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
  // A scan that filled up stops short of the window: merges older than its oldest row may be missing.
  let from = since;
  if (runs.length === MERGES_SCAN) from = Math.max(from, runs[runs.length - 1].merge.at);
  if (landed.length === MERGES_SCAN) from = Math.max(from, landed[landed.length - 1].landed.at);
  return { merges: out, from };
}

/** A merge's run as a carry stores it: only a real run id. */
export const runIdOf = (id: string | undefined) => (id && !id.startsWith("landed:") ? (id as Id<"workflow_runs">) : undefined);

/** The deploys of a workspace, newest first. */
export async function workspaceDeploys(ctx: any, workspace: string, take = DEPLOYS_SCAN): Promise<Doc<"deploys">[]> {
  return await ctx.db
    .query("deploys")
    .withIndex("by_workspace_created", (q: any) => q.eq("workspace", workspace))
    .order("desc")
    .take(take);
}

export const isLiveDeploy = (d: Doc<"deploys">) => d.status === "live";

/** A merge belongs to a deploy's scope when its project matches, or the deploy names no project. */
const mergeInScope = (m: DeployMerge, projectId: string | null) => !projectId || !m.project_id || m.project_id === projectId;

/** The targets the workspace's lines deploy to: each project's line profile `[line.deploy] target`. */
export async function lineDeployTargets(ctx: any, workspace: string): Promise<Set<string>> {
  const projects = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(500);
  return new Set(projects.flatMap((p: any) => (p.line_profile?.deploy?.command ? [normalizeDeployTarget(p.line_profile.deploy.target) ?? "deploy"] : [])));
}

/** The place on main (cut_at) of the live deploy before this one on its target, when it has one. */
export async function previousCut(ctx: any, d: Doc<"deploys">, cuts?: ReadonlyMap<string, number>): Promise<number | null> {
  const at = d.live_at ?? d.created_at;
  const earlier: Doc<"deploys">[] = await ctx.db
    .query("deploys")
    .withIndex("by_workspace_target_created", (q: any) => q.eq("workspace", d.workspace).eq("target", d.target).lte("created_at", d.created_at))
    .order("desc")
    .take(30);
  for (const x of earlier) {
    if (x._id === d._id || x.status !== "live" || (x.live_at ?? x.created_at) > at) continue;
    const cut = x.cut_at ?? cuts?.get(String(x._id));
    if (cut != null) return cut;
  }
  return null;
}

/** Commits a deploy's range on main may hold before the rest are left out. */
const RANGE_COMMITS_MAX = 2000;

/**
 * The fixes a deploy recorded from a marker carried. A deploy placed on main (cut_at, after a placed live deploy
 * before it) carries the problems named by the commits in its range, after the previous deploy's cut and at or
 * before its own (commits.task_ids, every landing a problem had, by a run or by hand), and the run merges its code
 * holds, matched by sha. A deploy not placed on main is read by the history's rule over the workspace's merges.
 * `cuts` stands in for cut_at stamps not written yet (a dry repair); `read` the workspace's merges and line targets
 * when a caller read them once for many deploys.
 */
export async function carriesForMarker(ctx: any, row: Doc<"deploys">, now: number, cuts?: ReadonlyMap<string, number>, read?: { merges: DeployMerge[]; targets: Set<string> }): Promise<Doc<"deploys">["carries"]> {
  // Line fixes go out on the target a line deploys to (its [line.deploy] target). A marker for any other target (a web
  // build, a release, a second app) carries none of them.
  if (!(read?.targets ?? (await lineDeployTargets(ctx, row.workspace))).has(row.target)) return [];
  const projectId = row.project_id ? String(row.project_id) : null;
  // (A marker's deploy names no project: it ships the code, so it carries every fix in the workspace.)
  const all = (read?.merges ?? (await workspaceMerges(ctx, row.workspace, now))).map((m) => ({ ...m })).filter((m) => mergeInScope(m, projectId));
  const withCut = (d: Doc<"deploys">): DeployRow => ({ ...deployRowOf(d), cut_at: d.cut_at ?? cuts?.get(String(d._id)) ?? null });
  const self = withCut(row);
  if (self.cut_at == null && row.sha) self.cut_at = await mainAtOf(ctx, row.repository, row.sha);
  const from = self.cut_at != null && row.repository ? await previousCut(ctx, row, cuts) : null;
  const ranged = from != null;
  // Placed on main, its range's commits name every landing; only run merges add what a commit cannot say (run, card, pull request).
  const merges = ranged ? all.filter((m) => !m.run_id.startsWith("landed:")) : all;
  // A merge near or after the cut is held by its commit's own place on main; a time a day or more before it needs no read.
  if (self.cut_at != null) {
    for (const m of merges) {
      if (m.at < self.cut_at - DAY) continue;
      const at = await mainAtOf(ctx, row.repository, m.sha);
      if (at != null) m.main_at = at;
    }
  }
  const deploys = (await workspaceDeploys(ctx, row.workspace)).filter(isLiveDeploy).map((d) => (String(d._id) === String(row._id) ? self : withCut(d)));
  const carries: Doc<"deploys">["carries"] = carriedBy(self, merges, deploys).map((c) => ({
    task_id: c.task_id as Id<"tasks">,
    ...(runIdOf(c.run_id) ? { run_id: runIdOf(c.run_id) } : {}),
    ...(c.decision_id ? { decision_id: c.decision_id as Id<"session_decisions"> } : {}),
    ...(c.merge_sha ? { merge_sha: c.merge_sha } : {}),
    ...(c.merged_at ? { merged_at: c.merged_at } : {}),
    ...(c.pr_url ? { pr_url: c.pr_url } : {}),
    how: c.how,
  }));
  if (!ranged) return carries;
  const commits: Doc<"commits">[] = await ctx.db
    .query("commits")
    .withIndex("by_repository_main", (q: any) => q.eq("repository", row.repository).gt("main_at", from).lte("main_at", self.cut_at))
    .take(RANGE_COMMITS_MAX);
  // Each problem once, at its newest commit in the range whose own message names it. A commit's task_ids also take
  // the branch it was first pushed on, and a fix branch's push lists main commits it only contains; a landing known
  // only by its branch is a run merge, matched above by sha.
  const linked = new Map<string, Doc<"commits">[]>();
  for (const c of commits) for (const t of c.task_ids ?? []) linked.set(String(t), [...(linked.get(String(t)) ?? []), c]);
  const held = new Set(carries.map((c) => String(c.task_id)));
  for (const [taskId, linkedCommits] of linked) {
    if (held.has(taskId)) continue;
    const task: Doc<"tasks"> | null = await ctx.db.get(taskId as Id<"tasks">);
    if (!task?.short_id || task.workspace !== row.workspace || (projectId && String(task.project_id ?? "") !== projectId)) continue;
    const c = linkedCommits.filter((x) => extractTaskShortIds(x.message).includes(task.short_id.toLowerCase())).sort((x, y) => y.main_at! - x.main_at!)[0];
    if (!c) continue;
    carries.push({ task_id: task._id, merge_sha: c.sha, merged_at: c.main_at!, how: sameSha(c.sha, row.sha) ? "same commit" : "deployed after the merge" });
  }
  return carries.sort((a, b) => (a.merged_at ?? 0) - (b.merged_at ?? 0));
}
