// What a deploy carried: the shipped fixes a workspace merged over the merge
// window, and the rule that assigns them to the deploy that sent them out. Read
// by deploys.ts (a marker's carries, the waiting set) and by deploysBackfill.ts.
// A deploy that goes live also completes the change runs that stopped at Deploy
// waiting for it (completeLiveRuns).

import { v } from "convex/values";
import { internalMutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { extractTaskShortIds } from "./lib/gitRefs";
import type { DeployRow } from "@codecast/shared/contracts/causeHistory";
import { formatSessionMessage } from "@codecast/shared/contracts";
import { commitBySha, mainAtOf } from "./deployTargetsState";
import { DAY, carriedBy, normalizeDeployTarget, type DeployMerge } from "@codecast/shared/contracts/deploys";
import { reachOf } from "./deployReach";
import { runWorkflowOf } from "./lib/runGraph";
import { patchTask } from "./lib/taskWrite";
import { enqueuePendingMessage } from "./pendingMessages";
import { settleRunTask } from "./workflow_runs";
import { internal } from "./_generated/api";
import { workspaceKeyHasFeature } from "./lib/teamFeatureGuard";

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

// ── runs a later deploy took live ────────────────────────────────────────────

/** How long after it stopped a run at Deploy is still completed by a deploy that carries its change. */
const STOPPED_RUN_WINDOW_MS = 14 * DAY;
/**
 * Commits of a live deploy's range whose runs it reads, newest first. A range is the commits since the target's
 * previous live deploy, normally a handful; a target's first placed deploy has no lower bound, and past this cap its
 * oldest commits are left out. The commit at the deploy's own sha is always read.
 */
const STOPPED_RUN_COMMITS_MAX = 500;

type StoppedRun = Pick<Doc<"workflow_runs">, "status" | "current_node_id" | "merge" | "node_statuses">;

/**
 * The Deploy segment a run stopped in (`deploy`, `direct_deploy`): its change merged, its wait failed, and the run
 * ended at the segment's Deploy failed or Deploy stuck. Null for a run that stopped anywhere else.
 */
export function deployStopOf(run: StoppedRun): string | null {
  if (run.status !== "failed" || !run.merge?.sha) return null;
  const m = /^(.+)__(failed|stuck)$/.exec(run.current_node_id ?? "");
  if (!m) return null;
  return run.node_statuses.some((n) => n.node_id === `${m[1]}__wait` && n.status === "failed") ? m[1] : null;
}

type GraphShape = { nodes: Array<{ id: string; type: string; script?: string }>; edges: Array<{ from: string; to: string; condition?: string }> };

/**
 * Where the run would have gone had its Deploy wait seen the change live: the segment's Live and the exit right after
 * it. Null when the segment's wait is not `cast flow await-deploy`, or Live leads on to a station that never ran.
 */
export function liveExitOf(graph: GraphShape, prefix: string): { live: string; exit: string } | null {
  const wait = graph.nodes.find((n) => n.id === `${prefix}__wait`);
  if (!wait?.script?.includes("await-deploy")) return null;
  const live = graph.edges.find((e) => e.from === wait.id && (e.condition ?? "").trim() === "outcome = success")?.to;
  const liveNode = live ? graph.nodes.find((n) => n.id === live) : null;
  if (!live || !liveNode) return null;
  if (liveNode.type === "exit") return { live, exit: live };
  const next = graph.edges.filter((e) => e.from === live);
  const exit = next.length === 1 && !next[0].condition ? graph.nodes.find((n) => n.id === next[0].to) : null;
  return exit?.type === "exit" ? { live, exit: exit.id } : null;
}

/**
 * The run as its Deploy wait would have left it had it seen the change live: the wait completed with the live
 * deploys, the stop it ended at gone, the segment's Live and the exit after it completed.
 */
export function liveRunPatch(run: StoppedRun, prefix: string, to: { live: string; exit: string }, line: string, now: number): Pick<Doc<"workflow_runs">, "status" | "current_node_id" | "node_statuses"> {
  const statuses = run.node_statuses
    .filter((n) => n.node_id !== run.current_node_id && n.node_id !== to.live && n.node_id !== to.exit)
    .map((n) => (n.node_id === `${prefix}__wait` ? { ...n, status: "completed" as const, outcome: "success", result_preview: line, completed_at: now } : n));
  const done = (node_id: string, result?: string) => ({ node_id, status: "completed" as const, outcome: "success", ...(result ? { result_preview: result } : {}), started_at: now, completed_at: now });
  statuses.push(done(to.live, to.live === to.exit ? undefined : JSON.stringify({ exit: "live" })));
  if (to.exit !== to.live) statuses.push(done(to.exit));
  return { status: "completed", current_node_id: to.exit, node_statuses: statuses };
}

/**
 * A deploy went live: every run of its workspace that stopped at Deploy (failed or stuck, its change merged) and whose
 * change is now live on every target it touches is over at Live, as its wait would have ended had it seen this
 * deploy. Its task settles as a completed run's does, the blocker its stop left on the task goes, and the session
 * that heard it stop hears that it is over, once. A run that stopped anywhere else, or whose change some target still
 * lacks, stays as it is. Returns the runs completed.
 */
export async function completeLiveRuns(ctx: any, deployId: Id<"deploys">, now = Date.now()): Promise<Id<"workflow_runs">[]> {
  const d: Doc<"deploys"> | null = await ctx.db.get(deployId);
  if (!d || d.status !== "live" || !d.sha || !d.repository) return [];
  const runs = await runsMergedInto(ctx, d);
  const done: Id<"workflow_runs">[] = [];
  for (const run of runs) {
    if (run.updated_at < now - STOPPED_RUN_WINDOW_MS) continue;
    const prefix = deployStopOf(run);
    // A run a person queued to resume is theirs to finish.
    if (!prefix || run.resume_queued) continue;
    // This deploy holds the change (its own commit, or a cut on main at or after the merge's place); else it is not
    // what took the change live, and the deploy that does answers for it.
    const commit = await commitBySha(ctx, d.repository, run.merge!.sha);
    if (!commit?.main_at || !(sameSha(d.sha, commit.sha) || (d.cut_at != null && commit.main_at <= d.cut_at))) continue;
    const files = commit.files?.map((f) => f.filename) ?? null;
    const reach = await reachOf(ctx, async (w) => w === run.workspace, d.repository, { sha: commit.sha, main_at: commit.main_at, merged_at: commit.main_at }, files);
    if (reach?.state !== "live") continue;
    const graph = await runWorkflowOf(ctx, run);
    const to = graph ? liveExitOf(graph as unknown as GraphShape, prefix) : null;
    if (!to) continue;
    const live = reach.targets.filter((t) => t.state === "live" && t.deploy);
    const line = `Live: ${commit.sha.slice(0, 7)} on ${live.map((t) => `${t.target} ${t.deploy!.short_id}`).join(", ")}.`;
    const patch = liveRunPatch(run, prefix, to, line, now);
    await ctx.db.patch(run._id, { ...patch, fail_reason: undefined, updated_at: now });
    done.push(run._id);
    const task = run.task_id ? await ctx.db.get(run.task_id) : null;
    if (task) {
      // The stop marked the task blocked with its reason (settleRunTask); that reason no longer stands.
      if (run.fail_reason && task.execution_concerns === run.fail_reason) {
        await patchTask(ctx, task, { execution_concerns: undefined, ...(task.execution_status === "blocked" ? { execution_status: undefined } : {}), updated_at: now });
      }
      await settleRunTask(ctx, { ...run, ...patch }, "completed", undefined, now);
    }
    await tellStoppedSession(ctx, run, task, graph?.label || graph?.name || "change", line, d.workspace);
  }
  return done;
}

/**
 * The failed runs of a live deploy's workspace that merged a commit it carries: the commit at its own sha, and when it
 * is placed on main the commits after its target's previous live deploy and at or before its cut, found by merge sha.
 */
async function runsMergedInto(ctx: any, d: Doc<"deploys">): Promise<Doc<"workflow_runs">[]> {
  // A run's merge.sha is the full sha its merge pushed; a deploy's own sha may be short, so each is read as a prefix.
  const shas = new Set<string>([d.sha!.toLowerCase()]);
  if (d.cut_at != null) {
    const from = await previousCut(ctx, d);
    const range: Doc<"commits">[] = await ctx.db
      .query("commits")
      .withIndex("by_repository_main", (q: any) => (from != null ? q.eq("repository", d.repository).gt("main_at", from) : q.eq("repository", d.repository)).lte("main_at", d.cut_at))
      .order("desc")
      .take(STOPPED_RUN_COMMITS_MAX);
    for (const c of range) shas.add(c.sha.toLowerCase());
  }
  const runs = new Map<string, Doc<"workflow_runs">>();
  for (const s of shas) {
    const rows: Doc<"workflow_runs">[] = await ctx.db
      .query("workflow_runs")
      .withIndex("by_workspace_merge_sha", (q: any) => q.eq("workspace", d.workspace).gte("merge.sha", s).lt("merge.sha", `${s}~`))
      .take(20);
    for (const r of rows) if (r.status === "failed") runs.set(String(r._id), r);
  }
  return [...runs.values()];
}

/**
 * Tell the session that heard the run stop (the one its runner's end message reached, found by that send's client
 * id) that the run is over at Live, once. The run's subject, whose change it was, is the one retired when nothing is
 * left for it, never whichever session heard the stop: its daemon is asked (retireOnLive.retireSessionOnLive), and when
 * the subject is the one to tell, that judgment sends the tell, at once if it is kept, else once the ask's time is up
 * if it stays. A killed session is left alone, and a stop that reached nobody tells nobody.
 */
async function tellStoppedSession(ctx: any, run: Doc<"workflow_runs">, task: Doc<"tasks"> | null, flow: string, line: string, workspace: string): Promise<void> {
  const subject: Doc<"conversations"> | null = run.primary_conversation_id ? await ctx.db.get(run.primary_conversation_id) : null;
  const content = `The ${flow} run${task?.short_id ? ` on ${task.short_id}` : ""} is over: Live. ${line} It had stopped at Deploy; a later deploy took the change live. Nothing more is waiting on this session for it.`;
  const tell = { content: formatSessionMessage("unknown", content, { name: "codecast" }), client_id: `run:${run._id}:live`, from_user_id: run.user_id };
  const told = await stopHeardBy(ctx, run, task);
  const subjectHeard = !!subject && !!told && String(told._id) === String(subject._id);
  // Retiring is behind the team's retire_on_live flag; off, the session that heard the stop is told, as before it.
  const retiring = !!subject && !subject.inbox_killed_at && (await workspaceKeyHasFeature(ctx, workspace, "retire_on_live"));
  // Judged in its own transaction: the judgment reads the subject's commits and edits, so a deploy completing many
  // runs would otherwise read them all in this one, past its limits, and complete none.
  if (retiring && subject) await ctx.scheduler.runAfter(0, internal.retireOnLive.retireSessionOnLive, { conversation: subject._id, workspace, ...(subjectHeard ? { tell } : {}) });
  if (!told || (subjectHeard && retiring)) return;
  // A send refused (a hosted session the run's owner does not own) leaves the run completed all the same.
  await enqueuePendingMessage(ctx, told, run.user_id, { content: tell.content, client_id: tell.client_id }).catch(() => {});
}

/** The live session that heard the run stop and has not yet heard it is over, or null. */
async function stopHeardBy(ctx: any, run: Doc<"workflow_runs">, task: Doc<"tasks"> | null): Promise<Doc<"conversations"> | null> {
  const candidates = [run.spawner_conversation_id, run.primary_conversation_id, task?.created_from_conversation, ...(task?.conversation_ids ?? []).slice(-5)];
  const ended = `run:${run._id}:end:`;
  for (const id of new Set(candidates.filter(Boolean).map(String))) {
    const told = await ctx.db.query("pending_messages").withIndex("by_conversation_client_id", (q: any) => q.eq("conversation_id", id).gte("client_id", ended).lt("client_id", `${ended}~`)).first();
    if (!told) continue;
    const again = await ctx.db.query("pending_messages").withIndex("by_conversation_client_id", (q: any) => q.eq("conversation_id", id).eq("client_id", `run:${run._id}:live`)).first();
    const conversation = await ctx.db.get(id);
    return again || !conversation || conversation.inbox_killed_at ? null : conversation;
  }
  return null;
}

/** completeLiveRuns, after the write that took the deploy live (deploys.ts onDeployStatus). */
export const completeRunsOnLive = internalMutation({
  args: { deploy: v.id("deploys") },
  handler: async (ctx, args) => ({ completed: (await completeLiveRuns(ctx, args.deploy)).map(String) }),
});
