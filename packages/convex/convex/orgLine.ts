import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import { isWholeWorkspaceRole } from "@codecast/shared/contracts/orgLead";
import { lineStartsOn } from "@codecast/shared/contracts/roleAutonomy";
import { isTerminalTaskStatus, isUnblocked } from "@codecast/shared/tasks";
import { readinessLookups } from "./lib/taskGraph";
import type { Id } from "./_generated/dataModel";
import { resolveScope } from "./org";
import { capsFor, countersFor, utcDay } from "./lib/orgCaps";
import { flowAdmits, flowHands, flowHold, liveFlowFor, planLiveFlow } from "./liveFlows";
import { atCap } from "@codecast/shared/contracts/orgCapacity";
import { recordHandStart } from "./spawn";
import { insertTaskComment, moveTaskStatus } from "./tasks";
import { createRunCore, isLiveRunStatus, queueRunOnDaemon } from "./workflow_runs";
import { resumeQueuedRun } from "./failedRunResume";
import { verifyApiToken } from "./apiTokens";
import { lineSlugOf } from "./orgRoles";
import { isLineRunSlug, lineRouteFor } from "./workflows";
import { seatPlace } from "./lib/seatPlace";
import { holdsSlot, linePoolFor, poolCap, poolDeviceIds, poolFree, poolWorking, runsWaitingOnAPerson, slotRuns, takeSlot, WORKING_RUN_STATUSES, type LinePool } from "./lib/linePlacement";
import { allRolesInBoundary, projectLeadRole, resolveRoleRef, userCanAccessRole } from "./lib/orgAccess";
import { taskWork } from "./lib/orgOwnership";
import { ownerOf, projectLeadOf } from "@codecast/shared/contracts/orgLead";
import { chainHeadOf } from "@codecast/shared/contracts/orgAssignee";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { byStartOrder, startValue } from "./lib/linePriority";
import { getAuthenticatedUserId } from "./pendingMessages";
import { accessJudgeFor, canAccessTask } from "./lib/access";
import { trialProjectOf } from "./lineTrial";
import { workspaceHasFeature } from "./lib/teamFeatureGuard";

// The line (docs/architecture/the-line.md L2, L9). A scope owns one workflow,
// named by `org_roles.line_workflow_slug`; the sweep below starts that
// workflow on every open task the role's agent is assigned to. Every function
// takes the db and the role row so the fake db tests drive the same code the
// cron runs.

type Ctx = { db: any };

// How many runs one sweep may start in total, so a large backlog is drained
// two minutes at a time instead of in one long mutation.
export const MAX_STARTS_PER_SWEEP = 10;


export const LINE_STARTED_PREFIX = "the flow started: run ";

export const agentAssignee = (role: { handle: string }) => `agent:${role.handle}`;

// L9 and LE6: what a role's line may start. Two kinds, both open, with no
// run yet, no blocker or wait still open, and work the role owns by the one
// ownership rule (org-staffing.md S26), so a wider role never starts what a
// narrower one owns:
//   - a task assigned to the role (its agent or the role itself);
//   - a cause (LE4): a task the signal door opened, grounded ready with a
//     goal_ref (LE5), unassigned or assigned to the role.
// A scoped role reads its scope through the resolver the scope feed uses; a
// whole workspace role reads what it was handed in its boundary plus the open
// causes there, since the rule leaves it the work no narrower role covers.
// In the line's start order (lib/linePriority.ts byStartOrder): the scored
// value of fixing each, then the most findings, then the oldest.
export async function lineCandidates(ctx: Ctx, role: any, limit = Infinity): Promise<any[]> {
  return (await rankedCandidates(ctx, role, limit)).map((c) => c.task);
}

export type RankedCandidate = { task: any; priority: number };

// Ranks the pool on the fields every task carries, then takes the owned,
// unblocked ones in that order until `limit`: ownership, the trial check and
// the blocker reads cost reads per task, so a sweep that can start three
// pays for about three.
export async function rankedCandidates(ctx: Ctx, role: any, limit = Infinity): Promise<RankedCandidate[]> {
  if (limit <= 0) return [];
  const assignees = new Set([agentAssignee(role), String(role._id)]);
  const ranked: RankedCandidate[] = [];
  const seen = new Set<string>();
  for (const task of await linePool(ctx, role, assignees)) {
    if (seen.has(String(task._id))) continue;
    seen.add(String(task._id));
    if (task.status !== "open" || task.workflow_run_id || task.ephemeral) continue;
    if (!assignees.has(task.assignee) && !(isReadyCause(task) && !task.assignee)) continue;
    ranked.push({ task, priority: startValue(task) });
  }
  ranked.sort((a, b) => byStartOrder(a.task, b.task));
  const roles = await allRolesInBoundary(ctx, role);
  return takeAdmissible(ctx, ranked, limit, async (c) => lineOwns(ctx, role, c.task, roles));
}

