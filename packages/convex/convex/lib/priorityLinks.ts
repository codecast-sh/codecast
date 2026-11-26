// What ties work to a priority's milestone (prioritiesSchema `steps`) without
// waiting for the pass (Priorities v2 design doc, Backend shape 2 and 3).
//
// Evidence: a task a milestone names closing or reopening, a pull request it
// names merging or closing, and a done pin that names the milestone
// (`cast state --status done --serves pri-N/sK`, from the person-driven
// session mapped to it) each recompute that milestone at once, with
// `done_at` the evidence's own time (the close or drop, the merge, the pin
// that made it true), never the time a later pass noticed. A bare done pin
// means only "turn delivered": agents pin it every turn. A decision card
// answered is not evidence: cards are questions asked mid-work.
// The pass recomputes the same way after it writes a milestone whose done
// state it changed (priorityPassRun applyPlan), so a stale or wrong plan
// never undoes what tasks and pull requests say. The records
// decide in order: a milestone with tasks follows its tasks alone (as the
// pass does, lib/priorityPass stepDone); one with pull requests of its own
// workspace is done once none is open and one merged, and not done while one
// is open or once all it found closed unmerged; only one with neither
// is marked done by its sessions.
// Session evidence never reopens a milestone, and a milestone already done
// keeps its first done time. Evidence never touches a milestone the person
// marked done or not done, or dropped.
//
// Links: a session whose milestone is already known gets priority_id and
// priority_step_key when it is created or bound, and the session counts
// follow (lib/prioritySessionCount). A link is only ever to the session
// owner's own priority in the session's own workspace, the one the pass
// would map it in, and, as for the pass, never moves a session the person
// placed, onto a priority they said it is not part of, or onto a milestone
// they dropped.
//
// Every read is an index lookup: the records' linked sessions, and the
// newest OWN_READ priorities of the people concerned, read once per person
// and workspace per mutation.

import type { Doc, Id } from "../_generated/dataModel";
import type { PriorityRef } from "@codecast/shared/contracts/priorities";
import { attributePlans, type PlanFacts } from "@codecast/shared/contracts/priorityDerive";
import { stepDone } from "./priorityPass";
import { sessionVisibility } from "./prioritySessionVisibility";
import { moveSessionCount } from "./prioritySessionCount";
import { passActivity, pinsAskForPass, prioritiesOn, prioritiesPossibleFor } from "./priorityPassSchedule";
import { classifierReads } from "./priorityClassifierHook";

type Ctx = { db: any };
type Priority = Doc<"priorities">;
type Step = Priority["steps"][number];
type Conv = Doc<"conversations">;

/** The most of one person's priorities in one workspace a hook reads, the most recently active first. */
const OWN_READ = 100;
/** The most sessions linked to one task or pull request a hook follows to their owners. */
const LINKED_SESSIONS = 20;
/** A plan with more tasks than this is never one milestone's plan (the design doc's plan attribution, rule 3). */
const MILESTONE_PLAN_MAX_TASKS = 40;

/**
 * One read per (person, workspace) for the length of a mutation, so a cascade
 * closing fifty tasks reads each owner's priorities once. Callers use only
 * what a mutation's own writes here never change (ids, owner, workspace,
 * status, step keys and refs); recomputeStepDone re-reads the row it writes.
 */
const ownReads = new WeakMap<object, Map<string, Promise<Priority[]>>>();

function ownPriorities(ctx: Ctx, userId: Id<"users">, workspace: string): Promise<Priority[]> {
  let reads = ownReads.get(ctx.db);
  if (!reads) ownReads.set(ctx.db, (reads = new Map()));
  const key = `${userId}|${workspace}`;
  if (!reads.has(key)) {
    reads.set(key, ctx.db
      .query("priorities")
      .withIndex("by_user_workspace_active", (q: any) => q.eq("user_id", userId).eq("workspace", workspace))
      .order("desc")
      .take(OWN_READ)
      // Active ones first, each group most recently active first.
      .then((rows: Priority[]) => rows.filter((p) => p.status !== "merged").sort((a, b) => Number(b.status === "active") - Number(a.status === "active"))));
  }
  return reads.get(key)!;
}

type Place = { user: Id<"users">; workspace: string };

