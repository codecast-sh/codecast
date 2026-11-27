// Run-stop incidents. A run its flow stopped (a stop exit, `fail_reason`
// "Stopped: ...") records the station that failed it and a fingerprint of the
// stop, and files a flowstop signal through the signal door, so the same stop
// on many changes reaches one cause task in the workspace. Once that cause
// holds stops of two runs on two different tasks, it is an incident: it goes
// to the workspace's @release, every run it holds is marked with it, and each
// run's task waits on it. When the cause closes, each of those runs that is
// still stopped is queued to resume at its station (failedRunResume's queue,
// which the line's sweep carries out).
import { ConvexError, v } from "convex/values";
import { internalMutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { createDataContext, createWorkContext } from "./data";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { liveRoleByHandle } from "./lib/orgAccess";
import { siteUrl } from "./lib/siteUrl";
import { commitSignal, normalizeSignal } from "./signals";
import { addDepCore, handTask } from "./tasks";
import { resumeFailedRunCore } from "./failedRunResume";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { FLOW_STOP_SOURCE, flowStopFingerprint } from "@codecast/shared/contracts/signalFingerprint";
import { extractRepoFromRemoteUrl } from "@codecast/shared/contracts";

const STOP_PREFIX = "Stopped: ";
const RELEASE_HANDLE = "release";
/** The newest signals of one cause read to find the runs it holds. */
const CAUSE_SIGNALS_READ = 200;
/** The newest flowstop signals of a workspace read to find its open incidents. */
const WORKSPACE_STOPS_READ = 500;

/** A run that ended at a stop exit of its graph (runner.ts), not one cancelled or crashed. */
export const isFlowStop = (failReason: string | undefined): boolean => !!failReason?.startsWith(STOP_PREFIX);

/**
 * The station a stop came from: the station that failed last, other than the
 * node the run ended on (the stop exit itself, or the station that ran out of
 * visits), else that node. A flow that routes every failure to one generic
 * exit (Union's `stopped`) still names the station that failed.
 */
export function stopStationOf(nodes: ReadonlyArray<{ node_id: string; status: string; completed_at?: number }>, endNodeId: string): string {
  let best: { node_id: string; completed_at?: number } | null = null;
  for (const n of nodes) {
    if (n.status !== "failed" || n.node_id === endNodeId) continue;
    if (!best || (n.completed_at ?? 0) >= (best.completed_at ?? 0)) best = n;
  }
  return best?.node_id ?? endNodeId;
}

const runPath = (runId: Id<"workflow_runs">) => `/workflows/runs/${runId}`;

/** The run a flowstop signal is about: its evidence is the run's page. */
function runIdOfSignal(ctx: { db: any }, row: Doc<"signals">): Id<"workflow_runs"> | null {
  const m = row.evidence_url?.match(/\/workflows\/runs\/([^/?#]+)$/);
  return m ? ctx.db.normalizeId("workflow_runs", m[1]) : null;
}

/** The GitHub repository a run works in: its pull request's, else its sessions' remote. */
async function repositoryOfRun(ctx: { db: any }, run: Doc<"workflow_runs">): Promise<string | null> {
  if (run.pr?.repository) return run.pr.repository;
  for (const id of [run.spawner_conversation_id, run.primary_conversation_id]) {
    const conv = id ? await ctx.db.get(id) : null;
    const repo = extractRepoFromRemoteUrl(conv?.git_remote_url);
    if (repo) return repo;
  }
  return null;
}

/** A run's stop, recorded and filed; scheduled by workflow_runs.updateProgress so nothing here can fail the runner's report. */
export const recordStop = internalMutation({
  args: { run_id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    await recordRunStop(ctx, args.run_id, Date.now());
  },
});

export async function recordRunStop(ctx: any, runId: Id<"workflow_runs">, now: number): Promise<Id<"tasks"> | null> {
  const run: Doc<"workflow_runs"> | null = await ctx.db.get(runId);
  if (!run || run.status !== "failed" || !isFlowStop(run.fail_reason)) return null;
  const ws = parseWorkspaceKey(run.workspace);
  if (!ws) return null;
  const station = stopStationOf(run.node_statuses, run.current_node_id ?? "");
  const wf: Doc<"workflows"> | null = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
  const flow = wf?.name ?? run.workflow_name ?? "flow";
  const reason = run.fail_reason!.slice(STOP_PREFIX.length).trim();
  const fingerprint = flowStopFingerprint((await repositoryOfRun(ctx, run)) ?? "", flow, station, reason);
  await ctx.db.patch(run._id, { stop_station: station, stop_fingerprint: fingerprint });

  const db = await createDataContext(ctx, ws.type === "team" ? { userId: run.user_id, workspace: "team", team_id: ws.teamId } : { userId: run.user_id, workspace: "personal" });
  if (db.workspaceKey !== run.workspace) return null;
  const stationLabel = (wf?.nodes as Array<{ id: string; label?: string }> | undefined)?.find((n) => n.id === station)?.label ?? station;
  const link = `${siteUrl()}${runPath(run._id)}`;
  // No judge: a stop joins only the cause holding its exact fingerprint, else opens one.
  const filed = await commitSignal(ctx, db, run.user_id, normalizeSignal({
    source: FLOW_STOP_SOURCE,
    kind: "flowstop",
    fingerprint,
    title: `${wf?.label || flow} stopped at ${stationLabel}: ${reason}`,
    detail_md: reason,
    evidence_url: link,
    subject: station,
    observed_at: now,
  }), null, now);
  if (filed.task_id) await openIncidentIfShared(ctx, filed.task_id, now);
  return filed.task_id ?? null;
}

/**
 * The runs a cause holds that are still stopped by it: each signal's run,
 * failed, whose last stop is the one that signal filed.
 */
async function stoppedRunsOf(ctx: any, cause: Doc<"tasks">): Promise<Doc<"workflow_runs">[]> {
  const rows: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", cause._id)).order("desc").take(CAUSE_SIGNALS_READ);
  const runs = new Map<string, Doc<"workflow_runs">>();
  for (const row of rows) {
    if (row.source !== FLOW_STOP_SOURCE) continue;
    const id = runIdOfSignal(ctx, row);
    if (!id || runs.has(String(id))) continue;
    const run: Doc<"workflow_runs"> | null = await ctx.db.get(id);
    if (run?.status === "failed" && run.task_id && run.stop_fingerprint === row.fingerprint) runs.set(String(id), run);
  }
  return [...runs.values()];
}

/**
 * A cause holding stops of two or more runs on different tasks is an
 * incident: assigned to the workspace's @release when it has one and nobody
 * holds it yet, and each run it holds marked with it and its task blocked by
 * it. One run stopping twice, or two runs of one task, is not an incident.
 * Every write is skipped when already made, so a repeat changes nothing.
 */
export async function openIncidentIfShared(ctx: any, causeId: Id<"tasks">, now: number): Promise<boolean> {
  const cause: Doc<"tasks"> | null = await ctx.db.get(causeId);
  if (!cause || isTerminalTaskStatus(cause.status)) return false;
  const runs = await stoppedRunsOf(ctx, cause);
  const tasks = new Set(runs.map((r) => String(r.task_id)));
  if (tasks.size < 2) return false;
  if (!cause.assignee) {
    const ws = parseWorkspaceKey(cause.workspace);
    const release = ws ? await liveRoleByHandle(ctx, ws.type === "team" ? { team_id: ws.teamId } : { scope_user_id: ws.userId }, RELEASE_HANDLE) : null;
    if (release) await handTask(ctx, cause, String(release._id), runs[0].user_id, `The same stop on ${tasks.size} changes`, now);
  }
  for (const run of runs) {
    if (String(run.incident_task_id ?? "") === String(causeId)) continue;
    await ctx.db.patch(run._id, { incident_task_id: causeId });
    const task: Doc<"tasks"> | null = await ctx.db.get(run.task_id!);
    if (task && !isTerminalTaskStatus(task.status)) await addDepCore(ctx, run.user_id, { short_id: task.short_id, blocked_by: cause.short_id });
  }
  return true;
}

/**
 * A cause closed (taskWaits.releaseDependents): each run it held that is
 * still stopped is queued to resume at the station that stopped it. A run
 * resumed, completed (a later deploy took its change live) or queued since is
 * left as it is, as is one that cannot be resumed from here (no machine, a
 * trial's, its task closed).
 */
export async function resumeIncidentRuns(ctx: any, cause: Pick<Doc<"tasks">, "_id">, now = Date.now()): Promise<Id<"workflow_runs">[]> {
  const runs: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_incident_status", (q: any) => q.eq("incident_task_id", cause._id).eq("status", "failed")).collect();
  const queued: Id<"workflow_runs">[] = [];
  for (const run of runs) {
    if (run.resume_queued || !run.stop_station || !isFlowStop(run.fail_reason)) continue;
    try {
      await resumeFailedRunCore(ctx, run.user_id, run._id, run.stop_station, { queue: true }, now);
      queued.push(run._id);
    } catch (e) {
      // Its refusals come before any write, so the close goes on without it.
      if (!(e instanceof ConvexError)) throw e;
    }
  }
  return queued;
}

export type FlowStopIncident = {
  task_id: Id<"tasks">;
  short_id: string;
  title: string;
  status: string;
  assignee: string | null;
  runs: Array<{ run_id: Id<"workflow_runs">; task_short_id: string | null; station: string | null; stopped_at: number }>;
};

/**
 * The workspace's open incidents: open causes its flowstop signals reached
 * that still hold stopped runs. What `cast release sweep` lists.
 */
export async function openFlowStopIncidents(ctx: any, workspace: string): Promise<FlowStopIncident[]> {
  const rows: Doc<"signals">[] = await ctx.db
    .query("signals")
    .withIndex("by_workspace_source_created", (q: any) => q.eq("workspace", workspace).eq("source", FLOW_STOP_SOURCE))
    .order("desc")
    .take(WORKSPACE_STOPS_READ);
  const out: FlowStopIncident[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.task_id || seen.has(String(row.task_id))) continue;
    seen.add(String(row.task_id));
    const cause: Doc<"tasks"> | null = await ctx.db.get(row.task_id);
    if (!cause || isTerminalTaskStatus(cause.status)) continue;
    const runs: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_incident_status", (q: any) => q.eq("incident_task_id", cause._id).eq("status", "failed")).collect();
    if (!runs.length) continue;
    out.push({
      task_id: cause._id,
      short_id: cause.short_id,
      title: cause.title,
      status: cause.status,
      assignee: cause.assignee ?? null,
      runs: await Promise.all(runs.map(async (r) => ({
        run_id: r._id,
        task_short_id: r.task_id ? ((await ctx.db.get(r.task_id)) as Doc<"tasks"> | null)?.short_id ?? null : null,
        station: r.stop_station ?? null,
        stopped_at: r.updated_at,
      }))),
    });
  }
  return out;
}

export const openIncidentsForCli = query({
  args: { api_token: v.string(), workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args): Promise<FlowStopIncident[]> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new ConvexError("Unauthorized");
    const { db } = await createWorkContext(ctx, { userId: auth.userId, workspace: args.workspace, team_id: args.team_id });
    return await openFlowStopIncidents(ctx, db.workspaceKey);
  },
});
