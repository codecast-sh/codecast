// Run-stop incidents. A run its flow stopped (a stop exit, `fail_reason`
// "Stopped: ...") records the station to resume it at. A stop at an exit the
// flow marks `shared` (the pipeline every change goes through: main red, CI
// that never reports, a deploy that failed) also records a fingerprint, keyed
// by the repository and the breakage the exit names (`shared="main_red"`), and
// files a flowstop signal, held while it is the only change
// stopped that way. Once held or attached stops come from two runs on two
// different open tasks, each its task's newest run and stopped within a day,
// their cause is an incident: it goes to the workspace's @release, every run it
// holds is marked with it, and each run's task waits on it. Ground and the line
// leave it alone (holdsFlowStop). When it closes, each of those runs still
// stopped by it, and not replaced by a newer run of its task, resumes at its
// station: queued where a line carries out the queue, else at once on its
// machine. A stop that says something about the change itself (a rejection,
// findings, a conflict) is never an incident, however alike its words read
// across changes.
import { ConvexError, v } from "convex/values";
import { internalMutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { createDataContext, createWorkContext } from "./data";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { isSameWorkspace } from "./lib/access";
import { liveRoleByHandle } from "./lib/orgAccess";
import { workspaceKeyHasFeature } from "./lib/teamFeatureGuard";
import { siteUrl } from "./lib/siteUrl";
import { runWorkflowOf } from "./lib/runGraph";
import { openUpstream, taskByRef } from "./lib/taskGraph";
import { commitSignal, heldSignals, moveProblemSignals, normalizeSignal, openCauseOfHeld } from "./signals";
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
/** The runs one incident marks, read at once. */
const INCIDENT_RUNS_READ = 200;
/** The stop text an incident's title carries; a station's whole output (main's CI log) belongs in its detail. */
const STOP_TITLE_CHARS = 200;
/** A breakage name an incident's title may carry: the parser's `shared="main_red"`, or an exit's id. Checked here, since a graph is what a client pushed. */
const BREAKAGE_NAME = /^[A-Za-z0-9_]{1,64}$/;
/**
 * How long a stop no incident holds yet counts toward one. A broken shared
 * pipeline stops the next changes through it within hours; a day still spans a
 * night with no changes running, and an older stop says nothing about now.
 */
export const LIVE_STOP_MS = 24 * 60 * 60_000;

/** A run that ended at a stop exit of its graph (runner.ts), not one cancelled or crashed. */
export const isFlowStop = (failReason: string | undefined): boolean => !!failReason?.startsWith(STOP_PREFIX);

type StationRow = { node_id: string; status: string; outcome?: string; completed_at?: number };
/** What a stop reads of the run's graph (cli graphPayload.ts); a graph pushed before these were sent has none. */
type StopNode = { id: string; type?: string; shared?: boolean | string; resume?: string; segment?: string; segment_exit?: string; fold?: boolean };

const latest = <N extends StationRow>(rows: N[]): N | undefined =>
  rows.reduce<N | undefined>((best, n) => (!best || (n.completed_at ?? 0) >= (best.completed_at ?? 0) ? n : best), undefined);

/**
 * Where a run stopped, read against its graph. `sharedExit`: the exit it ended
 * at when that is marked shared, else (a flow that routes every segment stop to
 * one generic exit, as Union's `stopped`) the segment exit step it left by when
 * that is; null for a stop about the change itself. `breakage`: what that exit
 * names (`shared="main_red"`), else (`shared=true`) its own id. `station`:
 * where a resume starts, the station that exit (or that step) names in
 * `resume`, else the station that failed last, never the end, a
 * segment's exit step (it only echoes the exit and fails again), an exit, a
 * fan-in or a bookkeeping station, nor one the run's end closed; else the
 * segment the stop came out of, from its entry; else the station it reached
 * last; else the end itself.
 */
export function stopOf(rows: ReadonlyArray<StationRow>, endNodeId: string, graph: ReadonlyArray<StopNode> = []): { station: string; sharedExit: string | null; breakage: string | null } {
  const byId = new Map(graph.map((n) => [n.id, n]));
  const end = byId.get(endNodeId);
  const visited = rows.filter((n) => n.node_id !== endNodeId);
  // A station still running when the run ended is closed as failed with outcome "stopped" (lib/runEnd.ts): it did not fail.
  const failed = visited.filter((n) => n.status === "failed" && n.outcome !== "stopped");
  // A resume keeps the failed rows of the stop before it, so an exit step counts only when it is the last station the
  // run reached before its end: an older one says nothing about a later stop through another station.
  const exitStep = latest(failed.filter((n) => byId.get(n.node_id)?.segment_exit === "stop"));
  const lastReached = latest(visited.filter((n) => n.outcome !== "stopped"));
  const via = end?.type === "exit" && exitStep && exitStep === lastReached ? byId.get(exitStep.node_id) : undefined;
  const resumable = (n: StationRow) => {
    const g = byId.get(n.node_id);
    return !g || (!g.segment_exit && g.type !== "exit" && g.type !== "parallel_fanin" && !g.fold);
  };
  const station = end?.resume ?? via?.resume ?? latest(failed.filter(resumable))?.node_id ?? via?.segment ?? end?.segment ?? latest(visited.filter(resumable))?.node_id ?? endNodeId;
  const exit = end?.shared ? end : via?.shared ? via : null;
  return { station, sharedExit: exit?.id ?? null, breakage: exit ? (typeof exit.shared === "string" ? exit.shared : exit.id) : null };
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
  const { station, sharedExit, breakage } = stopOf(run.node_statuses, run.current_node_id ?? "", nodes);
  const reason = run.fail_reason!.slice(STOP_PREFIX.length).trim();
  // Only a stop of the shared pipeline is keyed, by the breakage its exit names, never by the flow: every flow
  // composing one segment, and every exit meaning one breakage, meet in one cause. A stop about this change keeps no
  // key a later stop could match.
  const fingerprint = breakage ? flowStopFingerprint((await repositoryOfRun(ctx, run)) ?? "", breakage) : undefined;
  await ctx.db.patch(run._id, { stop_station: station, stop_fingerprint: fingerprint });
  if (!fingerprint) return null;

  const db = await createDataContext(ctx, ws.type === "team" ? { userId: run.user_id, workspace: "team", team_id: ws.teamId } : { userId: run.user_id, workspace: "personal" });
  if (db.workspaceKey !== run.workspace) return null;
  // Named for where it stopped (the shared exit), not where it resumes; the full stop text stays in the detail.
  const exitLabel = nodes.find((n) => n.id === sharedExit)?.label || sharedExit!;
  const stopText = reason.replace(/\s+/g, " ");
  const signal = normalizeSignal({
    source: FLOW_STOP_SOURCE,
    kind: "flowstop",
    fingerprint,
    title: stopText ? `${exitLabel}: ${stopText.length > STOP_TITLE_CHARS ? `${stopText.slice(0, STOP_TITLE_CHARS - 1)}…` : stopText}` : exitLabel,
    detail_md: reason,
    evidence_url: `${siteUrl()}${runPath(run._id)}`,
    subject: station,
    observed_at: now,
  });
  // No judge: a stop joins only the cause holding its exact fingerprint, else it is held (flowstop opens no cause).
  const filed = await commitSignal(ctx, db, run.user_id, signal, null, now);
  // Incidents are behind the workspace's run_incidents flag (Union first): off, the stop stays recorded and its
  // signal held, and no cause opens, nobody is handed one, no task is blocked.
  if (!(await workspaceKeyHasFeature(ctx, run.workspace, "run_incidents"))) return null;
  // Held: the live stops held under its key open their cause once they come from two changes; an older held stop
  // never joins, so neither the count nor the open reads a run per stop of any age. The cause's title is computed
  // from the breakage's name alone: it reaches @release's session (tasks.announceAssignment), where neither stop
  // text (station output) nor the flow file's labels may.
  const heldSince = now - LIVE_STOP_MS;
  const changes = filed.task_id ? 0 : (await stopsOfTasks(ctx, await heldSignals(ctx, db.workspaceKey, fingerprint, heldSince), now)).tasks.size;
  const title = `${breakage && BREAKAGE_NAME.test(breakage) ? breakage : "A shared stop"} on ${changes} changes`;
  const causeId = filed.task_id ?? (changes >= 2 ? await openCauseOfHeld(ctx, db, signal, now, { title, heldSince }) : null);
  if (causeId) await openIncidentIfShared(ctx, causeId, now);
  return causeId;
}

/**
 * Whether a stopped run still stands for its change: its task is open and no
 * newer run of the task replaced it. A superseded run's stop is history, and
 * resuming it would race the run that replaced it. Given the stop's
 * `workspace`, its task must be in it too.
 */
async function standsForTask(ctx: any, run: Doc<"workflow_runs">, workspace?: string): Promise<boolean> {
  if (!run.task_id) return false;
  const task: Doc<"tasks"> | null = await ctx.db.get(run.task_id);
  if (!task || isTerminalTaskStatus(task.status)) return false;
  // A task in another workspace than the stop's cannot wait on it (tasks.addDepCore refuses), so it is no part of it.
  if (workspace !== undefined) {
    const ws = parseWorkspaceKey(workspace);
    if (!ws || !isSameWorkspace(task, ws)) return false;
  }
  const newest: Doc<"workflow_runs"> | null = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", run.task_id)).order("desc").first();
  return String(newest?._id) === String(run._id);
}

/**
 * The runs some flowstop signals are about that are still stopped by them
 * (failed, last stop under that signal's key, standing for an open task), and
 * their tasks. A run counts only while its stop is live (LIVE_STOP_MS), or
 * once `causeId` already holds it: an incident keeps the runs it marked.
 */
async function stopsOfTasks(ctx: any, rows: Doc<"signals">[], now: number, causeId?: Id<"tasks">): Promise<{ runs: Doc<"workflow_runs">[]; tasks: Set<string> }> {
  const runs = new Map<string, Doc<"workflow_runs">>();
  for (const row of rows) {
    if (row.source !== FLOW_STOP_SOURCE) continue;
    const id = runIdOfSignal(ctx, row);
    if (!id || runs.has(String(id))) continue;
    const run: Doc<"workflow_runs"> | null = await ctx.db.get(id);
    if (run?.status !== "failed" || run.stop_fingerprint !== row.fingerprint) continue;
    // The fix shipped on the cause, stopping at the same exit, is the incident's own work: it cannot wait on itself.
    if (causeId && String(run.task_id) === String(causeId)) continue;
    const held =!!causeId && String(run.incident_task_id ?? "") === String(causeId);
    if (!held && now - run.updated_at > LIVE_STOP_MS) continue;
    if (await standsForTask(ctx, run, row.workspace)) runs.set(String(id), run);
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
  const { runs, tasks } = await stopsOfTasks(ctx, rows, now, causeId);
  if (tasks.size < 2) return false;
  if (!cause.assignee) {
    // Routing, so the team the cause flows to (team_id), never its access key.
    const release = await liveRoleByHandle(ctx, cause.team_id ? { team_id: cause.team_id } : { scope_user_id: cause.user_id }, RELEASE_HANDLE);
    if (release) await handTask(ctx, cause, String(release._id), runs[0].user_id, `The same stop on ${tasks.size} changes`, now);
  }
  // One run's edge never fails the stop (or the close) that got here. A task the cause already waits on (the fix
  // @release set it blocked by, stopping at the same exit) is the incident's own work, like the cause itself: never
  // marked, since its edge would close a loop. A graph too large to check marks the runs but adds no edge.
  const ws = parseWorkspaceKey(cause.workspace);
  const upstream = ws ? await openUpstream(ctx, cause, ws).catch(() => null) : null;
  for (const run of runs) {
    if (String(run.incident_task_id ?? "") === String(causeId)) continue;
    const task: Doc<"tasks"> | null = await ctx.db.get(run.task_id!);
    if (task && upstream?.has(task.short_id)) continue;
    await ctx.db.patch(run._id, { incident_task_id: causeId });
    if (!task || !upstream || isTerminalTaskStatus(task.status)) continue;
    try {
      await addDepCore(ctx, run.user_id, { short_id: task.short_id, blocked_by: cause.short_id });
    } catch (e) {
      console.error(`[flowStops] ${task.short_id} not blocked by ${cause.short_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return true;
}

/** Whether a run marked with an incident is still stopped by it: failed at a stop under one of the cause's keys. */
const stoppedBy = (run: Doc<"workflow_runs">, cause: Pick<Doc<"tasks">, "cause">) =>
  run.status === "failed" && isFlowStop(run.fail_reason) && !!run.stop_fingerprint && (cause.cause?.fingerprints ?? []).includes(run.stop_fingerprint);

/** Whether a line carries out the run's queued resume (orgLine.planQueuedResumes): a role's run, whether or not lines
 *  run now, so switching Flows off holds it until they are back on (linesRunIn's promise). */
async function lineResumes(ctx: any, run: Doc<"workflow_runs">): Promise<boolean> {
  return !!run.org_role_id && !!(await ctx.db.get(run.org_role_id));
}

/**
 * A cause closed (taskWaits.releaseDependents; `cause` is its row before the
 * move). Dropped as another's duplicate, or superseded by another, it is not
 * fixed: its runs and stops move to the task it names, whose blockers their
 * tasks already took (taskLinks.dropDuplicate, supersedeCore). Else each run it holds that it still stops is
 * resumed at its station by its own scheduled mutation (resumeIncidentRun), so
 * an incident holding dozens of runs never runs them all inside the close.
 * Returns the runs scheduled.
 */
export async function settleIncidentRuns(ctx: any, cause: Doc<"tasks">, now = Date.now()): Promise<Id<"workflow_runs">[]> {
  const runs: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_incident_status", (q: any) => q.eq("incident_task_id", cause._id).eq("status", "failed")).take(INCIDENT_RUNS_READ);
  if (!runs.length) return [];
  const closed: Doc<"tasks"> | null = await ctx.db.get(cause._id);
  const next = closed?.status === "dropped" ? closed.duplicate_of ?? closed.superseded_by : undefined;
  const survivor = next ? await taskByRef(ctx, next) : null;
  if (closed && survivor && survivor._id !== cause._id && survivor.workspace === closed.workspace && !isTerminalTaskStatus(survivor.status)) {
    // Its stops and their keys go with the runs (a merge moved them already), so the survivor still stops them
    // (stoppedBy), the sweep lists it, and its close resumes them, even when it is a task a person filed.
    await moveProblemSignals(ctx, closed.user_id, closed, survivor, now);
    for (const run of runs) await ctx.db.patch(run._id, { incident_task_id: survivor._id });
    await openIncidentIfShared(ctx, survivor._id, now);
    return [];
  }
  const scheduled: Id<"workflow_runs">[] = [];
  for (const run of runs) {
    if (run.resume_queued || !run.stop_station || !stoppedBy(run, cause)) continue;
    await ctx.scheduler.runAfter(0, internal.flowStops.resumeIncidentRun, { run_id: run._id, cause_id: cause._id });
    scheduled.push(run._id);
  }
  return scheduled;
}

/**
 * One run a closed incident stopped, resumed at its station: queued for a
 * line's run where a line carries out the queue, else at once on its machine,
 * as `cast workflow resume --at` does. Read again here, since the run may have
 * moved since the close: a run resumed, completed (a later deploy took its
 * change live), queued since, stopped since by something else, or replaced by
 * a newer run of its task is left as it is, as is one that cannot be resumed
 * from here (no machine, a trial's, its task closed).
 */
export const resumeIncidentRun = internalMutation({
  args: { run_id: v.id("workflow_runs"), cause_id: v.id("tasks") },
  handler: async (ctx, args): Promise<boolean> => {
    const run: Doc<"workflow_runs"> | null = await ctx.db.get(args.run_id);
    const cause: Doc<"tasks"> | null = await ctx.db.get(args.cause_id);
    if (!run || !cause || run.resume_queued || !run.stop_station || String(run.incident_task_id ?? "") !== String(cause._id) || !stoppedBy(run, cause)) return false;
    if (!(await standsForTask(ctx, run))) return false;
    try {
      await resumeFailedRunCore(ctx, run.user_id, run._id, run.stop_station, { queue: await lineResumes(ctx, run) });
      return true;
    } catch (e) {
      // Its refusals come before any write, so nothing is left half done.
      if (!(e instanceof ConvexError)) throw e;
      return false;
    }
  },
});

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
 * that still stop runs marked with them, each the newest run of an open task.
 * What `cast release sweep` lists.
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
    const marked: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_incident_status", (q: any) => q.eq("incident_task_id", cause._id).eq("status", "failed")).take(INCIDENT_RUNS_READ);
    const runs: FlowStopIncident["runs"] = [];
    for (const r of marked) {
      if (!stoppedBy(r, cause) || !(await standsForTask(ctx, r))) continue;
      const task: Doc<"tasks"> | null = await ctx.db.get(r.task_id!);
      runs.push({ run_id: r._id, task_short_id: task?.short_id ?? null, station: r.stop_station ?? null, stopped_at: r.updated_at });
    }
    if (!runs.length) continue;
    out.push({ task_id: cause._id, short_id: cause.short_id, title: cause.title, status: cause.status, assignee: cause.assignee ?? null, runs });
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