/** Every milestone naming `ref` among each person's priorities in the workspace given with them. */
async function stepsNaming(ctx: Ctx, places: Place[], ref: PriorityRef): Promise<Array<{ priority: Id<"priorities">; key: string }>> {
  const seen = new Set<string>();
  const out: Array<{ priority: Id<"priorities">; key: string }> = [];
  for (const { user, workspace } of places) {
    if (seen.has(`${user}|${workspace}`)) continue;
    seen.add(`${user}|${workspace}`);
    for (const p of await ownPriorities(ctx, user, workspace)) {
      for (const s of p.steps) if (s.refs.some((r) => r.kind === ref.kind && r.id === ref.id)) out.push({ priority: p._id, key: s.key });
    }
  }
  return out;
}

/** The sessions behind these ids, at most LINKED_SESSIONS of them. */
async function sessionsOf(ctx: Ctx, ids: Array<Id<"conversations"> | undefined>): Promise<Conv[]> {
  const out: Conv[] = [];
  for (const id of [...new Set(ids.filter(Boolean).map(String))].slice(0, LINKED_SESSIONS)) {
    const conv: Conv | null = await ctx.db.get(id as Id<"conversations">);
    if (conv) out.push(conv);
  }
  return out;
}

/** A pull request counts only toward a priority in its own team's workspace, or, with no team, a personal one. */
const prInWorkspace = (pr: Doc<"pull_requests">, workspace: string) => (pr.team_id ? workspace === `team:${pr.team_id}` : workspace.startsWith("user:"));

/** `session`: the done came from a pin naming the milestone, which the pass then keeps (done_set_by "evidence"). */
type Evidence = { done: true; at: number; session?: true } | { done: false } | null;

/**
 * What the milestone's records say: done (since when its done condition
 * became true: the latest of the closes, drops and merges that make it so),
 * not done, or nothing (left to the pass).
 */
async function evidenceFor(ctx: Ctx, p: Priority, step: Step, sessionAt: number | undefined): Promise<Evidence> {
  const tasks = step.refs.filter((r) => r.kind === "task");
  if (tasks.length) {
    const status = new Map<string, string>();
    let at = 0;
    for (const r of tasks) {
      const t: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", r.id)).first();
      if (!t || t.workspace !== p.workspace) continue;
      status.set(r.id, t.status);
      if (t.status === "done" || t.status === "dropped") at = Math.max(at, t.closed_at ?? t.updated_at);
    }
    return stepDone(step.refs, undefined, status) ? { done: true, at } : { done: false };
  }
  // A milestone naming pull requests follows them alone, even ones not found (yet): never a pin.
  if (step.refs.some((r) => r.kind === "pr")) {
    let at = 0;
    let merged = false;
    let open = false;
    let resolved = false;
    for (const r of step.refs) {
      const m = r.kind === "pr" ? /^(.+)#(\d+)$/.exec(r.id) : null;
      if (!m) continue;
      const pr: Doc<"pull_requests"> | null = await ctx.db.query("pull_requests").withIndex("by_repository_number", (q: any) => q.eq("repository", m[1]).eq("number", Number(m[2]))).first();
      if (!pr || !prInWorkspace(pr, p.workspace)) continue;
      resolved = true;
      if (pr.state === "open") open = true;
      else {
        merged ||= pr.state === "merged";
        at = Math.max(at, (pr.state === "merged" ? pr.merged_at : pr.closed_at) ?? pr.updated_at);
      }
    }
    // None found: nothing to say yet. One still open: not done. Else done once one merged.
    if (!resolved) return null;
    return !open && merged ? { done: true, at } : { done: false };
  }
  // A pin naming the milestone outranks a done the pass judged: the pin's own time, and the mark.
  if (sessionAt !== undefined && step.done_set_by !== "evidence") return { done: true, at: sessionAt, session: true };
  return null;
}

/**
 * Recompute one milestone's done state from its evidence and write it when it
 * moved. `sessionAt` is the time of session evidence (an answered decision, a
 * pin declared done) on a session mapped to it. Returns whether it wrote;
 * never for a milestone whose done state the person set, or one they dropped.
 */
