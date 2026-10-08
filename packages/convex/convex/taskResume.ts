// What a session bound to a task needs back after compaction or a resume
// (docs/architecture/task-graph.md TG10): the task, whether the session still
// holds it, what still blocks it, its last progress note, and its plan with
// the next step that can start. One lean read for the SessionStart hook
// (packages/cli/src/taskContextHook.ts), which waits on it with a short
// timeout; `cast task context` is the full one.

import { v } from "convex/values";
import { query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { canAccessPlan, canAccessTask, isSameWorkspace, resolveSessionConversation, workspaceForResource } from "./lib/access";
import { readinessLookups, readyTasks } from "./lib/taskGraph";
import { orderFrontier } from "./lib/taskFrontier";
import { blockersOf, isActiveTask, isBlocking, type TaskResumeContext } from "@codecast/shared/tasks";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/** How many recent comments are searched for the last progress note. */
const COMMENT_SCAN = 50;

export const context = query({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    /** The plan the session is bound to, when the task names none. */
    plan_id: v.optional(v.string()),
    /** The asking session: whether it still holds the task, and its own ephemeral steps. */
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<TaskResumeContext | null> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const task = await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", args.short_id)).first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) return null;
    const session = args.session_id ? await resolveSessionConversation(ctx, auth.userId, args.session_id) : null;

    // readinessLookups keeps any row in the task's workspace; only one the
    // caller may read lends its title. Status always ships, as readiness does.
    const { statusOf } = await readinessLookups(ctx, [task]);
    const blockers: TaskResumeContext["blockers"] = [];
    for (const b of blockersOf(task, statusOf).filter(isBlocking)) {
      const row = b.kind === "task" ? statusOf(b.ref) : null;
      const readable = row && typeof row === "object" && (await canAccessTask(ctx, auth.userId, row as Doc<"tasks">));
      blockers.push(readable ? { ...b, title: (row as Doc<"tasks">).title } : b);
    }

    const recent = await ctx.db
      .query("task_comments")
      .withIndex("by_task_created", (q) => q.eq("task_id", task._id))
      .order("desc")
      .take(COMMENT_SCAN);
    const note = recent.find((c) => c.comment_type === "progress");

    return {
      task: { short_id: task.short_id, title: task.title, status: task.status, priority: task.priority },
      ...(session ? { held: session.active_task_id === task._id } : {}),
      blockers,
      progress: note ? { text: note.text, author: note.author, created_at: note.created_at } : null,
      plan: await planOf(ctx, auth.userId, task, args.plan_id, session),
    };
  },
});

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
