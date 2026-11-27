// Run-stop incidents. A run its flow stopped (a stop exit, `fail_reason`
// "Stopped: ...") records the station to resume it at. A stop at an exit the
// flow marks `shared` (the pipeline every change goes through: main red, CI
// that never reports, a deploy that failed) also records a fingerprint and
// files a flowstop signal, held while it is the only change stopped that way.
// Once held or attached stops come from two runs on two different tasks, their
// cause is an incident: it goes to the workspace's @release, every run it holds
// is marked with it, and each run's task waits on it. Ground and the line leave
// it alone (holdsFlowStop). When it closes, each of those runs still stopped by
// it resumes at its station: queued where a line carries out the queue, else at
// once on its machine. A stop that says something about the change itself
// (a rejection, findings, a conflict) is never an incident, however alike its
// words read across changes.
import { ConvexError, v } from "convex/values";
import { internalMutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { createDataContext, createWorkContext } from "./data";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { liveRoleByHandle } from "./lib/orgAccess";
import { siteUrl } from "./lib/siteUrl";
import { runWorkflowOf } from "./lib/runGraph";
import { taskByRef } from "./lib/taskGraph";
import { workspaceHasFeature } from "./lib/teamFeatureGuard";
import { commitSignal, heldSignals, normalizeSignal, openCauseOfHeld } from "./signals";
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

type StationRow = { node_id: string; status: string; outcome?: string; completed_at?: number };
/** What a stop reads of the run's graph (cli graphPayload.ts); a graph pushed before these were sent has none. */
type StopNode = { id: string; type?: string; shared?: boolean; segment?: string; segment_exit?: string; fold?: boolean };

const latest = <N extends StationRow>(rows: N[]): N | undefined =>
  rows.reduce<N | undefined>((best, n) => (!best || (n.completed_at ?? 0) >= (best.completed_at ?? 0) ? n : best), undefined);

/**
 * Where a run stopped, read against its graph. `shared`: the exit it ended at
 * is marked shared, or (a flow that routes every segment stop to one generic
 * exit, as Union's `stopped`) the segment exit step it left by is. `station`:
 * where a resume starts, the station that failed last, never the end, a
 * segment's exit step (it only echoes the exit and fails again), an exit, a
 * fan-in or a bookkeeping station, nor one the run's end closed; else the
 * segment the stop came out of, from its entry; else the station it reached
 * last; else the end itself.
 */
export function stopOf(rows: ReadonlyArray<StationRow>, endNodeId: string, graph: ReadonlyArray<StopNode> = []): { station: string; shared: boolean } {
  const byId = new Map(graph.map((n) => [n.id, n]));
  const end = byId.get(endNodeId);
  const visited = rows.filter((n) => n.node_id !== endNodeId);
  // A station still running when the run ended is closed as failed with outcome "stopped" (lib/runEnd.ts): it did not fail.
  const failed = visited.filter((n) => n.status === "failed" && n.outcome !== "stopped");
  const via = end?.type === "exit" ? byId.get(latest(failed.filter((n) => byId.get(n.node_id)?.segment_exit === "stop"))?.node_id ?? "") : undefined;
  const resumable = (n: StationRow) => {
    const g = byId.get(n.node_id);
    return !g || (!g.segment_exit && g.type !== "exit" && g.type !== "parallel_fanin" && !g.fold);
  };
  const station = latest(failed.filter(resumable))?.node_id ?? via?.segment ?? end?.segment ?? latest(visited.filter(resumable))?.node_id ?? endNodeId;
  return { station, shared: !!end?.shared || !!via?.shared };
}

/** The station a stop resumes at (stopOf); `cast release sweep` names it for a run that recorded none. */
export const stopStationOf = (rows: ReadonlyArray<StationRow>, endNodeId: string, graph: ReadonlyArray<StopNode> = []): string => stopOf(rows, endNodeId, graph).station;

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
  const wf: Doc<"workflows"> | null = await runWorkflowOf(ctx, run);
  const nodes = (wf?.nodes ?? []) as Array<StopNode & { label?: string }>;
  const { station, shared } = stopOf(run.node_statuses, run.current_node_id ?? "", nodes);
  const flow = wf?.name ?? run.workflow_name ?? "flow";
  const reason = run.fail_reason!.slice(STOP_PREFIX.length).trim();
  // Only a stop of the shared pipeline is keyed: a stop about this change keeps no key a later stop could match.
  const fingerprint = shared ? flowStopFingerprint((await repositoryOfRun(ctx, run)) ?? "", flow, station, reason) : undefined;
  await ctx.db.patch(run._id, { stop_station: station, stop_fingerprint: fingerprint });
  if (!fingerprint) return null;

  const db = await createDataContext(ctx, ws.type === "team" ? { userId: run.user_id, workspace: "team", team_id: ws.teamId } : { userId: run.user_id, workspace: "personal" });
  if (db.workspaceKey !== run.workspace) return null;
  const stationLabel = nodes.find((n) => n.id === station)?.label ?? station;
  const signal = normalizeSignal({
    source: FLOW_STOP_SOURCE,
    kind: "flowstop",
    fingerprint,
    title: `${wf?.label || flow} stopped at ${stationLabel}: ${reason}`,
    detail_md: reason,
    evidence_url: `${siteUrl()}${runPath(run._id)}`,
    subject: station,
    observed_at: now,
  });
  // No judge: a stop joins only the cause holding its exact fingerprint, else it is held (flowstop opens no cause).
  const filed = await commitSignal(ctx, db, run.user_id, signal, null, now);
  // Held: the stops held under its key open their cause once they come from two changes.
  const causeId = filed.task_id ?? ((await stopsOfTasks(ctx, await heldSignals(ctx, db.workspaceKey, fingerprint))).tasks.size >= 2 ? await openCauseOfHeld(ctx, db, signal, now) : null);
  if (causeId) await openIncidentIfShared(ctx, causeId, now);
  return causeId;
}