/**
 * The ranked candidates a line may start, in order, until `limit`: those
 * `keep` accepts, outside a trial project, with no blocker open. In chunks,
 * so the blocker reads (task-graph.md TG1) batch.
 */
export async function takeAdmissible<C extends { task: any }>(ctx: Ctx, ranked: C[], limit: number, keep: (c: C) => Promise<boolean>): Promise<C[]> {
  const out: C[] = [];
  const chunk = Math.min(Math.max(limit, 8), 64);
  for (let i = 0; i < ranked.length && out.length < limit; i += chunk) {
    const owned: C[] = [];
    for (const c of ranked.slice(i, i + chunk)) {
      if (!(await keep(c))) continue;
      // A trial project's problems run only on the trial graph, started by
      // hand (lineTrial.ts); the role's own line would push and merge.
      if (await trialProjectOf(ctx, c.task)) continue;
      owned.push(c);
    }
    const lookupsFor = await readinessLookups(ctx, owned.map((c) => c.task));
    for (const c of owned) {
      if (out.length >= limit) break;
      if (isUnblocked(c.task, lookupsFor(c.task).statusOf)) out.push(c);
    }
  }
  return out;
}

// Who works a task on the line: the one owner by the ownership rule (S26).
// A cause the signal door filed under a project and no plan goes to that
// project's lead (line-profile.md LP1), which settles a project two roles list
// by its owner_role_id instead of leaving the cause to nobody.
export async function lineOwnerOf(ctx: Ctx, task: any, roles: any[]): Promise<any | null> {
  if (task.source === "signal" && task.project_id && !task.plan_id) {
    const lead = projectLeadOf(await ctx.db.get(task.project_id), roles);
    if (lead.kind === "lead") return lead.role;
  }
  const owner = ownerOf(await taskWork(ctx, task), roles);
  return owner.kind === "owner" ? owner.role : null;
}

async function lineOwns(ctx: Ctx, role: any, task: any, roles: any[]): Promise<boolean> {
  return String((await lineOwnerOf(ctx, task, roles))?._id) === String(role._id);
}

// LE5: a cause reaches the line once ground marked it ready and named the
// goal it threatens ("none" included).
export function isReadyCause(task: any): boolean {
  return task.source === "signal" && task.readiness === "ready" && !!task.goal_ref?.trim();
}

// How many open, ready causes one pass reads per scope project (or per
// workspace, for a whole workspace role), oldest first: the window the sweep
// and the queue rank. A backlog longer than this drains window by window as
// its oldest causes start.
export const CAUSE_WINDOW = 200;

// The line's pool, read by the candidate predicate's own indexes: the open
// tasks handed to the role, and the open causes at `readiness` where it
// looks. The ownership rule then picks what is the role's (lineOwns).
async function linePool(ctx: Ctx, role: any, assignees: Set<string>, readiness: "ready" | "needs_context" = "ready"): Promise<any[]> {
  const rows: any[] = [];
  for (const a of assignees) rows.push(...await ctx.db.query("tasks").withIndex("by_assignee_status", (q: any) => q.eq("assignee", a).eq("status", "open")).collect());
  if (isWholeWorkspaceRole(role)) {
    const key = role.team_id ? `team:${role.team_id}` : `user:${role.scope_user_id}`;
    rows.push(...await ctx.db.query("tasks")
      .withIndex("by_workspace_source_status_readiness", (q: any) => q.eq("workspace", key).eq("source", "signal").eq("status", "open").eq("readiness", readiness))
      .take(CAUSE_WINDOW));
    return rows.filter((t) => t.workspace === key);
  }
  for (const projectId of role.scope?.project_ids ?? []) {
    rows.push(...await ctx.db.query("tasks")
      .withIndex("by_project_source_status_readiness", (q: any) => q.eq("project_id", projectId).eq("source", "signal").eq("status", "open").eq("readiness", readiness))
      .take(CAUSE_WINDOW));
  }
  // What the role's host may read, as its scope read did (org.resolveScope).
  const mayRead = await accessJudgeFor(ctx as any, role.host_user_id);
  const out: any[] = [];
  for (const t of rows) if (await mayRead("tasks", t)) out.push(t);
  return out;
}

// Whether the role's line may start a run now: active, its line's start switch
// on (learning-loop.md LL5), and hands left today.
export function roleMayStartHands(role: any, now: number): boolean {
  if (role.status !== "active" || !lineStartsOn(role)) return false;
  // A role retiring behind a knowledge handoff (org-staffing.md S32) starts
  // nothing new: its area already belongs to the heirs.
  if (role.handing_over?.retire) return false;
  return !atCap(countersFor(role, now).hands, capsFor(role).hands_per_day);
}

// LE6: the gate node a change card asks its person at (LE11), on a line run.
// One name in the contract, shared with the line page's admission state.
export const LINE_CARD_GATE_NODE = CARD_GATE_NODE_ID;

