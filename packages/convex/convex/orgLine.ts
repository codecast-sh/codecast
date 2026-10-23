import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./functions";
import { isWholeWorkspaceRole } from "@codecast/shared/contracts/orgLead";
import { lineStartsOn } from "@codecast/shared/contracts/roleAutonomy";
import { isUnblocked, TASK_PRIORITIES } from "@codecast/shared/tasks";
import { readinessLookups } from "./lib/taskGraph";
import type { Id } from "./_generated/dataModel";
import { resolveScope } from "./org";
import { capsFor, countersFor } from "./lib/orgCaps";
import { atCap } from "@codecast/shared/contracts/orgCapacity";
import { recordHandStart } from "./spawn";
import { insertTaskComment } from "./tasks";
import { createRunCore, queueRunOnDaemon } from "./workflow_runs";
import { lineSlugOf } from "./orgRoles";
import { isLineRunSlug, lineVersionFor } from "./workflows";
import { roleRunner, seatPlace } from "./lib/seatPlace";
import { allRolesInBoundary, resolveRoleRef, userCanAccessRole } from "./lib/orgAccess";
import { taskWork } from "./lib/orgOwnership";
import { ownsWork, projectLeadOf } from "@codecast/shared/contracts/orgLead";
import { chainHeadOf } from "@codecast/shared/contracts/orgAssignee";
import { LINE_GOAL, NO_GOAL, type GoalPriority } from "@codecast/shared/contracts/goalsBrief";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { priority as linePriority, type Severity } from "./lib/linePriority";
import { getAuthenticatedUserId } from "./pendingMessages";
import { accessJudgeFor } from "./lib/access";
import { trialProjectOf } from "./lineTrial";

// The line (docs/architecture/the-line.md L2, L9). A scope owns one workflow,
// named by `org_roles.line_workflow_slug`; the sweep below starts that
// workflow on every open task the role's agent is assigned to. Every function
// takes the db and the role row so the fake db tests drive the same code the
// cron runs.

type Ctx = { db: any };

// How many runs one sweep may start in total, so a large backlog is drained
// two minutes at a time instead of in one long mutation.
export const MAX_STARTS_PER_SWEEP = 10;


export const LINE_STARTED_PREFIX = "the line started: run ";

