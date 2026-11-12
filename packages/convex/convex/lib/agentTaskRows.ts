// The agent_tasks writes a conversation's lifecycle needs: the one patch path
// (patchTask, which keeps conversations.armed_trigger_kind true), a kill's
// cancel and its undo, and stamping a run's conversation. Kept apart from
// agentTasks.ts so conversations.ts and cleanup.ts can call them without
// importing agentTasks, which reaches the big import cycle (ct-92432).
import type { Doc, Id } from "../_generated/dataModel";
import { armedTriggerKindFor } from "../dormancy";
import { runParentOf } from "@codecast/shared/contracts";
import { hostedHomeStamp } from "../assistant/routines";
import { nextCadenceRun } from "@platform/assistant/cadence";

export type TaskCtx = { db: any; scheduler?: { runAfter: (delayMs: number, fn: any, args: any) => Promise<unknown> } };

// Recompute conversations.armed_trigger_kind for one home from EVERY trigger
// that injects into it (several can), and write it only when it changed — the
// field is semantic, so each write is a sync-log action. This is the single
// writer; every lifecycle transition below routes its patch through patchTask
// so the denormalized answer can never lag the agent_tasks rows the inbox no
// longer reads (sync-convergence C1).
export async function refreshArmedTriggerKind(
  ctx: TaskCtx,
  conversationId: Id<"conversations">,
): Promise<void> {
  const kind = armedTriggerKindFor(await tasksOriginatedBy(ctx, conversationId));
  const conv = await ctx.db.get(conversationId);
  if (!conv) return;
  if ((conv.armed_trigger_kind ?? "none") === kind) return;
  await ctx.db.patch(conversationId, { armed_trigger_kind: kind });
}

// Patch a trigger and keep its home's armed_trigger_kind in step.
export async function patchTask(ctx: TaskCtx, task: Doc<"agent_tasks">, patch: Record<string, any>) {
  if ("originating_conversation_id" in patch) {
    patch = { ...patch, hosted_home: await hostedHomeStamp(ctx, patch.originating_conversation_id) };
  }
  await ctx.db.patch(task._id, patch);
  if (task.originating_conversation_id) await refreshArmedTriggerKind(ctx, task.originating_conversation_id);
}

// A recurring trigger keeps a cadence: slots one interval apart. run_at is when
// the daemon may next claim the row, and it leaves the cadence for a manual
// run, a retry or a limit park. Those writes go through here, which keeps the
// slot the trigger was armed for, so the arming after the run
// (nextArmingAfterRun) returns to the cadence instead of restarting it from
// wherever the detour ended.
// The first cadence slot after `after`: on the wall clock when the routine
// keeps one (hostedWallCadence), else one interval on.
export function nextRecurringRun(task: Pick<Doc<"agent_tasks">, "interval_ms"> & Partial<Pick<Doc<"agent_tasks">, "cadence">>, after: number): number {
  return task.cadence ? nextCadenceRun(task.cadence, after) : after + (task.interval_ms ?? 0);
}

// Re-arm a retired schedule. Exists for the hide-gesture affordance: killing a
// session cancels its injecting schedules as a side effect (see
// cancelTasksBoundToConversation), and both the "Keep schedule" toast action
// and undo-of-hide need to reverse exactly that side effect. Also revives a
// failed schedule. Recurring re-arms one interval out (not an immediate fire);
// a once-task keeps its future run_at or re-arms a minute out.
export async function applyReactivate(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  if (task.status !== "completed" && task.status !== "failed") return false;
  await patchTask(ctx, task, {
    status: "scheduled",
    canceled_on_kill_at: undefined,
    requested_run_source: undefined,
    // A revived schedule starts fresh: its first firing is not a retry of
    // the dead one (triggerFiringContinues), carries none of its message, and
    // its gate asks again from nothing (a change the dead run never acted on
    // must not read as "unchanged").
    retry_count: 0,
    precheck_message: undefined,
    precheck_state: undefined,
    cadence_slot_at: undefined,
    run_at:
      task.schedule_type === "event"
        ? undefined
        : task.schedule_type === "recurring" && task.interval_ms
          ? nextRecurringRun(task, Date.now())
          : task.run_at && task.run_at > Date.now()
            ? task.run_at
            : Date.now() + 60_000,
  });
  return true;
}