// LE6: how many line runs may work at once on one runner's own machine when
// no machine of theirs offers the role's checkout (lib/linePlacement). It is
// usually a laptop its person works on, and twelve line runs put one at load
// 192 (2026-10-23), so it takes a small share and the pool takes the volume.
// Decisions waiting for an answer hold nothing back, so this or the pool's
// slots are all that stands between a sweep and thousands of sessions.
export const LINE_RUNS_PER_RUNNER = 4;

export type RunnerLoad = { runner: string; working: number; cap: number };

// Where a role's runs work: its runner and its folder (seatPlace).
async function seatOf(ctx: Ctx, role: any): Promise<{ runner: string; project_path: string | undefined }> {
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  const standing = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
  const place = seatPlace(role, standing);
  return { runner: String(place.runner_user_id), project_path: place.project_path };
}

// LE6: the line runs working now on `runner`'s own machine: every run a role
// run by `runner` started (a cause's, or one with no task, like a judge
// diagnosis), plus runs with a task its standing session spawned (from before
// org_role_id), minus those waiting on a blocking decision and
// those on a pool machine, which its slots count. Every role counts, paused
// and retired ones too: their runs still use the machine.
export async function runnerLoad(ctx: Ctx, runner: string, roles?: any[]): Promise<RunnerLoad> {
  const all: any[] = roles ?? await ctx.db.query("org_roles").collect();
  const waiting = await runsWaitingOnAPerson(ctx, runner);
  const pooled = await poolDeviceIds(ctx, runner);
  const working = new Set<string>();
  for (const role of all) {
    const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
    const standing = anchor?.conversation_id ?? null;
    if (String(seatPlace(role, standing ? await ctx.db.get(standing) : null).runner_user_id) !== runner) continue;
    for (const status of WORKING_RUN_STATUSES) {
      const runs: any[] = await ctx.db
        .query("workflow_runs")
        .withIndex("by_org_role_status", (q: any) => q.eq("org_role_id", role._id).eq("status", status))
        .collect();
      if (standing) {
        runs.push(...await ctx.db
          .query("workflow_runs")
          .withIndex("by_spawner_status", (q: any) => q.eq("spawner_conversation_id", standing).eq("status", status))
          .collect());
      }
      for (const run of runs) {
        if (!pooled.has(String(run.runner_device ?? "")) && await holdsSlot(ctx, run, waiting)) working.add(String(run._id));
      }
    }
  }
  return { runner, working: working.size, cap: LINE_RUNS_PER_RUNNER };
}

export type LineLoad = RunnerLoad & { pool: LinePool | null };
/** Loads read once per pass and shared by every start in it, keyed by runner and folder. */
export type LineLoads = Map<string, LineLoad>;

/** The load a role's next run meets: its pool's slots when a machine offers its checkout, else its runner's own machine. */
export async function lineLoadFor(ctx: Ctx, role: any, now: number, loads: LineLoads = new Map(), roles?: any[]): Promise<LineLoad> {
  const seat = await seatOf(ctx, role);
  const key = `${seat.runner}|${seat.project_path ?? ""}`;
  const known = loads.get(key);
  if (known) return known;
  const pool = await linePoolFor(ctx, seat.runner, seat.project_path, now);
  const load: LineLoad = pool
    ? { runner: seat.runner, working: poolWorking(pool), cap: poolCap(pool), pool }
    : { ...await runnerLoad(ctx, seat.runner, roles), pool: null };
  loads.set(key, load);
  return load;
}

export const freeSlots = (load: LineLoad): number => (load.pool ? poolFree(load.pool) : load.cap - load.working);

/** Takes a slot for one run: the pool machine it goes to, or none (the runner's own machine). Counts the run on the load. */
export function claimSlot(load: LineLoad): RunPlace | undefined {
  load.working++;
  return load.pool ? takeSlot(load.pool) ?? undefined : undefined;
}

/**
 * A run the role starts outside the sweep (a judge diagnosis, learning-loop.md
 * LL11) goes through the same admission: a slot where its runs work, or the
 * reason it waits, for its own sweep to start it later.
 */
export type Admission = { runner: string; pooled: boolean } & ({ place?: RunPlace } | { waiting: string });

export async function admitRoleRun(ctx: Ctx, role: any, now: number, loads: LineLoads = new Map()): Promise<Admission> {
  const load = await lineLoadFor(ctx, role, now, loads);
  const at = { runner: load.runner, pooled: !!load.pool };
  if (freeSlots(load) <= 0) return { ...at, waiting: `${load.working} run${load.working === 1 ? " is" : "s are"} working on @${role.handle}'s machine${load.pool ? "s" : ""}` };
  return { ...at, place: claimSlot(load) };
}

/**
 * A problem back in the line's queue: open, with no run, and no longer blocked
 * by the run that failed, so the sweep starts it in rank order. A lead puts a
 * failed problem back this way (`cast line requeue`), and a problem started by
 * hand while its role's machines are full lands here rather than on a machine
 * (`why` says that). The ended run stays on the task's run list.
 */