const agentAssignee = (role: { handle: string }) => `agent:${role.handle}`;

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
// Highest computed priority first (lib/linePriority.ts); ties drain oldest
// first, in the order they were filed.
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
  const goals = new Map<string, GoalPriority | "unranked" | null>();
  const ranked: RankedCandidate[] = [];
  const seen = new Set<string>();
  for (const task of await linePool(ctx, role, assignees)) {
    if (seen.has(String(task._id))) continue;
    seen.add(String(task._id));
    if (task.status !== "open" || task.workflow_run_id || task.ephemeral) continue;
    if (!assignees.has(task.assignee) && !(isReadyCause(task) && !task.assignee)) continue;
    ranked.push({ task, priority: linePriority(await goalPriorityOf(ctx, task, goals), severityOf(task), task.cause?.signal_count ?? 1) });
  }
  const age = (t: any) => t.created_at ?? t._creationTime ?? 0;
  ranked.sort((a, b) => b.priority - a.priority || age(a.task) - age(b.task));
  const roles = await allRolesInBoundary(ctx, role);
  const out: RankedCandidate[] = [];
  // In chunks, so the blocker reads (task-graph.md TG1) batch.
  const chunk = Math.min(Math.max(limit, 8), 64);
  for (let i = 0; i < ranked.length && out.length < limit; i += chunk) {
    const owned: RankedCandidate[] = [];
    for (const c of ranked.slice(i, i + chunk)) {
      if (!(await lineOwns(ctx, role, c.task, roles))) continue;
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
async function lineOwns(ctx: Ctx, role: any, task: any, roles: any[]): Promise<boolean> {
  if (task.source === "signal" && task.project_id && !task.plan_id) {
    const lead = projectLeadOf(await ctx.db.get(task.project_id), roles);
    if (lead.kind === "lead") return String(lead.role._id) === String(role._id);
  }
  return ownsWork(role, await taskWork(ctx, task), roles);
}

// LE5: a cause reaches the line once ground marked it ready and named the
// goal it threatens ("none" included; it ranks low, linePriority.NO_GOAL_WEIGHT).
function isReadyCause(task: any): boolean {
  return task.source === "signal" && task.readiness === "ready" && !!task.goal_ref?.trim();
}

const SEVERITIES = new Set<Severity>(TASK_PRIORITIES);
function severityOf(task: any): Severity {
  return SEVERITIES.has(task.priority) ? task.priority : "none";
}

// goal_ref is a metric ref `in-N:key`, a project's short id, "line" or "none"
// (goalsBrief.ts). The goal's priority is read from its row in the task's own
// workspace; the line's own goal has no row and no priority, and a ref that
// names nothing readable there counts as unranked.
async function goalPriorityOf(ctx: Ctx, task: any, cache: Map<string, GoalPriority | "unranked" | null>): Promise<GoalPriority | "unranked" | null> {
  const ref = task.goal_ref?.trim();
  if (!ref || ref === NO_GOAL) return null;
  if (ref === LINE_GOAL) return "unranked";
  const key = `${task.workspace}|${ref}`;
  if (cache.has(key)) return cache.get(key)!;
  const shortId = ref.split(":")[0];
  const table = /^in-\d+$/.test(shortId) ? "initiatives" : "projects";
  const row = await ctx.db.query(table).withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
  const value = row && row.workspace === task.workspace ? (row.priority ?? "unranked") : "unranked";
  cache.set(key, value);
  return value;
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

// LE6: how many line runs may work at once on one runner's machine, summed
// across every line role that person runs. Decisions waiting for an answer
// hold nothing back, so this is the only thing between a sweep and thousands
// of sessions on one laptop: twelve agent sessions is about what a laptop
// runs beside its person's own work.
export const LINE_RUNS_PER_RUNNER = 12;

// A run works while it is pending or running. A run paused at its card, or
// running but blocked on a person's answer, uses no machine and holds no slot.
const WORKING_RUN_STATUSES = ["pending", "running"] as const;

export type RunnerLoad = { runner: string; working: number; cap: number };

// LE6: the line runs working now on `runner`'s machine: runs with a task that
// a role run by `runner` started (or, from before org_role_id, its standing
// session spawned), minus those waiting on a blocking decision. Every role
// counts, paused and retired ones too: their runs still use the machine.
export async function runnerLoad(ctx: Ctx, runner: string, roles?: any[]): Promise<RunnerLoad> {
  const all: any[] = roles ?? await ctx.db.query("org_roles").collect();
  const asked: any[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_user_status", (q: any) => q.eq("user_id", runner).eq("status", "pending"))
    .collect();
  const waiting = new Set(asked.filter((d) => d.blocking && d.workflow_run_id).map((d) => String(d.workflow_run_id)));
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
      for (const run of runs) if (run.task_id && !waiting.has(String(run._id))) working.add(String(run._id));
    }
  }
  return { runner, working: working.size, cap: LINE_RUNS_PER_RUNNER };
}

/** The load of the machine a role's line runs on. */
export async function runnerLoadFor(ctx: Ctx, role: any): Promise<RunnerLoad> {
  return runnerLoad(ctx, String(await roleRunner(ctx, role)));
}

// LP6: the person who answers a role's cards is the person at the top of its
// reporting chain; a chain that ends without one falls back to its host.
export function answererOf(role: any, boundaryRoles: any[]): string {
  return chainHeadOf(role._id, boundaryRoles) ?? String(role.host_user_id);
}

export type AdmissionWait = "off" | "hands" | "runs";

// LE6: why the line may not admit its next cause now, or null when it may.
// `working` is the runs working on the role's runner's machine.
export function admissionWait(role: any, working: number, now: number): AdmissionWait | null {
  if (!roleMayStartHands(role, now)) return atCap(countersFor(role, now).hands, capsFor(role).hands_per_day) ? "hands" : "off";
  if (working >= LINE_RUNS_PER_RUNNER) return "runs";
  return null;
}

export function admissionWaitWords(wait: AdmissionWait, working: number): string {
  if (wait === "runs") return `${working} run${working === 1 ? "" : "s"} working on its machine`;
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
export async function startLineRun(ctx: Ctx, role: any, task: any, now = Date.now()): Promise<Id<"workflow_runs">> {
  const { runId, primaryConvId } = await startRoleRun(ctx, role, { slug: lineSlugOf(role), task, goal: task.title, now });
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
export async function startRoleRun(ctx: Ctx, role: any, o: { slug: string; task?: any; goal: string; now: number }): Promise<{ runId: Id<"workflow_runs">; primaryConvId: Id<"conversations"> }> {
  const { slug, task, now } = o;
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  const standing = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
  const place = seatPlace(role, standing);
  const hostId: Id<"users"> = place.runner_user_id;
  // A line run on a problem takes the version that serves its scenario (workflows.lineVersionFor).
  const workflow = (isLineRunSlug(slug) ? await lineVersionFor(ctx, hostId, task) : null) ?? await ctx.db
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
    project_path: place.project_path,
    spawner_conversation_id: anchor?.conversation_id ?? undefined,
    org_role_id: role._id,
    fallback_team_id: role.team_id ?? undefined,
    fresh_branch: isLineRunSlug(slug),
    now,
  });

  await queueRunOnDaemon(ctx, hostId, runId, { slug: workflow?.slug ?? slug, now });

  // The run's primary session is a hand of the role: it counts against
  // caps.hands_per_day and carries org_role_id, the same as a spawn.
  await recordHandStart(ctx, role, primaryConvId);
  return { runId, primaryConvId };
}

export type SweepResult = {
  started: Array<{ role_id: string; task_id: string; run_id: string }>;
  skipped_capped: string[];
  // Roles whose next cause waits for a run on their machine to finish (LE6).
  skipped_busy: string[];
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
export async function sweepCore(ctx: Ctx, now = Date.now(), o: { dry?: boolean } = {}): Promise<SweepResult> {
  const result: SweepResult = { started: [], skipped_capped: [], skipped_busy: [] };
  const roles: any[] = await ctx.db.query("org_roles").collect();
  // One load per runner, shared by every role they run in this pass.
  const loads = new Map<string, RunnerLoad>();
  for (const seed of roles) {
    if (result.started.length >= MAX_STARTS_PER_SWEEP) break;
    if (seed.status !== "active" || !lineStartsOn(seed)) continue;
    let role = seed;
    const runner = String(await roleRunner(ctx, role));
    const load = loads.get(runner) ?? await runnerLoad(ctx, runner, roles);
    loads.set(runner, load);
    const handsCap = capsFor(role).hands_per_day;
    const handsLeft = handsCap == null ? Infinity : handsCap - countersFor(role, now).hands;
    const slots = load.cap - load.working;
    const sweepLeft = MAX_STARTS_PER_SWEEP - result.started.length;
    const wait = admissionWait(role, load.working, now);
    const room = wait ? 0 : Math.min(sweepLeft, slots, handsLeft);
    // One past the room tells whether a cause waits behind the limit.
    const candidates = await lineCandidates(ctx, role, room + 1);
    for (const task of candidates.slice(0, room)) {
      const runId = o.dry ? "dry" : await startLineRun(ctx, role, task, now);
      result.started.push({ role_id: String(role._id), task_id: String(task._id), run_id: String(runId) });
      // The new run is pending, so it works on the runner's machine.
      load.working++;
      // recordHandStart counts from the row it is given: read it back.
      if (!o.dry) role = await ctx.db.get(role._id);
    }
    if (candidates.length > room && room < sweepLeft) {
      const why = wait ?? (handsLeft <= slots ? "hands" : "runs");
      (why === "runs" ? result.skipped_busy : result.skipped_capped).push(String(role._id));
    }
  }
  return result;
}

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => sweepCore(ctx),
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
  const { working, cap: runsCap } = await runnerLoadFor(ctx, role);
  const wait = admissionWait(role, working, now);
  const waiting = wait ? admissionWaitWords(wait, working) : null;
  const hands = countersFor(role, now).hands;
  const handsCap = capsFor(role).hands_per_day ?? null;
  // The sweep checks hands before runs, so when both run out at once the
  // hands cap is the reason.
  const handSlots = handsCap === null ? Infinity : handsCap - hands;
  const runSlots = runsCap - working;
  const itemWait = (i: number): string | null => {
    if (waiting) return waiting;
    if (i < Math.min(handSlots, runSlots)) return null;
    return handSlots <= runSlots ? admissionWaitWords("hands", working) : admissionWaitWords("runs", runsCap);
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
