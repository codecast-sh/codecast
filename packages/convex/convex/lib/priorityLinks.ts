// What ties work to a priority's milestone (prioritiesSchema `steps`) without
// waiting for the pass (Priorities v2 design doc, Backend shape 2 and 3).
//
// Evidence: a task a milestone names closing or reopening, a pull request it
// names merging, and a decision answered or a pin declared done on a session
// mapped to it each recompute that milestone at once, with `done_at` the
// evidence's own time (the task's close, the merge, the answer, the pin),
// never the time a later pass noticed. The records decide in order: a
// milestone with tasks follows its tasks alone (as the pass does,
// lib/priorityPass stepDone); one with pull requests is done once none is
// open and one merged; only one with neither is marked done by its sessions.
// Session evidence never reopens a milestone, and a milestone already done
// keeps its first done time.
//
// Links: a session whose milestone is already known gets priority_id and
// priority_step_key when it is created or bound, and the session counts
// follow (lib/prioritySessionCount). A link is only ever to the session
// owner's own priority in the session's own workspace, the one the pass
// would map it in.
//
// Every read is an index lookup: the records' linked sessions, and those
// sessions' owners' newest OWN_READ priorities in their workspaces.

import type { Doc, Id } from "../_generated/dataModel";
import type { PriorityRef } from "@codecast/shared/contracts/priorities";
import { stepDone } from "./priorityPass";
import { sessionVisibility } from "./prioritySessionVisibility";
import { moveSessionCount } from "./prioritySessionCount";

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

async function ownPriorities(ctx: Ctx, userId: Id<"users">, workspace: string): Promise<Priority[]> {
  const rows: Priority[] = await ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_active", (q: any) => q.eq("user_id", userId).eq("workspace", workspace))
    .order("desc")
    .take(OWN_READ);
  // Active ones first, each group most recently active first.
  return rows.filter((p) => p.status !== "merged").sort((a, b) => Number(b.status === "active") - Number(a.status === "active"));
}