export async function requeueForSweep(ctx: Ctx, role: any, task: any, actor: Id<"users">, now: number, why?: string): Promise<string> {
  const fresh = await ctx.db.get(task._id);
  await moveTaskStatus(ctx, fresh, "open", { actorUserId: actor, now, extra: { workflow_run_id: undefined, execution_status: undefined, execution_concerns: undefined } });
  const flow = await liveFlowFor(ctx, role.team_id);
  const starts = flow ? flow.on : roleMayStartHands(role, now);
  const line = flow ? "the team's live flow" : `@${role.handle}'s line`;
  const when = starts ? `${flow ? "the live flow" : `@${role.handle}'s sweep`} starts it in rank order${why ? " when a run finishes" : ""}` : `${line} starts nothing now, so it waits until it is on`;
  return `${why ? `${why}, so ` : ""}${task.short_id} is back in the line's queue; ${when}.`;
}

/**
 * `cast line requeue <task>`: a lead puts a problem whose run failed or was
 * cancelled back on the line. Refused for a closed problem, a trial problem
 * (cast line trial rerun), one in no led project, and one whose run is live.
 */
export async function requeueCore(ctx: Ctx, userId: Id<"users">, ref: string, now = Date.now()): Promise<{ task: string; queued: string }> {
  const task: any = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
  if (!task || !(await canAccessTask(ctx as any, userId, task))) throw new ConvexError(`${ref}: no such problem`);
  if (isTerminalTaskStatus(task.status)) throw new ConvexError(`${ref} is ${task.status}: a closed problem is not put back on the line`);
  if (await trialProjectOf(ctx, task)) throw new ConvexError(`${ref} is a trial problem: cast line trial rerun ${ref} runs it again under the trial's budget`);
  const role = await projectLeadRole(ctx, task);
  if (!role) throw new ConvexError(`${ref}: no role leads its project, so no line would start it`);
  if (!(await userCanAccessRole(ctx, userId, role))) throw new ConvexError(`${ref}: you cannot steer @${role.handle}'s line`);
  const run: any = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
  if (run && isLiveRunStatus(run.status)) throw new ConvexError(`${ref}'s run ${run._id} is ${run.status}: cancel it from its run page first, or let it finish`);
  return { task: task.short_id, queued: await requeueForSweep(ctx, role, task, userId, now) };
}

export const requeueFromCli = mutation({
  args: { api_token: v.string(), task: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new ConvexError("Unauthorized");
    return requeueCore(ctx, auth.userId, args.task.trim());
  },
});


// LP6: the person who answers a role's cards is the person at the top of its
// reporting chain; a chain that ends without one falls back to its host.
export function answererOf(role: any, boundaryRoles: any[]): string {
  return chainHeadOf(role._id, boundaryRoles) ?? String(role.host_user_id);
}

export type AdmissionWait = "off" | "hands" | "runs";

// LE6: why the line may not admit its next cause now, or null when it may.
// `working` and `cap` are the role's load (lineLoadFor).
export function admissionWait(role: any, working: number, now: number, cap = LINE_RUNS_PER_RUNNER): AdmissionWait | null {
  if (!roleMayStartHands(role, now)) return atCap(countersFor(role, now).hands, capsFor(role).hands_per_day) ? "hands" : "off";
  if (working >= cap) return "runs";
  return null;
}

export function admissionWaitWords(wait: AdmissionWait, working: number, pooled = false): string {
  if (wait === "runs") return `${working} run${working === 1 ? "" : "s"} working on its machine${pooled ? "s" : ""}`;
  if (wait === "hands") return "hands cap reached";
  return "line is off";
}

// L9: one run for one task, through the same core createFromCli uses, with
// the role as the caller: the run belongs to whoever runs the role's
// standing session, its spawner is that session (so hands spawn under the
// role, L1), its cwd is that session's folder (seatPlace), and its workflow
// is that person's row with the line's slug. When they have no such row (the slug names a shipped
// template that was never pushed) the run carries `workflow_name` = the
// slug and no `workflow_id`; `cast workflow run-daemon` resolves the shipped
// template by that name (workflow/daemonGraph.ts).
export async function startLineRun(ctx: Ctx, role: any, task: any, now = Date.now(), place?: RunPlace): Promise<Id<"workflow_runs">> {
  const { runId, primaryConvId } = await startRoleRun(ctx, role, { slug: lineSlugOf(role), task, goal: task.title, now, place });
  await insertTaskComment(ctx, task._id, {
    author: `@${role.handle}`,
    text: `${LINE_STARTED_PREFIX}${runId}`,
    comment_type: "progress",
    conversation_id: primaryConvId,
  });
  return runId;
}

/**
 * One run of a graph as the role, on its seat: startLineRun's for a cause,
 * and a graph the line runs beside its causes with no task of its own (a
 * wrong finding's diagnosis, learning-loop.md LL11), which names its subject
 * in the goal.
 */
