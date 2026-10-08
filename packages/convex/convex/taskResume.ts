// What a session bound to a task needs back after compaction or a resume
// (docs/architecture/task-graph.md TG10): the task, what still holds it, its
// last progress note, and its plan with the next step that can start. One
// lean read for the SessionStart hook (packages/cli/src/taskContextHook.ts),
// which waits on it with a short timeout; `cast task context` is the full one.

import { v } from "convex/values";
import { query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { canAccessPlan, canAccessTask, isSameWorkspace, workspaceForResource } from "./lib/access";
import { readinessLookups, readyTasks } from "./lib/taskGraph";
import { orderFrontier } from "./lib/taskFrontier";
import { blockersOf, isActiveTask, isBlocking, type Blocker } from "@codecast/shared/tasks";
import type { Doc } from "./_generated/dataModel";

/** How far back the last progress note is looked for. */
const COMMENT_SCAN = 50;

export type TaskResumeBlocker = Blocker & { title?: string };

export type TaskResumeContext = {
  task: { short_id: string; title: string; status: string; priority: string };
  blockers: TaskResumeBlocker[];
  progress: { text: string; author: string; created_at: number } | null;
  plan: {
    short_id: string;
    title: string;
    status: string;
    done: number;
    total: number;
    next: { short_id: string; title: string; priority: string } | null;
  } | null;
};

export const context = query({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    /** The plan the session is bound to, when the task names none. */
    plan_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<TaskResumeContext | null> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const task = await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", args.short_id)).first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) return null;

    const { statusOf } = await readinessLookups(ctx, [task]);
    const blockers = blockersOf(task, statusOf).filter(isBlocking).map((b): TaskResumeBlocker => {
      if (b.kind !== "task") return b;
      const row = statusOf(b.ref);
      return row && typeof row === "object" ? { ...b, title: (row as Doc<"tasks">).title } : b;
    });

    const recent = await ctx.db
      .query("task_comments")
      .withIndex("by_task_created", (q) => q.eq("task_id", task._id))
      .order("desc")
      .take(COMMENT_SCAN);
    const note = recent.find((c) => c.comment_type === "progress");

    return {
      task: { short_id: task.short_id, title: task.title, status: task.status, priority: task.priority },
      blockers,
      progress: note ? { text: note.text, author: note.author, created_at: note.created_at } : null,
      plan: await planOf(ctx, auth.userId, task, args.plan_id),
    };
  },
});

/** The task's plan (else the bound one), how far along it is, and the step
 *  `cast task ready --plan` would hand out first. */
async function planOf(ctx: any, userId: Doc<"users">["_id"], task: Doc<"tasks">, boundPlan: string | undefined): Promise<TaskResumeContext["plan"]> {
  const plan: Doc<"plans"> | null = task.plan_id
    ? await ctx.db.get(task.plan_id)
    : boundPlan
      ? await ctx.db.query("plans").withIndex("by_short_id", (q: any) => q.eq("short_id", boundPlan)).first()
      : null;
  if (!plan || !(await canAccessPlan(ctx, userId, plan))) return null;
  const rows: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).collect();
  const steps: Doc<"tasks">[] = [];
  for (const t of rows) {
    if (isActiveTask(t) && isSameWorkspace(t, workspaceForResource(plan)) && (await canAccessTask(ctx, userId, t))) steps.push(t);
  }
  const counted = steps.filter((t) => t.status !== "dropped");
  const { ready } = await readyTasks(ctx, steps.filter((t) => t._id !== task._id), { viewer: String(userId) });
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