/** Every milestone naming `ref` among the priorities of the given sessions' owners, in each session's workspace. */
async function stepsNaming(ctx: Ctx, convIds: Array<Id<"conversations"> | undefined>, ref: PriorityRef): Promise<Array<{ priority: Id<"priorities">; key: string }>> {
  const vis = sessionVisibility(ctx);
  const ids = [...new Set(convIds.filter(Boolean).map(String))].slice(0, LINKED_SESSIONS);
  const pairs = new Set<string>();
  const out: Array<{ priority: Id<"priorities">; key: string }> = [];
  for (const id of ids) {
    const conv: Conv | null = await ctx.db.get(id as Id<"conversations">);
    if (!conv) continue;
    const workspace = await vis.workspaceOf(conv);
    const pair = `${conv.user_id}|${workspace}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    for (const p of await ownPriorities(ctx, conv.user_id, workspace)) {
      for (const s of p.steps) if (s.refs.some((r) => r.kind === ref.kind && r.id === ref.id)) out.push({ priority: p._id, key: s.key });
    }
  }
  return out;
}

type Evidence = { done: true; at: number } | { done: false } | null;

/** What the milestone's records say: done (and since when), not done, or nothing (left to the pass). */
async function evidenceFor(ctx: Ctx, p: Priority, step: Step, sessionAt: number | undefined): Promise<Evidence> {
  const tasks = step.refs.filter((r) => r.kind === "task");
  if (tasks.length) {
    const status = new Map<string, string>();
    let at = 0;
    for (const r of tasks) {
      const t: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", r.id)).first();
      if (!t || t.workspace !== p.workspace) continue;
      status.set(r.id, t.status);
      if (t.status === "done") at = Math.max(at, t.closed_at ?? t.updated_at);
    }
    return stepDone(step.refs, undefined, status) ? { done: true, at } : { done: false };
  }
  let mergedAt = 0;
  let open = false;
  for (const r of step.refs) {
    const m = r.kind === "pr" ? /^(.+)#(\d+)$/.exec(r.id) : null;
    if (!m) continue;
    const pr: Doc<"pull_requests"> | null = await ctx.db.query("pull_requests").withIndex("by_repository_number", (q: any) => q.eq("repository", m[1]).eq("number", Number(m[2]))).first();
    if (pr?.state === "merged") mergedAt = Math.max(mergedAt, pr.merged_at ?? pr.updated_at);
    else if (pr?.state === "open") open = true;
  }
  if (open) return null;
  if (mergedAt) return { done: true, at: mergedAt };
  if (sessionAt !== undefined && !step.done) return { done: true, at: sessionAt };
  return null;
}

/**
 * Recompute one milestone's done state from its evidence and write it when it
 * moved. `sessionAt` is the time of session evidence (an answered decision, a
 * pin declared done) on a session mapped to it. Returns whether it wrote.
 */
export async function recomputeStepDone(ctx: Ctx, priorityId: Id<"priorities">, stepKey: string, sessionAt?: number): Promise<boolean> {
  const p: Priority | null = await ctx.db.get(priorityId);
  if (!p || p.status === "merged") return false;
  const i = p.steps.findIndex((s) => s.key === stepKey);
  if (i < 0) return false;
  const step = p.steps[i];
  const evidence = await evidenceFor(ctx, p, step, sessionAt);
  if (!evidence) return false;
  const { done_at: _, ...rest } = step;
  const next: Step = evidence.done ? { ...rest, done: true, done_at: evidence.at } : { ...rest, done: false };
  if (next.done === step.done && next.done_at === step.done_at) return false;
  await ctx.db.patch(p._id, { steps: p.steps.map((s, k) => (k === i ? next : s)), updated_at: Date.now() });
  return true;
}

// ── Evidence hooks ──────────────────────────────────────────────────────────

/** A task closed or reopened (lib/taskWrite patchTask, issueSync): every milestone naming it, among the priorities of the people whose sessions link it. */
export async function taskStatusChanged(ctx: Ctx, task: Pick<Doc<"tasks">, "_id" | "short_id" | "conversation_ids" | "created_from_conversation">): Promise<void> {
  const rail: Array<{ conversation_id: Id<"conversations"> }> = await ctx.db
    .query("entity_conversations")
    .withIndex("by_entity", (q: any) => q.eq("entity_type", "task").eq("entity_id", String(task._id)))
    .take(LINKED_SESSIONS);
  const convs = [...(task.conversation_ids ?? []), task.created_from_conversation, ...rail.map((r) => r.conversation_id)];
  for (const { priority, key } of await stepsNaming(ctx, convs, { kind: "task", id: task.short_id })) await recomputeStepDone(ctx, priority, key);
}

/** A pull request merged (prShepherd patchPullRequest): every milestone naming it, among the priorities of the people whose sessions link it. */
export async function pullRequestMerged(ctx: Ctx, pr: Doc<"pull_requests">): Promise<void> {
  const convs = [pr.shepherd_conversation_id, ...pr.linked_session_ids];
  for (const { priority, key } of await stepsNaming(ctx, convs, { kind: "pr", id: `${pr.repository}#${pr.number}` })) await recomputeStepDone(ctx, priority, key);
}

/** A decision answered or a pin declared done on `conv` at `at`: its milestone, when it is mapped to one. */
export async function sessionEvidence(ctx: Ctx, conv: Pick<Conv, "priority_id" | "priority_step_key"> | null, at: number): Promise<void> {
  if (conv?.priority_id && conv.priority_step_key) await recomputeStepDone(ctx, conv.priority_id, conv.priority_step_key, at);
}

// ── Links ───────────────────────────────────────────────────────────────────

/**
 * Map a session to its owner's priority (and milestone, when it still has
 * that one) in the session's own workspace, keeping both priorities' session
 * counts. Refused (false) for someone else's priority, a merged one, or
 * another workspace; a no-op when the session is already there.
 */
export async function linkSession(ctx: Ctx, conv: Conv, priority: Priority, step: string | undefined): Promise<boolean> {
  if (priority.status === "merged" || String(priority.user_id) !== String(conv.user_id)) return false;
  const stepKey = priority.steps.some((s) => s.key === step) ? step : undefined;
  if (String(conv.priority_id ?? "") === String(priority._id) && conv.priority_step_key === stepKey) return false;
  if ((await sessionVisibility(ctx).workspaceOf(conv)) !== priority.workspace) return false;
  await ctx.db.patch(conv._id, { priority_id: priority._id, priority_step_key: stepKey });
  await moveSessionCount(ctx, conv.priority_id, priority._id);
  return true;
}

/** A session `starter` started from a milestone's Start (dispatch createSession `priority`, `priority_step`): only on a priority of their own. */
export async function linkFromStart(ctx: Ctx, starter: Id<"users">, convId: Id<"conversations">, shortId: string, stepKey: string | undefined): Promise<boolean> {
  const p: Priority | null = await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId.trim().toLowerCase())).first();
  if (!p || String(p.user_id) !== String(starter)) return false;
  const conv: Conv | null = await ctx.db.get(convId);
  return !!conv && linkSession(ctx, conv, p, stepKey);
}