/** A pool machine for a run (lib/linePlacement.takeSlot): its device and the role's folder in its checkout. */
export type RunPlace = { device: string; project_path: string };

export async function startRoleRun(ctx: Ctx, role: any, o: { slug: string; task?: any; goal: string; now: number; place?: RunPlace }): Promise<{ runId: Id<"workflow_runs">; primaryConvId: Id<"conversations"> }> {
  const { slug, task, now } = o;
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  const standing = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
  const place = seatPlace(role, standing);
  const hostId: Id<"users"> = place.runner_user_id;
  // A line run on a problem takes its live flow's family member, else the version that serves its scenario (workflows.lineRouteFor).
  const route = isLineRunSlug(slug) ? await lineRouteFor(ctx, hostId, task) : null;
  if (route?.waiting) throw new ConvexError(`${task?.short_id ?? "this problem"} waits: ${route.waiting} in its team's live flow`);
  const workflow = route?.workflow ?? await ctx.db
    .query("workflows")
    .withIndex("by_user_slug", (q: any) => q.eq("user_id", hostId).eq("slug", slug))
    .first();

  // L8 is createRunCore's: the run's ACCESS key comes from the task's own
  // workspace, so a task private to its owner inside a team keeps a private
  // run. The task leaves `open` the moment its run exists, which is also
  // what keeps the next sweep from starting it twice.
  const { run_id: runId, primary_conversation_id: primaryConvId } = await createRunCore(ctx, hostId, {
    workflow_name: workflow?.name ?? slug,
    workflow_id: workflow?._id,
    task,
    goal_override: o.goal,
    project_path: o.place?.project_path ?? place.project_path,
    spawner_conversation_id: anchor?.conversation_id ?? undefined,
    org_role_id: role._id,
    fallback_team_id: role.team_id ?? undefined,
    fresh_branch: isLineRunSlug(slug),
    now,
  });

  // A placed run names its machine from the start, so the pool counts it
  // there before a runner claims it.
  if (o.place) await ctx.db.patch(runId, { runner_device: o.place.device });
  await queueRunOnDaemon(ctx, hostId, runId, { slug: workflow?.slug ?? slug, now, ...(o.place ? { device: o.place.device } : {}) });

  // The run's primary session is a hand of the role: it counts against
  // caps.hands_per_day and carries org_role_id, the same as a spawn.
  await recordHandStart(ctx, role, primaryConvId);
  return { runId, primaryConvId };
}

export type SweepResult = {
  started: Array<{ role_id: string; task_id: string; run_id: string; place?: RunPlace; live_flow_id?: string }>;
  skipped_capped: string[];
  // Roles whose next cause waits for a run on their machine to finish (LE6).
  skipped_busy: string[];
  // Failed runs queued to resume (cast workflow resume --queue), each back on its own machine.
  resumed?: Array<{ run_id: string; device: string }>;
  // A dry pass (orgLine.explain) also says each load it read.
  loads?: Array<{ runner: string; project_path: string; working: number; cap: number; pool: Array<{ device: string; root: string; runs: number; working: number }> | null }>;
};

// L9 and LE6: every two minutes. Paused roles and roles whose line's start
// switch is off (learning-loop.md LL5: caps.line_on, under the role's own
// switch) never start anything, and every line starts off. A role admits its
// candidates highest priority first while fewer than LINE_RUNS_PER_RUNNER
// runs work on its runner's machine (across every line that person runs) and
// its hands are under caps.hands_per_day; a role at either cap is reported
// and waits for a run to finish, pause or ask, or for tomorrow.
//
// A pass reads only what it can start: a role's starts this pass are bounded
// by the sweep's own limit, the free run slots and the hands left, and its
// candidates are read for that many (rankedCandidates). `dry` decides the
// same way and starts nothing (orgLine.explain).
//
// The pass is two steps so it commits at volume. Planning reads every role,
// load and candidate, megabytes of rows that stations write all the time (a
// task comment, a run's node), so it runs as a query, which no write can
// fail. Each start is then its own small mutation (startPlanned) that reads
// only the rows it changes and checks them again. As one mutation the pass
// lost the write race on nearly every attempt (148 runs, 3 commits in 28
// minutes on 2026-10-23).
/** Whether a workspace's lines may start work: Flows on (the team's switch),
 *  and Org on, since a line runs as a role. Either off starts nothing, and
 *  turning them back on resumes from the same rows. Cached per pass. */
async function linesRunIn(ctx: Ctx, scope: { team_id?: any; scope_user_id?: any }, seen: Map<string, boolean>): Promise<boolean> {
  const key = scope.team_id ? `t:${scope.team_id}` : `u:${scope.scope_user_id ?? ""}`;
  const known = seen.get(key);
  if (known !== undefined) return known;
  const ws = { team_id: scope.team_id ?? null, user_id: scope.scope_user_id ?? null };
  const on = (await workspaceHasFeature(ctx, ws, "line")) && (await workspaceHasFeature(ctx, ws, "org"));
  seen.set(key, on);
  return on;
}

