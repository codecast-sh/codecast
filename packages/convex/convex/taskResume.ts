// What a session bound to a task needs back after compaction or a resume
// (docs/architecture/task-graph.md TG10): the task it holds (else the one its
// pulse names), whether it still holds it, what still blocks it, its open
// subtasks, its last progress note, and its plan with the next step that can
// start. One lean read for the SessionStart hook
// (packages/cli/src/taskContextHook.ts), which waits on it with a short
// timeout; `cast task context` is the full one.

import { v } from "convex/values";
import { query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { canAccessPlan, canAccessTask, isSameWorkspace, resolveSessionConversation, workspaceForResource } from "./lib/access";
import { readinessLookups, readyTasks } from "./lib/taskGraph";
import { orderFrontier } from "./lib/taskFrontier";
import { boundSessionsOf } from "./lib/taskOwner";
import { blockersOf, isActiveTask, isBlocking, isTerminalTaskStatus, type TaskResumeContext } from "@codecast/shared/tasks";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/** How many recent comments are searched for the last progress note. */
const COMMENT_SCAN = 50;
/** How many open subtasks the block lists. */
const SUBTASKS_SHOWN = 5;
const SUBTASK_SCAN = 100;

export const context = query({
  args: {
    api_token: v.string(),
    /** The task in the session's pulse: the last one it started or filed. */
    short_id: v.optional(v.string()),
    /** The plan the session is bound to, when the task names none. */
    plan_id: v.optional(v.string()),
    /** The asking session: the task it holds, and its own ephemeral steps. */
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<TaskResumeContext | null> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const readable = async (t: Doc<"tasks"> | null) => (t && (await canAccessTask(ctx, auth.userId, t)) ? t : null);
    const session = args.session_id ? await resolveSessionConversation(ctx, auth.userId, args.session_id) : null;
    const pulsed = args.short_id
      ? await readable(await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", args.short_id!)).first())
      : null;
    // The binding on the conversation is the truth; the pulse only names the
    // task the session touched last, which may be one it merely filed. A
    // session the server spawned for a task has no pulse at all.
    const heldTask = session?.active_task_id ? await readable(await ctx.db.get(session.active_task_id)) : null;
    const task = heldTask ?? pulsed;
    if (!task) return null;

    // readinessLookups keeps any row in the task's workspace; only one the
    // caller may read lends its title. Status always ships, as readiness does.
    const { statusOf } = await readinessLookups(ctx, [task]);
    const blockers: TaskResumeContext["blockers"] = [];
    for (const b of blockersOf(task, statusOf).filter(isBlocking)) {
      const row = b.kind === "task" ? statusOf(b.ref) : null;
      const titled = row && typeof row === "object" && (await readable(row as Doc<"tasks">));
      blockers.push(titled ? { ...b, title: titled.title } : b);
    }

    const recent = await ctx.db
      .query("task_comments")
      .withIndex("by_task_created", (q) => q.eq("task_id", task._id))
      .order("desc")
      .take(COMMENT_SCAN);
    const noteAt = recent.findIndex((c) => c.comment_type === "progress");
    const note = noteAt >= 0 ? recent[noteAt] : null;
    const newer = noteAt >= 0 ? recent.slice(0, noteAt) : recent;

    return {
      task: { short_id: task.short_id, title: task.title, status: task.status, priority: task.priority },
      ...(session ? await bindingOf(ctx, session, task, heldTask) : {}),
      ...(heldTask && pulsed && pulsed._id !== heldTask._id ? { recent: { short_id: pulsed.short_id, title: pulsed.title, status: pulsed.status } } : {}),
      blockers,
      subtasks: await openSubtasks(ctx, task, readable),
      progress: note ? { text: note.text, author: note.author, created_at: note.created_at } : null,
      newer: newer.length ? { count: newer.length, latest: { type: newer[0].comment_type, author: newer[0].author } } : null,
      plan: await planOf(ctx, auth.userId, task, args.plan_id, session),
    };
  },
});

/** Whether the session holds the task and, when it does not, whether it lost
 *  it: the task closed, or another session holds it. A task the session only
 *  filed was never its to lose. */
async function bindingOf(
  ctx: QueryCtx,
  session: Doc<"conversations">,
  task: Doc<"tasks">,
  heldTask: Doc<"tasks"> | null,
): Promise<Pick<TaskResumeContext, "held" | "lost">> {
  if (heldTask) return { held: true };
  if (isTerminalTaskStatus(task.status)) return { held: false, lost: "closed" };
  const owners = await boundSessionsOf(ctx, task);
  return owners.some((c) => c._id !== session._id) ? { held: false, lost: "claimed" } : { held: false };
}

/** The first open subtasks the caller may read, in the order they were filed. */
async function openSubtasks(
  ctx: QueryCtx,
  task: Doc<"tasks">,
  readable: (t: Doc<"tasks"> | null) => Promise<Doc<"tasks"> | null>,
): Promise<NonNullable<TaskResumeContext["subtasks"]>> {
  const children = await ctx.db.query("tasks").withIndex("by_parent_id", (q) => q.eq("parent_id", task._id)).take(SUBTASK_SCAN);
  const open: Doc<"tasks">[] = [];
  for (const c of children) {
    if (!isTerminalTaskStatus(c.status) && isActiveTask(c) && (await readable(c))) open.push(c);
  }
  return {
    items: open.slice(0, SUBTASKS_SHOWN).map((c) => ({ short_id: c.short_id, title: c.title, status: c.status })),
    more: Math.max(0, open.length - SUBTASKS_SHOWN),
  };
}

/** The task's plan (else the bound one), how far along it is, and the step
 *  `cast task ready --plan` would hand this session first: the same members
 *  (plan.task_ids, so no subtasks) and the same readiness. */
async function planOf(
  ctx: QueryCtx,
  userId: Id<"users">,
  task: Doc<"tasks">,
  boundPlan: string | undefined,
  session: Doc<"conversations"> | null,
): Promise<TaskResumeContext["plan"]> {
  const plan: Doc<"plans"> | null = task.plan_id
    ? await ctx.db.get(task.plan_id)
    : boundPlan
      ? await ctx.db.query("plans").withIndex("by_short_id", (q) => q.eq("short_id", boundPlan)).first()
      : session?.active_plan_id
        ? await ctx.db.get(session.active_plan_id)
        : null;
  if (!plan || !(await canAccessPlan(ctx, userId, plan))) return null;
  const rows = await Promise.all((plan.task_ids ?? []).map((id) => ctx.db.get(id)));
  const steps: Doc<"tasks">[] = [];
  for (const t of rows) {
    if (t && isActiveTask(t) && isSameWorkspace(t, workspaceForResource(plan)) && (await canAccessTask(ctx, userId, t))) steps.push(t);
  }
  const counted = steps.filter((t) => t.status !== "dropped");
  const readiness = { viewer: String(userId), viewerSession: session ? String(session._id) : null };
  const ready = (await readyTasks(ctx, steps, readiness)).ready.filter((t) => t._id !== task._id);
  const next = (await orderFrontier(ctx, ready, Date.now()))[0];
  return {
    short_id: plan.short_id,
    title: plan.title,
    status: plan.status,
    done: counted.filter((t) => t.status === "done").length,
    total: counted.length,
    next: next ? { short_id: next.short_id, title: next.title, priority: next.priority } : null,
  };
}