/** A session bound to a task (lib/taskOwner claimTaskOwnership, `cast task start`): the first milestone naming the task, active priorities first. */
export async function linkFromTask(ctx: Ctx, conv: Conv, task: Pick<Doc<"tasks">, "short_id">): Promise<boolean> {
  const workspace = await sessionVisibility(ctx).workspaceOf(conv);
  for (const p of await ownPriorities(ctx, conv.user_id, workspace)) {
    const step = p.steps.find((s) => s.refs.some((r) => r.kind === "task" && r.id === task.short_id));
    if (step) return linkSession(ctx, conv, p, step.key);
  }
  return false;
}

/**
 * A session bound to a plan (plans.bindSession) and mapped nowhere yet: the
 * first milestone the plan is the plan of, by the design doc's attribution
 * rules 1 and 3 (not abandoned; at most MILESTONE_PLAN_MAX_TASKS tasks; holds
 * at least half of the milestone's tasks). A session already mapped keeps its
 * mapping: a plan is a weaker sign than the link it has.
 */
export async function linkFromPlan(ctx: Ctx, conv: Conv, plan: Pick<Doc<"plans">, "_id" | "status">): Promise<boolean> {
  if (conv.priority_id || plan.status === "abandoned") return false;
  const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).take(MILESTONE_PLAN_MAX_TASKS + 1);
  if (!tasks.length || tasks.length > MILESTONE_PLAN_MAX_TASKS) return false;
  const inPlan = new Set(tasks.map((t) => t.short_id));
  const workspace = await sessionVisibility(ctx).workspaceOf(conv);
  for (const p of await ownPriorities(ctx, conv.user_id, workspace)) {
    for (const s of p.steps) {
      const refs = s.refs.filter((r) => r.kind === "task");
      if (refs.length && refs.filter((r) => inPlan.has(r.id)).length * 2 >= refs.length) return linkSession(ctx, conv, p, s.key);
    }
  }
  return false;
}

/** A fork, subagent or handoff of `parentId` starts under the parent's priority and milestone. */
export async function inheritLink(ctx: Ctx, childId: Id<"conversations">, parentId: Id<"conversations"> | undefined): Promise<boolean> {
  const parent: Conv | null = parentId ? await ctx.db.get(parentId) : null;
  if (!parent?.priority_id) return false;
  const [child, p]: [Conv | null, Priority | null] = [await ctx.db.get(childId), await ctx.db.get(parent.priority_id)];
  return !!child && !!p && linkSession(ctx, child, p, parent.priority_step_key);
}
