// The release sweep (pl-1146 piece 7): the exceptions a workspace's Release
// Captain acts on, in one read, so its hourly check is gated on there being
// one (`cast release sweep --quiet` as the routine's precheck) and spends
// nothing on a quiet hour. Five kinds, each read the way the surface that owns
// it reads it:
//   - open run-stop incidents (flowStops.openFlowStopIncidents);
//   - deploy targets holding a commit merged longer ago than the target's
//     deadline (deployDeadlineMs) that it does not run yet;
//   - runs that failed in the last two hours outside any incident, not
//     cancelled, not since re-run, on a task still open, and the pipeline's to
//     answer for: a failure that is no stop (a crash, a timeout, a station
//     error no stop exit caught), or a stop at a shared exit still held. A stop
//     about the change itself (rejected, findings) is its own run's to act on;
//   - team machines online and still below a floor raised half an hour ago or
//     more (teamCliFloor.teamFleet);
//   - sessions whose change is live everywhere and that nothing keeps, yet are
//     still in the inbox (retireOnLive.liveRetireRefusal answers null).
// Reads only. Every list is capped, so one quiet query stays well inside a
// query's read budget.

import { ConvexError, v } from "convex/values";
import { query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { createWorkContext } from "./data";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { canAccessConversation } from "./lib/access";
import { isFlowStop, openFlowStopIncidents, stopStationOf, type FlowStopIncident } from "./flowStops";
import { commitBySha, targetDeploys, targetRows } from "./deployTargetsState";
import { teamFleet } from "./teamCliFloor";
import { liveRetireRefusal } from "./retireOnLive";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { commitTouchesTarget, deployDeadlineMs } from "@codecast/shared/contracts/deployTargets";
import { liveDeployOf } from "@codecast/shared/contracts/deploys";
import { isBelowMinimum } from "@platform/flags";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Failed runs this recent are the sweep's; older ones were the last sweeps'. */
export const FAILED_RUN_WINDOW_MS = 2 * 60 * MINUTE;
/** A machine still below a floor this long after it was raised did not take it. */
export const LAGGARD_AFTER_MS = 30 * MINUTE;
/** Commits landed this recently are read for their sessions. */
export const RETIRE_WINDOW_MS = DAY;
const FAILED_RUNS_READ = 100;
const LATE_COMMITS_READ = 200;
const RETIRE_COMMITS_READ = 300;
/** Sessions judged for retirement in one sweep: each judgment reads its commits, edits and liveness. */
const RETIRE_SESSIONS_MAX = 12;
/** A target with no deploy open and none in a week is dormant (deployReach): it ships rarely and holds nothing up. */
const DORMANT_MS = 7 * DAY;

export type LateTarget = { target: string; repository: string; commits: number; oldest_sha: string; waiting_since: number; deadline_ms: number; open: { short_id: string; status: string } | null };
export type FailedRun = { run_id: Id<"workflow_runs">; task_short_id: string; flow: string; station: string; reason: string | null; failed_at: number };
export type Laggard = { device_id: string; label: string; owner: string; own: boolean; cli_version: string | null; floor: string; floor_set_at: number | null };
export type Unretired = { conversation_id: Id<"conversations">; short_id: string; title: string | null };
export type ReleaseSweep = { workspace: string; checked_at: number; incidents: FlowStopIncident[]; late_targets: LateTarget[]; failed_runs: FailedRun[]; laggards: Laggard[]; unretired: Unretired[] };

/** Whether a failed run was stopped by a person or the system's own cancel, not by its pipeline. */
const isCancelled = (failReason: string | undefined) => /^cancell?ed\b/i.test(failReason ?? "");

async function lateTargets(ctx: any, workspace: string, now: number): Promise<LateTarget[]> {
  const out: LateTarget[] = [];
  for (const t of await targetRows(ctx, workspace)) {
    const deploys: Doc<"deploys">[] = (await targetDeploys(ctx, workspace, t.name)).filter((d) => !d.repository || d.repository === t.repository);
    const open = deploys.find((d) => d.status === "requested" || d.status === "running") ?? null;
    if (!open && !deploys.some((d) => now - d.created_at < DORMANT_MS)) continue;
    const live = liveDeployOf(deploys);
    const from = live?.sha ? await commitBySha(ctx, t.repository, live.sha) : null;
    // No live deploy on main as codecast knows it: nothing to measure the wait from.
    if (from?.main_at == null) continue;
    // The target's own `deadline` stays on the CLI (CLI_ONLY_TARGET_KEYS); the server holds it to the default for its kind.
    const deadline = deployDeadlineMs(t, t.runs === "here" && t.policy === "press");
    const due: Doc<"commits">[] = await ctx.db
      .query("commits")
      .withIndex("by_repository_main", (q: any) => q.eq("repository", t.repository).gt("main_at", from.main_at).lte("main_at", now - deadline))
      .take(LATE_COMMITS_READ);
    const late = due.filter((c) => commitTouchesTarget(t.paths, (c.files ?? []).map((f) => f.filename)));
    if (!late.length) continue;
    out.push({ target: t.name, repository: t.repository, commits: late.length, oldest_sha: late[0].sha, waiting_since: late[0].main_at!, deadline_ms: deadline, open: open ? { short_id: open.short_id, status: open.status } : null });
  }
  return out;
}

async function failedRuns(ctx: any, workspace: string, now: number): Promise<FailedRun[]> {
  const rows: Doc<"workflow_runs">[] = await ctx.db
    .query("workflow_runs")
    .withIndex("by_workspace_status_updated", (q: any) => q.eq("workspace", workspace).eq("status", "failed").gt("updated_at", now - FAILED_RUN_WINDOW_MS))
    .order("desc")
    .take(FAILED_RUNS_READ);
  const out: FailedRun[] = [];
  for (const run of rows) {
    // An incident's runs are listed under it; a queued resume is already acted on; a run with no task cannot be resumed.
    if (run.incident_task_id || run.resume_queued || !run.task_id || isCancelled(run.fail_reason)) continue;
    // A stop is @release's only at a shared exit (its fingerprint), held while no second change shares it.
    if (isFlowStop(run.fail_reason) && !run.stop_fingerprint) continue;
    const task: Doc<"tasks"> | null = await ctx.db.get(run.task_id);
    if (!task || isTerminalTaskStatus(task.status)) continue;
    // A later run of the same task is the re-run: this one is history.
    const newer = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", run.task_id)).order("desc").first();
    if (newer && String(newer._id) !== String(run._id)) continue;
    const wf: Doc<"workflows"> | null = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
    out.push({
      run_id: run._id,
      task_short_id: task.short_id,
      flow: wf?.name ?? run.workflow_name ?? "flow",
      station: run.stop_station ?? stopStationOf(run.node_statuses, run.current_node_id ?? "", wf?.nodes ?? []),
      reason: run.fail_reason ?? null,
      failed_at: run.updated_at,
    });
  }
  return out;
}

async function laggards(ctx: any, workspace: string, viewer: Id<"users">, now: number): Promise<Laggard[]> {
  const ws = parseWorkspaceKey(workspace);
  if (ws?.type !== "team") return [];
  const team: Doc<"teams"> | null = await ctx.db.get(ws.teamId);
  if (!team) return [];
  const global = await ctx.db.query("system_config").withIndex("by_key", (q: any) => q.eq("key", "min_cli_version")).unique();
  // A floor with no time (set before it was kept) counts as raised long ago.
  const floors = [
    ...(global?.value ? [{ version: global.value as string, at: (global.updated_at as number | undefined) ?? null }] : []),
    ...(team.min_cli_version ? [{ version: team.min_cli_version, at: team.min_cli_version_at ?? null }] : []),
  ].filter((f) => f.at == null || now - f.at >= LAGGARD_AFTER_MS);
  const byDevice = new Map<string, Laggard>();
  for (const f of floors) {
    for (const d of (await teamFleet(ctx, team, f.version, now)).lagging) {
      const seen = byDevice.get(d.device_id);
      if (seen && !isBelowMinimum(seen.floor, f.version)) continue;
      byDevice.set(d.device_id, { device_id: d.device_id, label: d.label, owner: d.owner, own: String(d.user_id) === String(viewer), cli_version: d.cli_version, floor: f.version, floor_set_at: f.at });
    }
  }
  return [...byDevice.values()];
}

async function unretired(ctx: any, workspace: string, viewer: Id<"users">, now: number): Promise<Unretired[]> {
  const repositories = [...new Set((await targetRows(ctx, workspace)).map((t) => t.repository))];
  const sessions: Id<"conversations">[] = [];
  for (const repository of repositories) {
    const commits: Doc<"commits">[] = await ctx.db
      .query("commits")
      .withIndex("by_repository_main", (q: any) => q.eq("repository", repository).gt("main_at", now - RETIRE_WINDOW_MS))
      .order("desc")
      .take(RETIRE_COMMITS_READ);
    for (const c of commits) if (c.conversation_id && !sessions.some((s) => String(s) === String(c.conversation_id))) sessions.push(c.conversation_id);
  }
  const out: Unretired[] = [];
  let judged = 0;
  for (const id of sessions) {
    const conv: Doc<"conversations"> | null = await ctx.db.get(id);
    // Retired already: the common case, read for nothing more.
    if (!conv || conv.inbox_killed_at) continue;
    if (!(await canAccessConversation(ctx, viewer, conv as any))) continue;
    if (++judged > RETIRE_SESSIONS_MAX) break;
    if ((await liveRetireRefusal(ctx, conv, now, { workspace })) === null) out.push({ conversation_id: conv._id, short_id: conv.short_id ?? String(conv._id).slice(0, 7), title: conv.title ?? null });
  }
  return out;
}

export async function releaseSweepOf(ctx: any, workspace: string, viewer: Id<"users">, now: number): Promise<ReleaseSweep> {
  return {
    workspace,
    checked_at: now,
    incidents: await openFlowStopIncidents(ctx, workspace),
    late_targets: await lateTargets(ctx, workspace, now),
    failed_runs: await failedRuns(ctx, workspace, now),
    laggards: await laggards(ctx, workspace, viewer, now),
    unretired: await unretired(ctx, workspace, viewer, now),
  };
}

export const sweep = query({
  args: { api_token: v.string(), workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args): Promise<ReleaseSweep> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new ConvexError("Unauthorized");
    const { db } = await createWorkContext(ctx, { userId: auth.userId, workspace: args.workspace, team_id: args.team_id });
    return await releaseSweepOf(ctx, db.workspaceKey, auth.userId, Date.now());
  },
});