export async function recomputeStepDone(ctx: Ctx, priorityId: Id<"priorities">, stepKey: string, sessionAt?: number): Promise<boolean> {
  const p: Priority | null = await ctx.db.get(priorityId);
  if (!p || p.status === "merged") return false;
  const i = p.steps.findIndex((s) => s.key === stepKey);
  if (i < 0) return false;
  const step = p.steps[i];
  if (step.done_set_by === "person" || step.dropped) return false;
  const evidence = await evidenceFor(ctx, p, step, sessionAt);
  if (!evidence) return false;
  // Tasks and pull requests decide on their own: a pin's mark goes when they speak.
  const { done_at: _, done_set_by, ...rest } = step;
  const base: Step = done_set_by && done_set_by !== "evidence" ? { ...rest, done_set_by } : rest;
  const next: Step = !evidence.done ? { ...base, done: false } : evidence.session ? { ...base, done: true, done_at: evidence.at, done_set_by: "evidence" } : { ...base, done: true, done_at: evidence.at };
  if (next.done === step.done && next.done_at === step.done_at && next.done_set_by === step.done_set_by) return false;
  await ctx.db.patch(p._id, { steps: p.steps.map((s, k) => (k === i ? next : s)), updated_at: Date.now() });
  return true;
}

// ── Evidence hooks ──────────────────────────────────────────────────────────

/**
 * A task closed or reopened (lib/taskWrite patchTask, issueSync, orgInit
 * setTaskStatus): every milestone naming it, among the priorities of its
 * owner and of the people whose sessions link it, in the task's workspace
 * (the only workspace whose pass can name it, wherever those sessions are).
 * Each of those people's pass there is asked for (lib/priorityPassSchedule),
 * unless the session that made the change is a machine's (a role's seat, a
 * trigger's run, a workflow's): those come round the clock (pinsAskForPass).
 */
export async function taskStatusChanged(ctx: Ctx & { scheduler?: any }, task: Pick<Doc<"tasks">, "_id" | "short_id" | "user_id" | "workspace" | "conversation_ids" | "created_from_conversation">, acting?: Conv | Id<"conversations"> | null): Promise<void> {
  const workspace = task.workspace;
  if (!workspace || !(await prioritiesOn(ctx, workspace))) return;
  const rail: Array<{ conversation_id: Id<"conversations"> }> = await ctx.db
    .query("entity_conversations")
    .withIndex("by_entity", (q: any) => q.eq("entity_type", "task").eq("entity_id", String(task._id)))
    .take(LINKED_SESSIONS);
  const sessions = await sessionsOf(ctx, [...(task.conversation_ids ?? []), task.created_from_conversation, ...rail.map((r) => r.conversation_id)]);
  const places = [task.user_id, ...sessions.map((c) => c.user_id)].map((user) => ({ user, workspace }));
  for (const { priority, key } of await stepsNaming(ctx, places, { kind: "task", id: task.short_id })) await recomputeStepDone(ctx, priority, key);
  // The acting session, read only now that priorities is on here (a caller may hand its id).
  const actor: Conv | null = typeof acting === "string" ? await ctx.db.get(acting) : acting ?? null;
  if (actor && !pinsAskForPass(actor)) return;
  for (const { user } of places) await passActivity(ctx, user, workspace);
}

/**
 * A pull request merged or closed unmerged (prShepherd patchPullRequest): every
 * milestone naming it, among the priorities of the people whose sessions link
 * it, in the one workspace a PR counts in (prInWorkspace): its team's, or with
 * no team each person's own, wherever the linking session is listed.
 */
export async function pullRequestClosed(ctx: Ctx, pr: Doc<"pull_requests">): Promise<void> {
  // A team's PR counts only there: its flag first, one read. A PR with no team (the schema requires one; older rows) counts in each linking owner's personal workspace, whose flag each is read before its milestones.
  if (pr.team_id && !(await prioritiesOn(ctx, `team:${pr.team_id}`))) return;
  const sessions = await sessionsOf(ctx, [pr.shepherd_conversation_id, ...pr.linked_session_ids]);
  const places = [];
  for (const c of sessions) {
    const workspace = pr.team_id ? `team:${pr.team_id}` : `user:${c.user_id}`;
    if (pr.team_id || (await prioritiesOn(ctx, workspace))) places.push({ user: c.user_id, workspace });
  }
  for (const { priority, key } of await stepsNaming(ctx, places, { kind: "pr", id: `${pr.repository}#${pr.number}` })) await recomputeStepDone(ctx, priority, key);
}