export async function planSweep(ctx: Ctx, now = Date.now(), o: { loads?: boolean } = {}): Promise<SweepResult> {
  const result: SweepResult = { started: [], skipped_capped: [], skipped_busy: [] };
  const featureOn = new Map<string, boolean>();
  const roles: any[] = await ctx.db.query("org_roles").collect();
  // One load per runner and folder, shared by every role that runs there in
  // this pass: a pool's slots, else the runner's own machine.
  const loads: LineLoads = new Map();
  // A team's live flow admits for all its leads, from one queue (liveFlows.ts);
  // while it exists, on or off, they admit nothing on their own.
  const flows: any[] = await ctx.db.query("live_flows").collect();
  const flowTeams = new Set(flows.map((f) => String(f.team_id ?? "")));
  result.resumed = await planQueuedResumes(ctx, now, roles, loads, featureOn, new Map(flows.map((f) => [String(f.team_id ?? ""), f])));
  for (const flow of flows) {
    if (!flow.on || result.started.length >= MAX_STARTS_PER_SWEEP) continue;
    if (!(await linesRunIn(ctx, { team_id: flow.team_id }, featureOn))) continue;
    const planned = await planLiveFlow(ctx, flow, roles, now, MAX_STARTS_PER_SWEEP - result.started.length, loads);
    result.started.push(...planned.starts.map((st) => ({ ...st, run_id: "planned" })));
    if (planned.waiting) (planned.waiting.includes("working on") ? result.skipped_busy : result.skipped_capped).push(`live:${flow._id}`);
  }
  for (const role of roles) {
    if (result.started.length >= MAX_STARTS_PER_SWEEP) break;
    if (role.status !== "active" || !lineStartsOn(role)) continue;
    if (role.team_id && flowTeams.has(String(role.team_id))) continue;
    if (!(await linesRunIn(ctx, role, featureOn))) continue;
    const before = loads.size;
    const load = await lineLoadFor(ctx, role, now, loads, roles);
    if (o.loads && loads.size > before) (result.loads ??= []).push({ runner: load.runner, project_path: (await seatOf(ctx, role)).project_path ?? "", working: load.working, cap: load.cap, pool: load.pool ? load.pool.slots.map((sl) => ({ ...sl })) : null });
    const handsCap = capsFor(role).hands_per_day;
    const handsLeft = handsCap == null ? Infinity : handsCap - countersFor(role, now).hands;
    const slots = freeSlots(load);
    const sweepLeft = MAX_STARTS_PER_SWEEP - result.started.length;
    const wait = admissionWait(role, load.cap - slots, now, load.cap);
    const room = wait ? 0 : Math.min(sweepLeft, slots, handsLeft);
    // One past the room tells whether a cause waits behind the limit.
    const candidates = await lineCandidates(ctx, role, room + 1);
    for (const task of candidates.slice(0, room)) {
      // A pool run goes to the machine with the most free slots, in its checkout.
      const place = claimSlot(load);
      result.started.push({ role_id: String(role._id), task_id: String(task._id), run_id: "planned", ...(place ? { place } : {}) });
    }
    if (candidates.length > room && room < sweepLeft) {
      const why = wait ?? (handsLeft <= slots ? "hands" : "runs");
      (why === "runs" ? result.skipped_busy : result.skipped_capped).push(String(role._id));
    }
  }
  return result;
}

const QUEUED_RESUMES_READ = 200;

/**
 * Failed runs queued to resume (cast workflow resume --queue), oldest first, each on its own machine while that
 * machine has a free slot. They plan before any new start in the pass and take its slots: finishing work comes before
 * starting it. A team whose live flow is off or held resumes nothing, as it starts nothing. Only a machine that offers
 * the line's checkout (a pool slot) takes a queued resume.
 */
async function planQueuedResumes(ctx: Ctx, now: number, roles: any[], loads: LineLoads, featureOn: Map<string, boolean>, flowsByTeam: Map<string, any>): Promise<Array<{ run_id: string; device: string }>> {
  const queued: any[] = await ctx.db.query("workflow_runs").withIndex("by_resume_queued", (q: any) => q.gt("resume_queued.since", 0)).take(QUEUED_RESUMES_READ);
  const out: Array<{ run_id: string; device: string }> = [];
  for (const run of queued) {
    if (out.length >= MAX_STARTS_PER_SWEEP) break;
    const role = roles.find((r) => String(r._id) === String(run.org_role_id));
    if (!role || role.status !== "active" || !run.runner_device) continue;
    const flow = flowsByTeam.get(String(role.team_id ?? ""));
    if (flow && (!flow.on || flowHold(flow, now))) continue;
    if (!(await linesRunIn(ctx, role, featureOn))) continue;
    const load = await lineLoadFor(ctx, role, now, loads, roles);
    const slot = load.pool?.slots.find((s) => s.device === run.runner_device);
    if (!slot || slot.runs - slot.working <= 0) continue;
    slot.working++;
    load.working++;
    out.push({ run_id: String(run._id), device: run.runner_device });
  }
  return out;
}