// Resolve a spawned run's conversation (session_id IS the uuid the daemon
// assigned via `claude --session-id`) and stamp agent_task_id on it, so the run
// stays attributable to its schedule forever — not just while it's the latest.
// A spawned run nests under the session that armed it (runParentOf) as a
// subagent row, the same shape `cast spawn --subagent` makes, so it never
// surfaces as a loose inbox card nobody owns. The daemon stamps both
// at birth (createConversation agent_task_id + parent_conversation_id); this
// is the backfill for rows born without them. Idempotent; returns the
// conversation, or null if it hasn't synced yet.
export async function stampRunConversation(
  ctx: TaskCtx,
  userId: Id<"users">,
  task: Doc<"agent_tasks">,
  runSessionUuid: string,
  opts: { backfill?: boolean } = {},
): Promise<Doc<"conversations"> | null> {
  const conv = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", runSessionUuid))
    .filter((q: any) => q.eq(q.field("user_id"), userId))
    .first();
  if (!conv) return null;
  const patch: Record<string, any> = {};
  const firstStamp = conv.agent_task_id !== task._id;
  if (firstStamp) patch.agent_task_id = task._id;
  // A run is never a loose inbox card. It nests under the session that armed
  // it (runParentOf: every spawn schedule, repeating included) whatever that
  // session's inbox state, a stashed parent or a subagent worker included: the
  // outcomes a person must see wake the parent (runOwnerWakeOf), and a wake
  // brings a stashed or killed parent back, so hiding the run loses nothing.
  // A repeating run with no parent to nest under is born stashed instead, and
  // surfaces only for those same outcomes (wakeRunOwner). A once run with no
  // parent stays a card: its single result is the deliverable. Only the first
  // stamp hides, so a run the user brought back stays back; the backfill
  // (nestLooseTriggerRuns) applies the rule to runs stamped before it existed.
  // A run blocked on the human is an open ask and is never hidden.
  if (!conv.parent_conversation_id) {
    const parent = runParentOf(task);
    const parentConv = parent && parent.toString() !== conv._id.toString() ? await ctx.db.get(parent) : null;
    if (parentConv && parentConv.user_id.toString() === userId.toString()) {
      patch.parent_conversation_id = parent;
      patch.is_subagent = true;
    } else if (
      (firstStamp || opts.backfill) &&
      task.schedule_type !== "once" &&
      !conv.inbox_stashed_at &&
      !conv.inbox_pinned_at &&
      conv.thread_state_status !== "blocked"
    ) {
      patch.inbox_stashed_at = Date.now();
    }
  }
  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(conv._id, patch);
    Object.assign(conv, patch);
  }
  return conv;
}

// Kill is the strongest triage gesture — "make this stop". Any armed schedule
// that INJECTS into the killed conversation (originating_conversation_id, the
// `--context current` kind) would resurrect it on its next fire — the
// scheduler's injection un-kills the session for delivery — silently defeating
// the kill. So killSession cancels those schedules in the same transaction.
// Schedules that merely post summaries to the conversation
// (target_conversation_id) never wake it, and spawn-type schedules whose RUN
// was killed are untouched: each run is its own session, and killing one run
// doesn't mean "stop the program" — the schedule strip on the run gives the
// user that verb explicitly.
export async function cancelTasksBoundToConversation(
  ctx: TaskCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">
): Promise<number> {
  let cancelled = 0;
  for (const task of await runnerTasksOriginatedBy(ctx, userId, conversationId)) {
    if (task.status !== "scheduled" && task.status !== "running" && task.status !== "paused") continue;
    // Stamp WHY it completed: a restore of the killed session re-arms exactly
    // the schedules this kill took down (reactivateTasksCanceledOnKill),
    // without touching schedules that ran to natural completion.
    await patchTask(ctx, task, { status: "completed", canceled_on_kill_at: Date.now() });
    cancelled++;
  }
  return cancelled;
}

// The tasks one conversation originated, read through the conversation's own
// index. A kill and its undo run this once per session in the tree; scanning
// the runner's tasks by status instead read their whole trigger history each
// time (2.3 MB per session for a heavy user), so undoing the kill of a session
// with a handful of subagents read 19 MB in one mutation and was refused.
export async function tasksOriginatedBy(ctx: TaskCtx, conversationId: Id<"conversations">): Promise<Doc<"agent_tasks">[]> {
  return await ctx.db
    .query("agent_tasks")
    .withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", conversationId))
    .collect();
}

export async function runnerTasksOriginatedBy(ctx: TaskCtx, userId: Id<"users">, conversationId: Id<"conversations">) {
  return (await tasksOriginatedBy(ctx, conversationId)).filter((task) => task.user_id.toString() === userId.toString());
}

/** Cancel every open task a conversation originated (a retired standing role's
 *  routines): cancelled, not completed, so nothing re-arms them. Returns the count. */
// `only` narrows the cancel to the tasks a caller owns (a seat's own routine),
// leaving whatever else the person armed on the thread alone.
export async function cancelTasksOriginatingFrom(ctx: TaskCtx, conversationId: Id<"conversations">, now = Date.now(), only?: (task: any) => boolean): Promise<number> {
  let cancelled = 0;
  for (const task of await tasksOriginatedBy(ctx, conversationId)) {
    if (task.status === "cancelled" || task.status === "completed" || task.status === "failed") continue;
    if (only && !only(task)) continue;
    await patchTask(ctx, task, { status: "cancelled", updated_at: now });
    cancelled++;
  }
  return cancelled;
}

// The mirror of cancelTasksBoundToConversation: re-arm the schedules a kill
// canceled, called on the un-kill transition (web restore / undo, cast
// undismiss). Only tasks stamped canceled_on_kill_at qualify — a schedule that
// completed naturally stays completed. Reuses applyReactivate, which also
// clears the stamp so a second restore is a no-op.
export async function reactivateTasksCanceledOnKill(
  ctx: TaskCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">
): Promise<number> {
  let rearmed = 0;
  for (const task of await runnerTasksOriginatedBy(ctx, userId, conversationId)) {
    if (task.status !== "completed" || !task.canceled_on_kill_at) continue;
    if (await applyReactivate(ctx, task)) rearmed++;
  }
  return rearmed;
}