/** A worker another session started (`cast spawn`), or a Task-tool subagent: a plan handoff or a fork (parent_message_uuid) is the person's own session from there. */
const isWorker = (c: Conv) => !!c.is_subagent || (!!c.parent_conversation_id && !c.parent_message_uuid);
/** A person drives it: not a role's seat, a trigger's run, a workflow's, a worker or a subagent. */
const personDriven = (c: Conv) => pinsAskForPass(c) && !isWorker(c);

/**
 * What a done pin naming its session's milestone did: closed it, or why not.
 * `decided_by`: the milestone closes with its tasks or pull requests, never a
 * pin. Refused: a worker's or a machine's pin, or a milestone already done (by
 * a pin or the person) or one the person marked not done.
 */
export type ServesOutcome = { closed: true } | { refused: "worker" | "machine" | "done" | "person" } | { decided_by: "tasks" | "pull_requests" };

/**
 * A pin declared done on `conv` at `at`, naming what it finished (`serves`,
 * "pri-N/sK"): evidence for its milestone only when that is the milestone the
 * session is mapped to and the session is person-driven. Without the name a
 * done pin closes nothing (null: nothing to report beyond what setThreadState
 * says about the name).
 */
export async function sessionEvidence(ctx: Ctx, conv: Conv | null, at: number, serves: string | undefined): Promise<ServesOutcome | null> {
  if (!serves || !conv?.priority_id || !conv.priority_step_key) return null;
  const p: Priority | null = await ctx.db.get(conv.priority_id);
  const step = p?.steps.find((s) => s.key === conv.priority_step_key && !s.dropped);
  // With priorities off where the priority is, a pin closes nothing and says nothing.
  if (!p || !step || serves !== `${p.short_id}/${step.key}` || !(await prioritiesOn(ctx, p.workspace))) return null;
  if (!pinsAskForPass(conv)) return { refused: "machine" };
  if (isWorker(conv)) return { refused: "worker" };
  if (step.refs.some((r) => r.kind === "task")) return { decided_by: "tasks" };
  if (step.refs.some((r) => r.kind === "pr")) return { decided_by: "pull_requests" };
  if (step.done_set_by === "person") return { refused: step.done ? "done" : "person" };
  if (step.done_set_by === "evidence") return { refused: "done" };
  await recomputeStepDone(ctx, p._id, step.key, at);
  return { closed: true };
}

/**
 * A session just mapped to a milestone: its newest pin, when that is a done
 * pin naming that milestone (`--serves pri-N/sK`, pinned before the link),
 * counts now, at the pin's own time, as it would have had the link been
 * there. A later pin that moved on (working again, or naming no milestone)
 * takes it back.
 */
export async function replayDonePin(ctx: Ctx, conv: Conv, priorityId: Id<"priorities">, stepKey: string | undefined): Promise<void> {
  if (!stepKey || !personDriven(conv)) return;
  const p: Priority | null = await ctx.db.get(priorityId);
  if (!p) return;
  const serves = `${p.short_id}/${stepKey}`;
  const pin: Doc<"thread_state_events"> | null = await ctx.db.query("thread_state_events").withIndex("by_conversation_at", (q: any) => q.eq("conversation_id", conv._id)).order("desc").first();
  if (pin?.status === "done" && pin.serves === serves) await recomputeStepDone(ctx, priorityId, stepKey, pin.at);
}

/**
 * The open milestone a session is mapped to, for a done pin that did not
 * name one (`cast state` prints how to: re-pin with --serves). Null when it
 * is mapped to none, or to one already done, dropped or gone.
 */
export async function unnamedMilestone(ctx: Ctx, conv: Conv): Promise<{ serves: string; title: string } | null> {
  if (!conv.priority_id || !conv.priority_step_key) return null;
  const p: Priority | null = await ctx.db.get(conv.priority_id);
  const step = p?.steps.find((s) => s.key === conv.priority_step_key);
  return p && step && !step.done && !step.dropped ? { serves: `${p.short_id}/${step.key}`, title: step.title } : null;
}

/** The live milestone a session is mapped to, as `--serves` names it ("pri-N/sK"), or null when it is mapped to none, or to one the person dropped. */
export async function mappedMilestone(ctx: Ctx, conv: Conv): Promise<string | null> {
  if (!conv.priority_id || !conv.priority_step_key) return null;
  const p: Priority | null = await ctx.db.get(conv.priority_id);
  const step = p?.steps.find((s) => s.key === conv.priority_step_key);
  return p && step && !step.dropped ? `${p.short_id}/${step.key}` : null;
}