/** One planned resume, checked again: still queued, and its machine's slot still free (slotStillFree). */
export async function resumePlanned(ctx: Ctx, runId: string, now = Date.now()): Promise<string | null> {
  const run = await ctx.db.get(runId);
  const role = run?.org_role_id ? await ctx.db.get(run.org_role_id) : null;
  if (!run?.resume_queued || !run.runner_device || !role) return null;
  if (!(await slotStillFree(ctx, role, { device: run.runner_device, project_path: run.project_path ?? "" }))) return null;
  return resumeQueuedRun(ctx, run._id, now);
}

/**
 * One planned start, checked again against the rows it changes: the role may
 * still start a hand, the task is still an open cause with no run, and a pool
 * machine still has a free slot. Null when any of that moved since the plan;
 * the next pass plans again.
 */
export async function startPlanned(ctx: Ctx, p: { role_id: string; task_id: string; place?: RunPlace; live_flow_id?: string }, now = Date.now()): Promise<string | null> {
  const role = await ctx.db.get(p.role_id);
  if (!role) return null;
  // A live flow's start answers to the flow's switch and hands; the lead's own
  // line switch no longer decides (its lead is a watcher).
  const flow = p.live_flow_id ? await ctx.db.get(p.live_flow_id) : null;
  if (p.live_flow_id ? !flowAdmits(flow, now) || role.status !== "active" : !roleMayStartHands(role, now)) return null;
  if (!(await linesRunIn(ctx, role, new Map()))) return null;
  const task = await ctx.db.get(p.task_id);
  if (!task || task.status !== "open" || task.workflow_run_id || task.ephemeral) return null;
  if (p.place && !(await slotStillFree(ctx, role, p.place))) return null;
  const runId = String(await startLineRun(ctx, role, task, now, p.place));
  if (flow) await ctx.db.patch(flow._id, { counters: { day: utcDay(now), hands: flowHands(flow, now) + 1 } });
  return runId;
}

// The planned machine's slot, counted from the runs on that machine alone.
async function slotStillFree(ctx: Ctx, role: any, place: RunPlace): Promise<boolean> {
  const { runner } = await seatOf(ctx, role);
  const device = await ctx.db.query("devices").withIndex("by_user_device", (q: any) => q.eq("user_id", runner).eq("device_id", place.device)).first();
  const slot = (device?.line_slots ?? []).find((s: any) => place.project_path === s.root || place.project_path.startsWith(`${s.root.replace(/\/+$/, "")}/`));
  if (!slot) return false;
  const waiting = await runsWaitingOnAPerson(ctx, runner);
  let working = 0;
  for (const status of WORKING_RUN_STATUSES) {
    const runs: any[] = await ctx.db.query("workflow_runs").withIndex("by_runner_device_status", (q: any) => q.eq("runner_device", place.device).eq("status", status)).collect();
    for (const r of runs) if (await holdsSlot(ctx, r, waiting)) working++;
  }
  return working < slotRuns(device, slot);
}

/** The pass in one transaction, as the tests drive it; `dry` plans only (orgLine.explain). */
export async function sweepCore(ctx: Ctx, now = Date.now(), o: { dry?: boolean } = {}): Promise<SweepResult> {
  const plan = await planSweep(ctx, now, { loads: o.dry });
  if (o.dry) return { ...plan, started: plan.started.map((s) => ({ ...s, run_id: `dry${s.place ? `@${s.place.device}` : ""}` })) };
  const resumed: NonNullable<SweepResult["resumed"]> = [];
  for (const r of plan.resumed ?? []) if (await resumePlanned(ctx, r.run_id, now)) resumed.push(r);
  const started: SweepResult["started"] = [];
  for (const s of plan.started) {
    const runId = await startPlanned(ctx, s, now);
    if (runId) started.push({ ...s, run_id: runId });
  }
  return { ...plan, started, resumed };
}

const placeArg = v.optional(v.object({ device: v.string(), project_path: v.string() }));

export const plan = internalQuery({
  args: {},
  handler: async (ctx): Promise<SweepResult> => planSweep(ctx),
});

export const resumeOne = internalMutation({
  args: { run_id: v.id("workflow_runs") },
  handler: async (ctx, args): Promise<string | null> => resumePlanned(ctx, args.run_id),
});

export const startOne = internalMutation({
  args: { role_id: v.id("org_roles"), task_id: v.id("tasks"), place: placeArg, live_flow_id: v.optional(v.id("live_flows")) },
  handler: async (ctx, args): Promise<string | null> => startPlanned(ctx, args),
});

