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
import { canAccessPlan, canAccessTask, isSameWorkspace, workspaceForResource } from "./lib/access";
import { findConversationBySessionReference } from "./conversationSessionLookup";
import { orderFrontier, readyTasks, taskLookups } from "./lib/taskGraph";
import { stampWaitChecks } from "./lib/waitChecks";
import { boundSessionsOf } from "./lib/taskOwner";
import { blockersHoldingBack, isActiveTask, isTerminalTaskStatus, RESUME_SUBTASKS_SHOWN, type TaskResumeContext } from "@codecast/shared/tasks";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/** How many recent comments are searched for the last progress note. */
const COMMENT_SCAN = 200;
/** How many children are read to find the open subtasks the block lists. */
const SUBTASK_SCAN = 500;

export const context = query({
  args: {
    api_token: v.string(),
    /** The task in the session's pulse: the last one it started or filed. */
    short_id: v.optional(v.string()),
    /** The pulse came from a start, not a create: the session took that task. */
    started: v.optional(v.boolean()),
    /** The plan the session is bound to, when the task names none. */
    plan_id: v.optional(v.string()),
    /** The asking session: the task it holds, and its own ephemeral steps. */
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<TaskResumeContext | null> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const readable = async (t: Doc<"tasks"> | null) => (t && (await canAccessTask(ctx, auth.userId, t)) ? t : null);
    // Only the caller's own session: a teammate's shared one carries a binding
    // that says nothing about whether this session holds the task.
    const session: Doc<"conversations"> | null = args.session_id ? await findConversationBySessionReference(ctx, args.session_id, auth.userId) : null;
    const pulsed = args.short_id
      ? await readable(await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", args.short_id!)).first())
      : null;
    // The binding on the conversation is the truth; the pulse only names the
    // task the session touched last, which may be one it merely filed. A
    // session the server spawned for a task has no pulse at all.
    const heldTask = session?.active_task_id ? await readable(await ctx.db.get(session.active_task_id)) : null;
    const task = heldTask ?? pulsed;
    if (!task) return null;
    // A task the session only filed and that has since closed leaves it nothing to pick up.
    const filed = !heldTask && !args.started;
    if (filed && isTerminalTaskStatus(task.status)) return null;

    // readinessLookups keeps any row in the task's workspace; only one the
    // caller may read lends its title. Status always ships, as readiness does.
    const { statusOf } = await taskLookups(ctx, task);
    const blockers: TaskResumeContext["blockers"] = [];
    // A closed task holds nothing, which blockersHoldingBack itself decides
    // (TG1), so a session still bound to a task somebody else closed is never
    // told to park on a blocker nothing can settle.
    //
    // Each still-waiting checks wait carries its PR's `checks_state`, read
    // where every other blocker-wording surface reads it (lib/waitChecks): red
    // checks keep such a wait waiting forever (TG2), so without it this block
    // — the one surface that orders a session dormant — would word it "PR #42
    // checks to go green" and park the session on checks only a new push can
    // turn green.
    for (const b of await stampWaitChecks(ctx, auth.userId, task, blockersHoldingBack(task, statusOf))) {
      const row = b.kind === "task" ? statusOf(b.ref) : null;
      const found = row && typeof row === "object" ? (row as Doc<"tasks">) : null;
      // Older rows name a blocker by its Convex id; the agent needs the short id.
      const ref = found?.short_id ? { ref: found.short_id } : {};
      const titled = found && (await readable(found));
      blockers.push({ ...b, ...ref, ...(titled ? { title: titled.title } : {}) });
    }

    // Newest first, until the last progress note: the comments after it are counted.
    const newer: Doc<"task_comments">[] = [];
    let note: Doc<"task_comments"> | null = null;
    for await (const c of ctx.db.query("task_comments").withIndex("by_task_created", (q) => q.eq("task_id", task._id)).order("desc")) {
      if (c.comment_type === "progress") {
        note = c;
        break;
      }
      newer.push(c);
      if (newer.length >= COMMENT_SCAN) break;
    }
    const capped = !note && newer.length >= COMMENT_SCAN;

    return {
      task: { short_id: task.short_id, title: task.title, status: task.status, priority: task.priority },
      ...(heldTask ? { held: true } : filed ? { filed: true, ...(session ? { held: false } : {}) } : session ? await lostOf(ctx, session, task) : {}),
      ...(heldTask && pulsed && pulsed._id !== heldTask._id ? { recent: { short_id: pulsed.short_id, title: pulsed.title, status: pulsed.status } } : {}),
      blockers,
      subtasks: await openSubtasks(ctx, task, readable),
      progress: note ? { text: note.text, author: note.author, created_at: note.created_at } : null,
      newer: newer.length ? { count: newer.length, ...(capped ? { capped } : {}), latest: { type: newer[0].comment_type, author: newer[0].author } } : null,
      plan: await planOf(ctx, auth.userId, task, args.plan_id, session),
    };
  },
});

/** A task the session started but no longer holds: whether it lost it because
 *  the task closed or because another session holds it now. */
async function lostOf(ctx: QueryCtx, session: Doc<"conversations">, task: Doc<"tasks">): Promise<Pick<TaskResumeContext, "held" | "lost">> {
  if (isTerminalTaskStatus(task.status)) return { held: false, lost: "closed" };
  const owners = await boundSessionsOf(ctx, task);
  return owners.some((c) => c._id !== session._id) ? { held: false, lost: "claimed" } : { held: false };
}

/** The first open subtasks the caller may read, in the order they were filed,
 *  and how many more there are among the first SUBTASK_SCAN children. */
async function openSubtasks(
  ctx: QueryCtx,
  task: Doc<"tasks">,
  readable: (t: Doc<"tasks"> | null) => Promise<Doc<"tasks"> | null>,
): Promise<NonNullable<TaskResumeContext["subtasks"]>> {
  const open: Doc<"tasks">[] = [];
  let scanned = 0;
  for await (const c of ctx.db.query("tasks").withIndex("by_parent_id", (q) => q.eq("parent_id", task._id))) {
    if (++scanned > SUBTASK_SCAN) break;
    if (!isTerminalTaskStatus(c.status) && isActiveTask(c) && (await readable(c))) open.push(c);
  }
  return {
    items: open.slice(0, RESUME_SUBTASKS_SHOWN).map((c) => ({ short_id: c.short_id, title: c.title, status: c.status })),
    more: Math.max(0, open.length - RESUME_SUBTASKS_SHOWN),
    ...(scanned > SUBTASK_SCAN ? { truncated: true } : {}),
  };
}

/** The task's plan (else the bound one), how far along it is (the progress
 *  the plan keeps, as `cast plan show` prints it), and the step `cast task
 *  ready --plan` would hand this session first: the same members
 *  (plan.task_ids, so no subtasks) and the same readiness.
 *
 *  `mine` carries which of the two it is, because the fallback plans (the one
 *  the hook passed, the session's binding) are the session's, not the task's:
 *  a session bound to a plan routinely starts a task filed outside it, and the
 *  block must not word that as a step of the plan (resume.ts). */
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
  const readiness = { viewer: String(userId), viewerSession: session ? String(session._id) : null };
  const ready = (await readyTasks(ctx, steps, readiness)).ready.filter((t) => t._id !== task._id);
  const next = (await orderFrontier(ctx, ready, Date.now()))[0];
  return {
    short_id: plan.short_id,
    title: plan.title,
    status: plan.status,
    mine: !!task.plan_id,
    ...(plan.progress ? { done: plan.progress.done, total: plan.progress.total } : {}),
    next: next ? { short_id: next.short_id, title: next.title, priority: next.priority } : null,
  };
}