// ── Links ───────────────────────────────────────────────────────────────────

/** Who linked a session, weakest first: the pass (unmarked), the classifier, a known link, the person. */
const STRENGTH = { pass: 0, classifier: 1, link: 2, person: 3 } as const;
type LinkedBy = "link" | "classifier" | "pass";
const strengthOf = (by: Conv["priority_set_by"]) => STRENGTH[by ?? "pass"];

/**
 * Map a session to its owner's priority (and milestone, when it still has
 * that one) in the session's own workspace, keeping both priorities' session
 * counts, and mark who linked it: a known link ("link"), the classifier
 * (priorityClassifier.ts), or the pass's strength (unmarked, for a fork of a
 * session the pass placed). Precedence: the person > a known link > the
 * classifier > the pass, so a link never overwrites a stronger one, the
 * classifier maps only a session mapped nowhere, and the pass moves neither a
 * link nor the classifier's (priorityPassRun applyPlan). Refused (false) for
 * a session the person placed, someone else's priority, a merged one, one the
 * person said the session is not part of, a milestone they dropped, or
 * another workspace; a no-op when the session is already there, linked the
 * same way. It reads the
 * priority itself: callers find it in the per-mutation cache (ownPriorities),
 * whose rows may be stale on anything but ids, refs and keys.
 */
export async function linkSession(ctx: Ctx, conv: Conv, priorityId: Id<"priorities">, step: string | undefined, by: LinkedBy = "link"): Promise<boolean> {
  if (strengthOf(conv.priority_set_by) > STRENGTH[by] || (by === "classifier" && conv.priority_id)) return false;
  if ((conv.priority_not ?? []).some((id) => String(id) === String(priorityId))) return false;
  const priority: Priority | null = await ctx.db.get(priorityId);
  if (!priority || priority.status === "merged" || String(priority.user_id) !== String(conv.user_id) || !(await prioritiesOn(ctx, priority.workspace))) return false;
  const target = priority.steps.find((s) => s.key === step);
  if (target?.dropped) return false;
  const stepKey = target ? step : undefined;
  const set_by = by === "pass" ? undefined : by;
  if (String(conv.priority_id ?? "") === String(priority._id) && conv.priority_step_key === stepKey && (conv.priority_set_by ?? "pass") === by) return false;
  if ((await sessionVisibility(ctx).workspaceOf(conv)) !== priority.workspace) return false;
  await ctx.db.patch(conv._id, { priority_id: priority._id, priority_step_key: stepKey, priority_set_by: set_by });
  await moveSessionCount(ctx, conv.priority_id, priority._id);
  await replayDonePin(ctx, conv, priority._id, stepKey);
  return true;
}

/** A session `starter` started from a milestone's Start (dispatch createSession `priority`, `priority_step`): only on a priority of their own. */
export async function linkFromStart(ctx: Ctx, starter: Id<"users">, convId: Id<"conversations">, shortId: string, stepKey: string | undefined): Promise<boolean> {
  const p: Priority | null = await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId.trim().toLowerCase())).first();
  if (!p || String(p.user_id) !== String(starter)) return false;
  const conv: Conv | null = await ctx.db.get(convId);
  return !!conv && linkSession(ctx, conv, p._id, stepKey);
}

/** What the plan attribution rules read of a plan (priorityDerive PlanFacts). */
export function planFactsOf(plan: Doc<"plans">): PlanFacts {
  const size = Math.max(plan.task_ids?.length ?? 0, plan.progress?.total ?? 0);
  return { id: String(plan._id), short_id: plan.short_id, title: plan.title, status: plan.status, done: plan.progress?.done ?? 0, total: plan.progress?.total ?? size, size };
}

/**
 * The plan a Start on a milestone may bind its session to: the milestone's own
 * plan by the list's attribution rules (priorityDerive attributePlans), else
 * the priority's plan. Null when neither is attributed or the milestone is
 * gone, so a link naming any other plan binds nothing.
 */