export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<SweepResult> => {
    const planned: SweepResult = await ctx.runQuery(internal.orgLine.plan, {});
    const resumed: NonNullable<SweepResult["resumed"]> = [];
    for (const r of planned.resumed ?? []) {
      if (await ctx.runMutation(internal.orgLine.resumeOne, { run_id: r.run_id as Id<"workflow_runs"> })) resumed.push(r);
    }
    const started: SweepResult["started"] = [];
    for (const s of planned.started) {
      const runId: string | null = await ctx.runMutation(internal.orgLine.startOne, { role_id: s.role_id as Id<"org_roles">, task_id: s.task_id as Id<"tasks">, ...(s.place ? { place: s.place } : {}), ...(s.live_flow_id ? { live_flow_id: s.live_flow_id as Id<"live_flows"> } : {}) });
      if (runId) started.push({ ...s, run_id: runId });
    }
    return { ...planned, started, resumed };
  },
});

/** What the next sweep would start, and which roles wait and why, starting nothing. */
export const explain = internalQuery({
  args: {},
  handler: async (ctx) => sweepCore(ctx, Date.now(), { dry: true }),
});

export type LineQueueItem = { task_id: string; short_id: string | null; title: string; cause: boolean; priority: number; waiting: string | null };
/** A cause the role leads that grounding held on a fact (readiness needs_context): the lead's to answer, never a
 *  person's For you. `note` is grounding's own words, the question inside them. */
export type LineAsk = { task_id: string; short_id: string | null; title: string; note: string | null; findings: number };
export type LineQueue = { role_id: string; working: number; runs_cap: number; hands: number; hands_cap: number | null; waiting: string | null; items: LineQueueItem[]; asks: LineAsk[] };

/** A note that parks a cause until more findings come asks nobody anything (web lineInbox waitsForFindings). */
const WAITS_FOR_FINDINGS = /\bwaits? (?:for|on) more (?:signals|findings)\b/i;

// A run's grounding asks no person: a cause it held on a fact waits for the
// role whose area holds its project (the lead its line runs as), oldest
// first. These are the role's asks, beside the queue it would start.
export async function lineAsksFor(ctx: Ctx, role: any): Promise<LineAsk[]> {
  const roles = await allRolesInBoundary(ctx, role);
  const seen = new Set<string>();
  const out: Array<LineAsk & { at: number }> = [];
  for (const task of await linePool(ctx, role, new Set([agentAssignee(role), String(role._id)]), "needs_context")) {
    if (seen.has(String(task._id))) continue;
    seen.add(String(task._id));
    if (task.source !== "signal" || task.status !== "open" || task.workflow_run_id || task.readiness !== "needs_context") continue;
    if (WAITS_FOR_FINDINGS.test(task.readiness_note ?? "")) continue;
    if (!(await lineOwns(ctx, role, task, roles))) continue;
    out.push({ task_id: String(task._id), short_id: task.short_id ?? null, title: task.title, note: task.readiness_note?.trim() || null, findings: task.cause?.signal_count ?? 0, at: task.created_at ?? task._creationTime ?? 0 });
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...a }) => a);
}

// LE6: the line page's queue for one role: its candidates in admission order,
// each with why it waits (null: it starts at the next sweep). `waiting` on the
// queue is why the head has not started. Each start takes a run slot on the
// runner's machine and a hand, so an item waits behind whichever runs out
// before its turn.
export async function lineQueueFor(ctx: Ctx, role: any, now = Date.now()): Promise<LineQueue> {
  const ranked = await rankedCandidates(ctx, role);
  const { working, cap: runsCap, pool } = await lineLoadFor(ctx, role, now);
  const wait = admissionWait(role, working, now, runsCap);
  const waiting = wait ? admissionWaitWords(wait, working, !!pool) : null;
  const hands = countersFor(role, now).hands;
  const handsCap = capsFor(role).hands_per_day ?? null;
  // The sweep checks hands before runs, so when both run out at once the
  // hands cap is the reason.
  const handSlots = handsCap === null ? Infinity : handsCap - hands;
  const runSlots = runsCap - working;
  const itemWait = (i: number): string | null => {
    if (waiting) return waiting;
    if (i < Math.min(handSlots, runSlots)) return null;
    return handSlots <= runSlots ? admissionWaitWords("hands", working) : admissionWaitWords("runs", runsCap, !!pool);
  };
  return {
    role_id: String(role._id),
    working,
    runs_cap: runsCap,
    hands,
    hands_cap: handsCap,
    waiting,
    asks: await lineAsksFor(ctx, role),
    items: ranked.map(({ task, priority }, i) => ({
      task_id: String(task._id),
      short_id: task.short_id ?? null,
      title: task.title,
      cause: task.source === "signal",
      priority,
      waiting: itemWait(i),
    })),
  };
}

export const queue = query({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, { api_token, role_id }): Promise<LineQueue | null> => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) return null;
    const role = await resolveRoleRef(ctx, role_id);
    if (!role || !(await userCanAccessRole(ctx, userId, role))) return null;
    return lineQueueFor(ctx, role);
  },
});