/** The runs some flowstop signals are about that are still stopped by them (failed, last stop under that signal's key), and their tasks. */
async function stopsOfTasks(ctx: any, rows: Doc<"signals">[]): Promise<{ runs: Doc<"workflow_runs">[]; tasks: Set<string> }> {
  const runs = new Map<string, Doc<"workflow_runs">>();
  for (const row of rows) {
    if (row.source !== FLOW_STOP_SOURCE) continue;
    const id = runIdOfSignal(ctx, row);
    if (!id || runs.has(String(id))) continue;
    const run: Doc<"workflow_runs"> | null = await ctx.db.get(id);
    if (run?.status === "failed" && run.task_id && run.stop_fingerprint === row.fingerprint) runs.set(String(id), run);
  }
  return { runs: [...runs.values()], tasks: new Set([...runs.values()].map((r) => String(r.task_id))) };
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
  const rows: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", cause._id)).order("desc").take(CAUSE_SIGNALS_READ);
  const { runs, tasks } = await stopsOfTasks(ctx, rows);
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

/** Whether a run marked with an incident is still stopped by it: failed at a stop under one of the cause's keys. */
const stoppedBy = (run: Doc<"workflow_runs">, cause: Pick<Doc<"tasks">, "cause">) =>
  run.status === "failed" && isFlowStop(run.fail_reason) && !!run.stop_fingerprint && (cause.cause?.fingerprints ?? []).includes(run.stop_fingerprint);

/** Whether a line carries out the run's queued resume (orgLine.planQueuedResumes): a role's run, where lines run. */
async function lineResumes(ctx: any, run: Doc<"workflow_runs">): Promise<boolean> {
  const role: Doc<"org_roles"> | null = run.org_role_id ? await ctx.db.get(run.org_role_id) : null;
  if (!role) return false;
  const ws = { team_id: role.team_id ?? null, user_id: role.team_id ? null : (role.scope_user_id ?? null) };
  return (await workspaceHasFeature(ctx, ws, "line")) && (await workspaceHasFeature(ctx, ws, "org"));
}

/**
 * A cause closed (taskWaits.releaseDependents; `cause` is its row before the
 * move). Dropped as another's duplicate, it is not fixed: its runs move to the
 * cause it duplicates, whose blockers their tasks already took
 * (taskLinks.dropDuplicate). Else each run it holds that it still stops
 * resumes at its station: queued for a line's run where a line carries out the
 * queue, else at once on its machine, as `cast workflow resume --at` does. A
 * run resumed, completed (a later deploy took its change live), queued since,
 * or stopped since by something else is left as it is, as is one that cannot
 * be resumed from here (no machine, a trial's, its task closed).
 */
export async function settleIncidentRuns(ctx: any, cause: Doc<"tasks">, now = Date.now()): Promise<Id<"workflow_runs">[]> {
  const runs: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_incident_status", (q: any) => q.eq("incident_task_id", cause._id).eq("status", "failed")).collect();
  if (!runs.length) return [];
  const closed: Doc<"tasks"> | null = await ctx.db.get(cause._id);
  const survivor = closed?.status === "dropped" && closed.duplicate_of ? await taskByRef(ctx, closed.duplicate_of) : null;
  if (survivor && survivor._id !== cause._id && !isTerminalTaskStatus(survivor.status)) {
    for (const run of runs) await ctx.db.patch(run._id, { incident_task_id: survivor._id });
    await openIncidentIfShared(ctx, survivor._id, now);
    return [];
  }
  const resumed: Id<"workflow_runs">[] = [];
  for (const run of runs) {
    if (run.resume_queued || !run.stop_station || !stoppedBy(run, cause)) continue;
    try {
      await resumeFailedRunCore(ctx, run.user_id, run._id, run.stop_station, { queue: await lineResumes(ctx, run) }, now);
      resumed.push(run._id);
    } catch (e) {
      // Its refusals come before any write, so the close goes on without it.
      if (!(e instanceof ConvexError)) throw e;
    }
  }
  return resumed;
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
 * that still stop runs marked with them. What `cast release sweep` lists.
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
    const marked: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_incident_status", (q: any) => q.eq("incident_task_id", cause._id).eq("status", "failed")).collect();
    const runs = marked.filter((r) => stoppedBy(r, cause));
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