export async function startPlanId(ctx: Ctx, shortId: string, stepKey: string | undefined): Promise<string | null> {
  const p: Priority | null = await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId.trim().toLowerCase())).first();
  const steps = (p?.steps ?? []).filter((s) => !s.dropped);
  if (!steps.some((s) => s.key === stepKey)) return null;
  const facts = new Map<string, PlanFacts>();
  const taskPlans = new Map<string, Array<string | null>>();
  for (const s of steps) {
    const plans: Array<string | null> = [];
    for (const ref of s.refs) {
      if (ref.kind !== "task") continue;
      const task: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ref.id)).first();
      const id = task?.plan_id ? String(task.plan_id) : null;
      if (id && !facts.has(id)) {
        const plan: Doc<"plans"> | null = await ctx.db.get(id as Id<"plans">);
        if (plan) facts.set(id, planFactsOf(plan));
      }
      plans.push(id && facts.has(id) ? id : null);
    }
    taskPlans.set(s.key, plans);
  }
  const attribution = attributePlans(steps.map((s) => ({ key: s.key, taskPlans: taskPlans.get(s.key)! })), (id) => facts.get(id));
  return (attribution.steps.get(stepKey!)?.plan ?? attribution.priority)?.id ?? null;
}

/**
 * A session bound to a task (lib/taskOwner claimTaskOwnership, `cast task start`): the first milestone naming the task, active priorities first.
 * Never a role's seat, a trigger's run, a workflow's session or a subagent (classifierReads): their work is not the person's.
 */
export async function linkFromTask(ctx: Ctx, conv: Conv, task: Pick<Doc<"tasks">, "short_id">): Promise<boolean> {
  if (!classifierReads(conv) || !(await prioritiesPossibleFor(ctx, conv))) return false;
  const workspace = await sessionVisibility(ctx).workspaceOf(conv);
  for (const p of await ownPriorities(ctx, conv.user_id, workspace)) {
    const step = p.steps.find((s) => !s.dropped && s.refs.some((r) => r.kind === "task" && r.id === task.short_id));
    if (step) return linkSession(ctx, conv, p._id, step.key);
  }
  return false;
}

/**
 * A session bound to a plan (plans.bindSession) and mapped nowhere yet: the
 * first milestone the plan is the plan of, by the design doc's attribution
 * rules 1 and 3 (not abandoned; at most MILESTONE_PLAN_MAX_TASKS tasks; holds
 * at least half of the milestone's tasks). A session already mapped keeps its
 * mapping: a plan is a weaker sign than the link it has. As for a task, only
 * a session the classifier would read.
 */
export async function linkFromPlan(ctx: Ctx, conv: Conv, plan: Pick<Doc<"plans">, "_id" | "status">): Promise<boolean> {
  if (conv.priority_id || plan.status === "abandoned" || !classifierReads(conv) || !(await prioritiesPossibleFor(ctx, conv))) return false;
  const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).take(MILESTONE_PLAN_MAX_TASKS + 1);
  if (!tasks.length || tasks.length > MILESTONE_PLAN_MAX_TASKS) return false;
  const inPlan = new Set(tasks.map((t) => t.short_id));
  const workspace = await sessionVisibility(ctx).workspaceOf(conv);
  for (const p of await ownPriorities(ctx, conv.user_id, workspace)) {
    for (const s of p.steps) {
      if (s.dropped) continue;
      const refs = s.refs.filter((r) => r.kind === "task");
      if (refs.length && refs.filter((r) => inPlan.has(r.id)).length * 2 >= refs.length) return linkSession(ctx, conv, p._id, s.key);
    }
  }
  return false;
}

/**
 * A fork, a `cast spawn` worker or a handoff of `parentId` starts under the
 * parent's priority and milestone, as strongly as the parent holds it: the
 * person's placement or a known link becomes a known link, the classifier's
 * stays the classifier's, and the pass's stays the pass's to move. A
 * Task-tool subagent the daemon syncs does not: it rolls up under its parent
 * and is never counted on its own.
 */
export async function inheritLink(ctx: Ctx, childId: Id<"conversations">, parentId: Id<"conversations"> | undefined, ownerId: Id<"users">): Promise<boolean> {
  // The flag first: with priorities on in none of the owner's workspaces, the parent is never read.
  if (!parentId || !(await prioritiesOn(ctx, `user:${ownerId}`))) return false;
  const parent: Conv | null = await ctx.db.get(parentId);
  if (!parent?.priority_id) return false;
  const child: Conv | null = await ctx.db.get(childId);
  const by: LinkedBy = parent.priority_set_by === "person" || parent.priority_set_by === "link" ? "link" : parent.priority_set_by === "classifier" ? "classifier" : "pass";
  return !!child && linkSession(ctx, child, parent.priority_id, parent.priority_step_key, by);
}
