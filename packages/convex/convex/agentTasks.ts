import { v } from "convex/values";
import { mutation, query, internalMutation, internalAction, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Doc, Id } from "./_generated/dataModel";
import { extractTitleJson } from "./titleGeneration";
import { isRefusalProse } from "./idleSummary";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { enqueuePush } from "./pushRouter";
import { nextShortId } from "./counters";
import { canAccessConversation } from "./lib/access";
import { armedTriggerKindFor } from "./dormancy";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1000; // 10 min
const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 min

// --- Shared core: CLI (api_token) and web (session auth) entry points resolve
// to a userId, then go through these so the two surfaces can't drift. ---

type TaskCtx = { db: any; scheduler?: { runAfter: (delayMs: number, fn: any, args: any) => Promise<unknown> } };

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
  const tasks = await ctx.db
    .query("agent_tasks")
    .withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", conversationId))
    .collect();
  const kind = armedTriggerKindFor(tasks);
  const conv = await ctx.db.get(conversationId);
  if (!conv) return;
  if ((conv.armed_trigger_kind ?? "none") === kind) return;
  await ctx.db.patch(conversationId, { armed_trigger_kind: kind });
}

// Patch a trigger and keep its home's armed_trigger_kind in step.
async function patchTask(ctx: TaskCtx, task: Doc<"agent_tasks">, patch: Record<string, any>) {
  await ctx.db.patch(task._id, patch);
  if (task.originating_conversation_id) await refreshArmedTriggerKind(ctx, task.originating_conversation_id);
}

async function getOwnedTask(
  ctx: TaskCtx,
  taskId: Id<"agent_tasks">,
  userId: Id<"users">
): Promise<Doc<"agent_tasks"> | null> {
  const task = await ctx.db.get(taskId);
  if (!task || task.user_id !== userId) return null;
  return task;
}

// Management verbs (pause/resume/run now/cancel/reactivate/edit) follow the
// same rule as reads: anyone who can view the anchor conversation can manage
// the trigger (founder decision 2026-08-30). Deleting the row stays owner-only
// — cancel is the teammate's off switch; delete erases history.
async function getManageableTask(
  ctx: TaskCtx,
  taskId: Id<"agent_tasks">,
  userId: Id<"users">
): Promise<Doc<"agent_tasks"> | null> {
  const task = await ctx.db.get(taskId);
  if (!task || !(await canViewTask(ctx as { db: any }, userId, task))) return null;
  return task;
}

async function applyPause(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  if (task.status !== "scheduled" && task.status !== "running") return false;
  await patchTask(ctx, task, { status: "paused" });
  return true;
}

async function applyResume(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  if (task.status !== "paused") return false;
  await patchTask(ctx, task, {
    status: "scheduled",
    run_at: task.run_at || Date.now(),
  });
  return true;
}

async function applyRunNow(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  await patchTask(ctx, task, { status: "scheduled", run_at: Date.now() });
  return true;
}

async function applyCancel(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  await patchTask(ctx, task, { status: "completed" });
  return true;
}

// Re-arm a retired schedule. Exists for the hide-gesture affordance: killing a
// session cancels its injecting schedules as a side effect (see
// cancelTasksBoundToConversation), and both the "Keep schedule" toast action
// and undo-of-hide need to reverse exactly that side effect. Also revives a
// failed schedule. Recurring re-arms one interval out (not an immediate fire);
// a once-task keeps its future run_at or re-arms a minute out.
async function applyReactivate(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  if (task.status !== "completed" && task.status !== "failed") return false;
  await patchTask(ctx, task, {
    status: "scheduled",
    canceled_on_kill_at: undefined,
    run_at:
      task.schedule_type === "event"
        ? undefined
        : task.schedule_type === "recurring" && task.interval_ms
          ? Date.now() + task.interval_ms
          : task.run_at && task.run_at > Date.now()
            ? task.run_at
            : Date.now() + 60_000,
  });
  return true;
}

// Resolve a spawned run's conversation (session_id IS the uuid the daemon
// assigned via `claude --session-id`) and stamp agent_task_id on it, so the run
// stays attributable to its schedule forever — not just while it's the latest.
// Idempotent; returns the conversation or null if it hasn't synced yet.
async function stampRunConversation(
  ctx: TaskCtx,
  userId: Id<"users">,
  taskId: Id<"agent_tasks">,
  runSessionUuid: string
): Promise<Doc<"conversations"> | null> {
  const conv = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", runSessionUuid))
    .filter((q: any) => q.eq(q.field("user_id"), userId))
    .first();
  if (!conv) return null;
  if (conv.agent_task_id !== taskId) {
    await ctx.db.patch(conv._id, { agent_task_id: taskId });
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
  for (const status of ["scheduled", "running", "paused"] as const) {
    const tasks = await ctx.db
      .query("agent_tasks")
      .withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", status))
      .collect();
    for (const task of tasks) {
      if (task.originating_conversation_id?.toString() !== conversationId.toString()) continue;
      // Stamp WHY it completed: a restore of the killed session re-arms exactly
      // the schedules this kill took down (reactivateTasksCanceledOnKill),
      // without touching schedules that ran to natural completion.
      await patchTask(ctx, task, { status: "completed", canceled_on_kill_at: Date.now() });
      cancelled++;
    }
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
  const tasks = await ctx.db
    .query("agent_tasks")
    .withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "completed"))
    .collect();
  let rearmed = 0;
  for (const task of tasks) {
    if (!task.canceled_on_kill_at) continue;
    if (task.originating_conversation_id?.toString() !== conversationId.toString()) continue;
    if (await applyReactivate(ctx, task)) rearmed++;
  }
  return rearmed;
}

interface NewTaskArgs {
  title: string;
  prompt: string;
  context_summary?: string;
  originating_conversation_id?: string;
  target_conversation_id?: string;
  created_by_conversation_id?: string;
  created_by_session_uuid?: string;
  project_path?: string;
  agent_type?: string;
  model?: string;
  created_device_id?: string;
  schedule_type: "once" | "recurring" | "event";
  run_at?: number;
  interval_ms?: number;
  event_filter?: { event_type: string; action?: string; repository?: string; pr_number?: number };
  mode?: string;
  max_runtime_ms?: number;
  max_retries?: number;
}

export async function insertTask(ctx: TaskCtx, userId: Id<"users">, args: NewTaskArgs) {
  if (args.schedule_type === "recurring" && !args.interval_ms) {
    throw new Error("interval_ms required for recurring tasks");
  }
  if (args.schedule_type === "event" && !args.event_filter) {
    throw new Error("event_filter required for event tasks");
  }

  const now = Date.now();
  const run_at = args.schedule_type === "event" ? undefined : (args.run_at || now);

  const short_id = await nextShortId(ctx.db, "tr");

  const taskId = await ctx.db.insert("agent_tasks", {
    user_id: userId,
    short_id,
    title: args.title,
    prompt: args.prompt,
    context_summary: args.context_summary,
    originating_conversation_id: args.originating_conversation_id
      ? args.originating_conversation_id as Id<"conversations">
      : undefined,
    target_conversation_id: args.target_conversation_id
      ? args.target_conversation_id as Id<"conversations">
      : undefined,
    created_by_conversation_id: args.created_by_conversation_id
      ? args.created_by_conversation_id as Id<"conversations">
      : undefined,
    created_by_session_uuid: args.created_by_session_uuid,
    project_path: args.project_path,
    agent_type: args.agent_type || "claude",
    model: args.model || undefined,
    created_device_id: args.created_device_id,
    schedule_type: args.schedule_type,
    run_at,
    interval_ms: args.interval_ms,
    event_filter: args.event_filter,
    // Permissive by default: a schedule can act unless it explicitly opts into
    // safe (read-only) mode. Only an explicit "propose" restricts. Existing
    // tasks keep their stored mode, so nothing already armed changes.
    mode: (args.mode === "propose" ? "propose" : "apply") as "propose" | "apply",
    max_runtime_ms: args.max_runtime_ms || DEFAULT_MAX_RUNTIME_MS,
    status: "scheduled" as const,
    retry_count: 0,
    max_retries: args.max_retries ?? DEFAULT_MAX_RETRIES,
    run_count: 0,
    created_at: now,
  });
  if (args.originating_conversation_id) {
    await refreshArmedTriggerKind(ctx, args.originating_conversation_id as Id<"conversations">);
  }
  // Distill a readable display_title/display_summary from the prompt (the
  // summarizer section below) — the stored title is usually prompt.slice(0,60).
  await ctx.scheduler?.runAfter(0, internal.agentTasks.generateDisplaySummary, { task_id: taskId });
  return { id: taskId, short_id };
}

// Single-task action exposed under both auth schemes.
const cliTaskAction = (apply: (ctx: TaskCtx, task: Doc<"agent_tasks">) => Promise<boolean>) =>
  mutation({
    args: { api_token: v.string(), task_id: v.id("agent_tasks") },
    handler: async (ctx, args) => {
      const auth = await verifyApiToken(ctx, args.api_token);
      if (!auth) throw new Error("Unauthorized");
      const task = await getManageableTask(ctx, args.task_id, auth.userId);
      if (!task) return false;
      return apply(ctx, task);
    },
  });

const webTaskAction = (apply: (ctx: TaskCtx, task: Doc<"agent_tasks">) => Promise<boolean>) =>
  mutation({
    args: { task_id: v.id("agent_tasks") },
    handler: async (ctx, args) => {
      const userId = await getAuthUserId(ctx);
      if (!userId) throw new Error("Unauthorized");
      const task = await getManageableTask(ctx, args.task_id, userId);
      if (!task) return false;
      return apply(ctx, task);
    },
  });

export const createTask = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    prompt: v.string(),
    context_summary: v.optional(v.string()),
    originating_conversation_id: v.optional(v.string()),
    target_conversation_id: v.optional(v.string()),
    created_by_conversation_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
    agent_type: v.optional(v.string()),
    model: v.optional(v.string()),
    created_device_id: v.optional(v.string()),
    schedule_type: v.union(v.literal("once"), v.literal("recurring"), v.literal("event")),
    run_at: v.optional(v.number()),
    interval_ms: v.optional(v.number()),
    event_filter: v.optional(v.object({
      event_type: v.string(),
      action: v.optional(v.string()),
      repository: v.optional(v.string()),
      pr_number: v.optional(v.number()),
    })),
    mode: v.optional(v.string()),
    max_runtime_ms: v.optional(v.number()),
    max_retries: v.optional(v.number()),
    // Any session ref (short id, conversation _id, or Claude session uuid) the
    // schedule should inject into — `cast trigger add --for <session>`.
    // Resolved own-only: you can bind a schedule only to your own session.
    originating_session_ref: v.optional(v.string()),
    // Session ref of the conversation that is CREATING this trigger —
    // attribution only (created_by_conversation_id), never routing. Sent even
    // for --spawn triggers, so a spawn trigger still traces to its parent.
    // Best-effort: an unresolvable ref never fails creation.
    created_by_session_ref: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const { api_token: _token, originating_session_ref, created_by_session_ref, ...rest } = args;
    const taskArgs: NewTaskArgs = rest;
    if (originating_session_ref) {
      const conv = await findConversationByAnyRef(ctx, originating_session_ref, auth.userId);
      if (!conv) throw new Error(`No session of yours matches "${originating_session_ref}"`);
      taskArgs.originating_conversation_id = conv._id.toString();
    }
    if (created_by_session_ref) {
      const conv = await findConversationByAnyRef(ctx, created_by_session_ref, auth.userId);
      if (conv) taskArgs.created_by_conversation_id = conv._id.toString();
      // Not synced yet: keep the raw uuid so the read path can resolve it
      // once the conversation row exists. Dropping it here is how a spawn
      // trigger lost its parent for good.
      else taskArgs.created_by_session_uuid = created_by_session_ref;
    }
    return await insertTask(ctx, auth.userId, taskArgs);
  },
});

// Admin repair: stamp created_by_conversation_id on a trigger that predates the
// field (or whose creator link failed to resolve at creation). Attribution
// only — routing (originating_conversation_id) is deliberately untouchable
// here; recreating with --for stays the repair path for a broken binding.
export const adminSetCreatedByConversation = internalMutation({
  args: {
    task_id: v.id("agent_tasks"),
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    const conv = await ctx.db.get(args.conversation_id);
    if (!task || !conv) return false;
    if (task.user_id !== conv.user_id) return false;
    await ctx.db.patch(args.task_id, { created_by_conversation_id: args.conversation_id });
    return true;
  },
});

// Repair for the rows the clipped-comm bug left orphaned (no creator, no
// inject binding): the creator's own transcript holds the proof. `cast trigger
// add` prints "Trigger tr-NNN …" into the Bash tool result of the session that
// ran it, and that message lands seconds after the row was inserted. A global
// by_timestamp window around created_at finds it without scanning any user's
// whole history. Match on the short id first (exact), then on a `trigger add`
// tool call in the same window (the pre-short-id era printed the last-8 suffix).
// Attribution only; originating_conversation_id stays untouched.
export const adminBackfillCreatedBy = internalMutation({
  args: {
    user_id: v.optional(v.id("users")),
    limit: v.optional(v.number()),
    dry_run: v.optional(v.boolean()),
    since_ms: v.optional(v.number()),
    // Paging cursor: only rows created before this. Unmatched orphans stay
    // orphans, so a newest-first scan without a cursor re-reads them forever.
    before_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = args.user_id
      ? await ctx.db
          .query("agent_tasks")
          .withIndex("by_user_status", (q) => q.eq("user_id", args.user_id!))
          .collect()
      : await ctx.db.query("agent_tasks").collect();
    const since = args.since_ms ?? 0;
    const orphans = rows.filter(
      (t) =>
        !t.created_by_conversation_id &&
        !t.originating_conversation_id &&
        !t.created_by_session_uuid &&
        t.created_at >= since &&
        t.created_at < (args.before_ms ?? Infinity)
    );
    const targets = orphans
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, args.limit ?? 10);

    const out: Array<{ short_id?: string; title: string; creator?: string; creator_title?: string; via?: string }> = [];
    for (const t of targets) {
      const T = t.created_at;
      const window = await ctx.db
        .query("messages")
        .withIndex("by_timestamp", (q) => q.gte("timestamp", T - 120_000).lte("timestamp", T + 300_000))
        .collect();
      const suffix = t._id.toString().slice(-8);
      const needles = [t.short_id ? `Trigger ${t.short_id}` : null, `Trigger ${suffix}`].filter(Boolean) as string[];
      const textOf = (m: Doc<"messages">) =>
        [m.content ?? "", ...(m.tool_results ?? []).map((r) => r.content)].join("\n");
      let hit = window.find((m) => !m.is_encrypted && needles.some((n) => textOf(m).includes(n)));
      let via = hit ? "printed id" : undefined;
      if (!hit) {
        const calls = window.filter(
          (m) =>
            m.timestamp <= T + 30_000 &&
            (m.tool_calls ?? []).some((c) => /cast\s+(trigger|schedule)\s+add/.test(c.input))
        );
        // Only an unambiguous single caller counts: two sessions arming
        // triggers in the same window would otherwise cross-stamp.
        const convs = new Set(calls.map((m) => m.conversation_id.toString()));
        if (convs.size === 1) {
          hit = calls[0];
          via = "trigger add call";
        }
      }
      const conv = hit ? await ctx.db.get(hit.conversation_id) : null;
      const ok = conv && conv.user_id === t.user_id;
      out.push({
        short_id: t.short_id,
        title: t.title,
        creator: ok ? conv._id.toString() : undefined,
        creator_title: ok ? conv.title : undefined,
        via: ok ? via : undefined,
      });
      if (ok && !args.dry_run) {
        await ctx.db.patch(t._id, { created_by_conversation_id: conv._id });
      }
    }
    return {
      scanned: targets.length,
      remaining: orphans.length - targets.length,
      next_before_ms: targets.length ? targets[targets.length - 1].created_at : null,
      results: out,
    };
  },
});

export const listTasks = query({
  args: {
    api_token: v.string(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const tasks = args.status
      ? await ctx.db
          .query("agent_tasks")
          .withIndex("by_user_status", (q) =>
            q.eq("user_id", auth.userId).eq("status", args.status as any)
          )
          .collect()
      : await ctx.db
          .query("agent_tasks")
          .withIndex("by_user_status", (q) => q.eq("user_id", auth.userId))
          .collect();

    return await withResolvedRunConversations(ctx, auth.userId, tasks);
  },
});

export const getTask = query({
  args: {
    api_token: v.string(),
    task_id: v.id("agent_tasks"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db.get(args.task_id);
    if (!task || task.user_id !== auth.userId) return null;
    return task;
  },
});

// Turn a short id ("tr-42") or Convex id into a trigger the caller may
// manage — same conversation-access rule as the web verbs, so `cast trigger
// pause tr-42` works on a bot-owned trigger the CLI's own-only list can't see.
export const resolveTask = query({
  args: { api_token: v.string(), ref: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const ref = args.ref.trim();
    let task: Doc<"agent_tasks"> | null = null;
    if (/^tr-\w+$/i.test(ref)) {
      task = await ctx.db
        .query("agent_tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", ref.toLowerCase()))
        .unique();
    } else {
      const id = ctx.db.normalizeId("agent_tasks", ref);
      task = id ? await ctx.db.get(id) : null;
    }
    if (!task || !(await canViewTask(ctx, auth.userId, task))) return null;
    return {
      _id: task._id,
      short_id: task.short_id,
      title: task.title,
      status: task.status,
      is_own: task.user_id === auth.userId,
    };
  },
});

export const getDueTasks = query({
  args: {
    api_token: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const now = Date.now();
    const tasks = await ctx.db
      .query("agent_tasks")
      .withIndex("by_status_run_at", (q) => q.eq("status", "scheduled"))
      .collect();

    return tasks
      .filter((t) => t.user_id === auth.userId && t.run_at !== undefined && t.run_at <= now)
      .slice(0, args.limit || 5);
  },
});

export const claimTask = mutation({
  args: {
    api_token: v.string(),
    task_id: v.id("agent_tasks"),
    daemon_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db.get(args.task_id);
    if (!task || task.user_id !== auth.userId) return null;
    if (task.status !== "scheduled") return null;

    const now = Date.now();
    // Through patchTask (scheduled → running are both armed statuses, so the
    // home's armed_trigger_kind is unchanged — but every lifecycle writer
    // routes through the one restamping chokepoint; see the exhaustive test).
    await patchTask(ctx, task, {
      status: "running",
      lease_holder: args.daemon_id,
      lease_expires_at: now + LEASE_DURATION_MS,
    });

    return { ...task, status: "running" as const };
  },
});

export const renewLease = mutation({
  args: {
    api_token: v.string(),
    task_id: v.id("agent_tasks"),
    daemon_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db.get(args.task_id);
    if (!task || task.user_id !== auth.userId) return false;
    if (task.status !== "running" || task.lease_holder !== args.daemon_id) return false;

    await ctx.db.patch(args.task_id, {
      lease_expires_at: Date.now() + LEASE_DURATION_MS,
    });
    return true;
  },
});

export const completeTaskRun = mutation({
  args: {
    api_token: v.string(),
    task_id: v.id("agent_tasks"),
    daemon_id: v.optional(v.string()),
    summary: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
    // Claude session UUID of the spawned run (from `claude --session-id`). Stored
    // raw and resolved to a conversation at read time in webList, since the run's
    // conversation may not have synced yet at this instant.
    run_session_uuid: v.optional(v.string()),
    // Agent's explicit "the user should read this run" declaration
    // (`cast trigger complete --needs-attention`). Skips the clean-run fold
    // below and keeps the run card escalated in the inbox.
    needs_attention: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db.get(args.task_id);
    if (!task || task.user_id !== auth.userId) return false;
    if (args.daemon_id && task.lease_holder !== args.daemon_id) return false;

    // Inject path: the daemon auto-completes the task on injection (without a
    // summary) so the lease doesn't expire and re-fire. The agent in the
    // originating conversation calls this later with --summary; allow it
    // through so the summary still posts to target_conversation.
    const isLateSummary =
      task.status === "completed" &&
      !task.last_run_summary &&
      !!args.summary;

    if (
      task.status !== "running" &&
      task.status !== "scheduled" &&
      !isLateSummary
    ) {
      return false;
    }

    const now = Date.now();
    const updates: Record<string, any> = {
      last_run_at: now,
      last_run_summary: args.summary,
      last_run_failed: false,
      // A good run ends the retry streak. retry_count is the CURRENT streak, not
      // a lifetime tally: failRun counts up to max_retries, so leaving it set
      // after a recovery both shortens the next streak's budget and leaves the
      // trigger reading as "retrying" forever.
      retry_count: 0,
      last_run_conversation_id: args.conversation_id
        ? args.conversation_id as Id<"conversations">
        : undefined,
      last_run_session_uuid: args.run_session_uuid || undefined,
      last_run_needs_attention: !!args.needs_attention,
      lease_holder: undefined,
      lease_expires_at: undefined,
    };

    // Keep the run conversation attributable to its schedule even after a
    // later run overwrites last_run_*. This is the backfill for the daemon's
    // post-spawn linkRunConversation — it rides whichever completion is
    // accepted (the agent's own `cast trigger complete` lands first and wins;
    // the daemon's tmux-exit completion is rejected by the status guard above).
    // Spawn tasks only: for an inject task the agent self-completes from INSIDE
    // the originating session, so its uuid resolves to the originating
    // conversation — which is the schedule's home, not a run of it.
    let runConv: Doc<"conversations"> | null = null;
    if (args.run_session_uuid && !task.originating_conversation_id) {
      runConv = await stampRunConversation(ctx, auth.userId, args.task_id, args.run_session_uuid);
    }

    // Fold the run the agent just finished, not only the superseded one
    // (linkRunConversation): the steady state of a healthy repeating spawn
    // schedule is ZERO loose inbox cards — the schedule's standing row carries
    // the summary. Strictly gated on the agent's own deliberate completion:
    // no daemon_id (the daemon's tmux-exit completion means the agent died
    // WITHOUT self-reporting — that run must stay visible), a real summary,
    // and no --needs-attention. Same user-intent guards as the previous-run
    // fold; `once` runs never fold (their single result IS the deliverable).
    const repeatingSpawn =
      (task.schedule_type === "recurring" || task.schedule_type === "event") &&
      !task.originating_conversation_id;
    if (
      repeatingSpawn &&
      !args.daemon_id &&
      !!args.summary &&
      !args.needs_attention &&
      runConv &&
      !runConv.inbox_pinned_at &&
      !runConv.inbox_dismissed_at &&
      !runConv.inbox_stashed_at &&
      !runConv.has_pending_messages
    ) {
      // Folded = out of the way, NOT retired: the run's agent may still be
      // alive and its history is living state, so the fold writes the stash
      // stamp (Stashed bucket, "N running" pill) rather than the legacy
      // dismissed stamp that files rows under Killed.
      await ctx.db.patch(runConv._id, { inbox_stashed_at: now });
    }

    // --needs-attention is the agent's claim on the user's eyes, and stash/kill
    // must not swallow it: if the conversation the flag points at (the inject
    // loop's home, or this spawn run) sits in Stashed or Killed, pull it back
    // into the active inbox — the just-finished turn then triages as
    // needs-input. One-shot at completion: re-stashing silences the loop again
    // until the NEXT flagged run.
    if (args.needs_attention) {
      const attentionConvId =
        task.originating_conversation_id ??
        runConv?._id ??
        (args.conversation_id
          ? (args.conversation_id as Id<"conversations">)
          : undefined);
      const conv =
        runConv && runConv._id === attentionConvId
          ? runConv
          : attentionConvId
            ? await ctx.db.get(attentionConvId)
            : null;
      if (
        conv &&
        conv.user_id === auth.userId &&
        (conv.inbox_stashed_at || conv.inbox_dismissed_at)
      ) {
        await ctx.db.patch(conv._id, {
          inbox_stashed_at: undefined,
          inbox_dismissed_at: undefined,
        });
      }
    }

    if (isLateSummary) {
      // Already counted on initial completion; don't double-count or re-arm.
    } else {
      updates.run_count = task.run_count + 1;
      if (task.schedule_type === "recurring" && task.interval_ms) {
        updates.status = "scheduled";
        updates.run_at = now + task.interval_ms;
      } else if (task.schedule_type === "event") {
        updates.status = "scheduled";
        updates.run_at = undefined;
      } else {
        updates.status = "completed";
      }
    }

    await patchTask(ctx, task, updates);

    if (task.target_conversation_id && args.summary) {
      const targetConv = await ctx.db.get(task.target_conversation_id);
      if (targetConv) {
        await ctx.db.insert("messages", {
          conversation_id: task.target_conversation_id,
          role: "assistant",
          content: args.summary,
          subtype: "scheduled_task_result",
          timestamp: now,
        });
        await ctx.db.patch(task.target_conversation_id, {
          updated_at: now,
          message_count: targetConv.message_count + 1,
        });
      }
    }

    // Notify only when the completion IS the deliverable: a one-shot task
    // finishing, or any run the agent flagged --needs-attention. A healthy
    // repeating schedule completes silently — its summary already lands in the
    // target conversation / standing schedule row (see the fold above), so a
    // "Task completed" push every interval is pure noise. Late summaries
    // never re-notify (the initial completion already did).
    const isRepeating = task.schedule_type === "recurring" || task.schedule_type === "event";
    const shouldNotify = !isLateSummary && (!isRepeating || !!args.needs_attention);
    const user = await ctx.db.get(auth.userId);
    if (shouldNotify && user?.push_token && user.notifications_enabled) {
      const notifId = await ctx.db.insert("notifications", {
        recipient_user_id: auth.userId,
        type: "task_completed",
        message: `Task "${task.title}" completed${args.summary ? `: ${args.summary.slice(0, 100)}` : ""}`,
        read: false,
        created_at: now,
      });
      await enqueuePush(ctx, {
        user,
        notification_id: notifId,
        type: "task_completed",
        title: "Task completed",
        body: task.title,
        data: { type: "task_completed", taskId: args.task_id },
      });
    }

    return true;
  },
});

export const failTaskRun = mutation({
  args: {
    api_token: v.string(),
    task_id: v.id("agent_tasks"),
    daemon_id: v.string(),
    error: v.optional(v.string()),
    // Session UUID of the failed run, so a failure is still one click from the
    // transcript that shows what went wrong.
    run_session_uuid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db.get(args.task_id);
    if (!task || task.user_id !== auth.userId) return false;
    if (task.lease_holder !== args.daemon_id) return false;

    const maxRetries = task.max_retries ?? DEFAULT_MAX_RETRIES;
    const newRetryCount = task.retry_count + 1;
    const runUuid = args.run_session_uuid || undefined;

    // A failed run's conversation is one click away from what went wrong —
    // stamp it too (and last_run_failed gates the auto-fold: a failed run
    // must stay visible in the inbox when the retry starts). Spawn tasks only,
    // same reason as completeTaskRun.
    if (runUuid && !task.originating_conversation_id) {
      await stampRunConversation(ctx, auth.userId, args.task_id, runUuid);
    }

    if (newRetryCount < maxRetries) {
      await patchTask(ctx, task, {
        status: "scheduled",
        retry_count: newRetryCount,
        run_at: Date.now() + 60_000 * newRetryCount, // backoff
        lease_holder: undefined,
        lease_expires_at: undefined,
        last_run_summary: args.error ? `Failed: ${args.error}` : "Failed",
        last_run_failed: true,
        last_run_session_uuid: runUuid,
      });
    } else {
      await patchTask(ctx, task, {
        status: "failed",
        retry_count: newRetryCount,
        lease_holder: undefined,
        lease_expires_at: undefined,
        last_run_summary: args.error ? `Failed: ${args.error}` : "Failed (max retries)",
        last_run_failed: true,
        last_run_session_uuid: runUuid,
      });

      // Retries exhausted = the loop is dead, and a hidden home must not stay
      // hidden with a dead loop inside it — the stall rule ("stash hides work,
      // not stalls"), same clear the --needs-attention claim uses. Transient
      // failures above stay quiet: the retry is still progress.
      if (task.originating_conversation_id) {
        const home = await ctx.db.get(task.originating_conversation_id);
        if (home && (home.inbox_stashed_at || home.inbox_dismissed_at) && !home.inbox_killed_at) {
          await ctx.db.patch(home._id, { inbox_stashed_at: undefined, inbox_dismissed_at: undefined });
        }
      }

      const user = await ctx.db.get(auth.userId);
      if (user?.push_token && user.notifications_enabled) {
        const notifId = await ctx.db.insert("notifications", {
          recipient_user_id: auth.userId,
          type: "task_failed",
          message: `Task "${task.title}" failed: ${args.error || "max retries exceeded"}`,
          read: false,
          created_at: Date.now(),
        });
        await enqueuePush(ctx, {
          user,
          notification_id: notifId,
          type: "task_failed",
          title: "Task failed",
          body: `${task.title}: ${args.error || "max retries exceeded"}`,
          data: { type: "task_failed", taskId: args.task_id },
        });
      }
    }

    return true;
  },
});

// Called by the daemon shortly after spawning a run (bounded retries — the
// run's conversation appears when its JSONL first syncs). Two jobs, one
// transaction:
//
// 1. Stamp agent_task_id on the new run's conversation, so the schedule strip
//    and badges work DURING the run and on every historical run.
// 2. Auto-fold the PREVIOUS run: for a repeating spawn schedule (recurring or
//    event), each fire lands a whole new conversation in the inbox — an hourly
//    job is 24 cards a day of pure noise. The moment a new run starts, the
//    previous run has been superseded: if it completed cleanly, fold it out of
//    the active inbox (dismiss). Attention stays earned, not granted: a run
//    that FAILED (last_run_failed), is still active, was pinned, or has a
//    pending user message is never folded. Folded runs remain reachable — the
//    Dismissed group, /schedules, and the new run's strip all link the history.
export const linkRunConversation = mutation({
  args: {
    api_token: v.string(),
    task_id: v.id("agent_tasks"),
    run_session_uuid: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const task = await getOwnedTask(ctx, args.task_id, auth.userId);
    if (!task) return { linked: false, retry: false };

    const conv = await stampRunConversation(ctx, auth.userId, args.task_id, args.run_session_uuid);
    if (!conv) return { linked: false, retry: true }; // not synced yet — daemon retries

    const repeatingSpawn =
      (task.schedule_type === "recurring" || task.schedule_type === "event") &&
      !task.originating_conversation_id;
    if (repeatingSpawn && !task.last_run_failed) {
      let prev: Doc<"conversations"> | null = task.last_run_conversation_id
        ? await ctx.db.get(task.last_run_conversation_id)
        : null;
      if (!prev && task.last_run_session_uuid && task.last_run_session_uuid !== args.run_session_uuid) {
        prev = await ctx.db
          .query("conversations")
          .withIndex("by_session_id", (q: any) => q.eq("session_id", task.last_run_session_uuid))
          .filter((q: any) => q.eq(q.field("user_id"), auth.userId))
          .first();
      }
      // No conv.status check: a spawned run's conversation lingers "active"
      // long after its agent exits (the watchdog completes it lazily), but
      // last_run_* only ever points at a run whose task-level completion
      // (completeTaskRun) already happened — that is the authoritative
      // "this run finished" signal, and the lease machinery guarantees runs
      // of one task never overlap.
      if (
        prev &&
        prev._id.toString() !== conv._id.toString() &&
        prev.user_id.toString() === auth.userId.toString() &&
        !prev.inbox_pinned_at &&
        !prev.inbox_dismissed_at &&
        !prev.inbox_stashed_at &&
        !prev.has_pending_messages
      ) {
        // Same fold, same stamp as completeTaskRun above: superseded runs are
        // set aside, not killed.
        await ctx.db.patch(prev._id, { inbox_stashed_at: Date.now() });
      }
    }
    return { linked: true, retry: false };
  },
});

export const cancelTask = cliTaskAction(applyCancel);
export const pauseTask = cliTaskAction(applyPause);
export const resumeTask = cliTaskAction(applyResume);
export const runTaskNow = cliTaskAction(applyRunNow);

// --- Web (session-auth) surface, used by the /schedules page ---

// Attach resolved last-run/originating conversation info to task rows.
// completeTaskRun stores the run's session UUID raw (the run's conversation
// may not have synced yet at that instant), so UUID → conversation resolution
// happens here at read time. Shared by webList (the /schedules page) and
// listTasks (the CLI's /cli/tasks/list) so both surfaces agree on
// last_run_conversation_id — `cast trigger log` reads it from listTasks.
async function withResolvedRunConversations(
  ctx: TaskCtx,
  userId: Id<"users">,
  tasks: Doc<"agent_tasks">[]
) {
  // Enrich with conversation titles so rows can link to the last run and
  // the originating session without N client queries.
  const convIds = new Set<Id<"conversations">>();
  for (const t of tasks) {
    if (t.last_run_conversation_id) convIds.add(t.last_run_conversation_id);
    if (t.originating_conversation_id) convIds.add(t.originating_conversation_id);
    if (t.created_by_conversation_id) convIds.add(t.created_by_conversation_id);
  }
  const titles = new Map<string, string>();
  await Promise.all(
    [...convIds].map(async (id) => {
      const conv = await ctx.db.get(id);
      if (conv) titles.set(id, conv.title || "Untitled");
    })
  );

  // Raw session uuids stored because the conversation had not synced at
  // write time: the last run (the --context-current path) and the creator
  // (a trigger armed before its own session's row existed).
  const uuidToConv = new Map<string, { id: Id<"conversations">; title: string }>();
  const pendingUuids = [
    ...new Set(
      tasks.flatMap((t) => [
        ...(t.last_run_session_uuid && !t.last_run_conversation_id ? [t.last_run_session_uuid] : []),
        ...(t.created_by_session_uuid && !t.created_by_conversation_id ? [t.created_by_session_uuid] : []),
      ])
    ),
  ];
  await Promise.all(
    pendingUuids.map(async (uuid) => {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q: any) => q.eq("session_id", uuid))
        .filter((q: any) => q.eq(q.field("user_id"), userId))
        .first();
      if (conv) uuidToConv.set(uuid, { id: conv._id, title: conv.title || "Untitled" });
    })
  );

  return tasks.map((t) => {
    const resolved =
      !t.last_run_conversation_id && t.last_run_session_uuid
        ? uuidToConv.get(t.last_run_session_uuid)
        : undefined;
    const lastRunConvId = t.last_run_conversation_id ?? resolved?.id;
    const creator =
      !t.created_by_conversation_id && t.created_by_session_uuid
        ? uuidToConv.get(t.created_by_session_uuid)
        : undefined;
    return {
      ...t,
      last_run_conversation_id: lastRunConvId,
      last_run_conversation_title: t.last_run_conversation_id
        ? titles.get(t.last_run_conversation_id)
        : resolved?.title,
      originating_conversation_title: t.originating_conversation_id
        ? titles.get(t.originating_conversation_id)
        : undefined,
      created_by_conversation_id: t.created_by_conversation_id ?? creator?.id,
      created_by_conversation_title: t.created_by_conversation_id
        ? titles.get(t.created_by_conversation_id)
        : creator?.title,
    };
  });
}

export const webList = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const tasks = await ctx.db
      .query("agent_tasks")
      .withIndex("by_user_status", (q) => q.eq("user_id", userId))
      .collect();

    return await withResolvedRunConversations(ctx, userId, tasks);
  },
});

// A trigger owned by someone else is still VIEWABLE when the viewer can view
// the conversation it is anchored to (creator, home, or last run). Agents on a
// remote daemon arm triggers under whatever account that daemon is logged into
// — often a team bot — while the conversation belongs to a human; strict
// per-user filtering made those triggers invisible on the very session that
// created them. Read access piggybacks on conversation access (the workspace
// rules), so this grants nothing a transcript view doesn't already show.
// Management verbs follow the same rule (getManageableTask); only delete
// stays owner-only.
async function canViewTask(
  ctx: { db: any },
  userId: Id<"users">,
  task: Doc<"agent_tasks">
): Promise<boolean> {
  if (task.user_id.toString() === userId.toString()) return true;
  const anchors = [
    task.created_by_conversation_id,
    task.originating_conversation_id,
    task.target_conversation_id,
    task.last_run_conversation_id,
  ].filter(Boolean) as Id<"conversations">[];
  for (const id of anchors) {
    const conv = await ctx.db.get(id);
    if (conv && (await canAccessConversation(ctx as any, userId, conv))) return true;
  }
  return false;
}

// Every trigger anchored to one conversation — own AND team-visible foreign
// rows — for the conversation header strip. The per-user webList can't carry a
// bot-owned trigger, so the strip merges this on top. Gated on the viewer's
// access to the conversation itself; `is_own` tells the client whether to
// offer the management verbs.
export const webListForConversation = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || !(await canAccessConversation(ctx, userId, conv))) return [];

    const [created, originating] = await Promise.all([
      ctx.db
        .query("agent_tasks")
        .withIndex("by_created_by_conversation", (q) =>
          q.eq("created_by_conversation_id", args.conversation_id)
        )
        .collect(),
      ctx.db
        .query("agent_tasks")
        .withIndex("by_originating_conversation", (q) =>
          q.eq("originating_conversation_id", args.conversation_id)
        )
        .collect(),
    ]);
    const seen = new Set<string>();
    const tasks: Doc<"agent_tasks">[] = [];
    for (const t of [...created, ...originating]) {
      if (seen.has(t._id.toString())) continue;
      seen.add(t._id.toString());
      tasks.push(t);
    }
    const enriched = await withResolvedRunConversations(ctx, userId, tasks);
    return await Promise.all(
      enriched.map(async (t) => {
        const is_own = t.user_id.toString() === userId.toString();
        const owner = is_own ? null : await ctx.db.get(t.user_id);
        return { ...t, is_own, owner_name: owner?.name ?? owner?.email };
      })
    );
  },
});

/**
 * One trigger by short id ("tr-42") or Convex id — the getter behind the
 * inline trigger pill, matching tasks.webGet / plans.webGet / conversations.
 * webGet so every entity pill resolves the same way. Returns null rather than
 * throwing for a foreign or missing row: a pill degrades to plain text.
 */
export const webGet = query({
  args: { short_id: v.optional(v.string()), id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    let task: Doc<"agent_tasks"> | null = null;
    if (args.id) {
      const normalized = ctx.db.normalizeId("agent_tasks", args.id);
      task = normalized ? await ctx.db.get(normalized) : null;
    } else if (args.short_id) {
      task = await ctx.db
        .query("agent_tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id!.toLowerCase()))
        .unique();
    }
    if (!task || !(await canViewTask(ctx, userId, task))) return null;

    const [enriched] = await withResolvedRunConversations(ctx, userId, [task]);
    const row = enriched ?? task;
    const is_own = task.user_id.toString() === userId.toString();
    const owner = is_own ? null : await ctx.db.get(task.user_id);
    return { ...row, is_own, owner_name: owner?.name ?? owner?.email };
  },
});

/**
 * One-shot: give every pre-existing trigger a short id. Paged (the caller
 * re-runs until `remaining` is 0) so a large account can't blow the mutation
 * budget. Allocation goes through the same counter as new rows, so backfilled
 * and fresh ids share one sequence and can never collide.
 */
export const backfillShortIds = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    const missing = await ctx.db
      .query("agent_tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", undefined))
      .take(limit + 1);
    const batch = missing.slice(0, limit);
    for (const task of batch) {
      await ctx.db.patch(task._id, { short_id: await nextShortId(ctx.db, "tr") });
    }
    return { filled: batch.length, more: missing.length > limit };
  },
});

// One-shot backfill for conversations.armed_trigger_kind: every home of a
// currently armed inject trigger gets its kind stamped. Bounded by the number of
// armed triggers, not conversations; homes with no armed trigger stay unset,
// which reads as "none". Idempotent — re-running writes nothing new.
export const backfillArmedTriggerKind = internalMutation({
  args: {},
  handler: async (ctx) => {
    const homes = new Set<string>();
    for (const status of ["scheduled", "running", "paused"] as const) {
      const tasks = await ctx.db
        .query("agent_tasks")
        .withIndex("by_status_run_at", (q) => q.eq("status", status))
        .collect();
      for (const task of tasks) {
        if (task.originating_conversation_id) homes.add(task.originating_conversation_id.toString());
      }
    }
    let stamped = 0;
    for (const id of homes) {
      const before = await ctx.db.get(id as Id<"conversations">);
      await refreshArmedTriggerKind(ctx, id as Id<"conversations">);
      const after = await ctx.db.get(id as Id<"conversations">);
      if (before && after && (before.armed_trigger_kind ?? "none") !== (after.armed_trigger_kind ?? "none")) stamped++;
    }
    return { homes: homes.size, stamped };
  },
});

// Every past run of one schedule, newest first — the browseable run history on
// every schedule surface (strip, dock, /schedules). Each entry names the
// conversation to open AND the message that triggered the run, so the UI can
// land the user on the exact trigger:
//   • Spawn schedules: one conversation per run (agent_task_id is stamped by
//     linkRunConversation shortly after spawn and backfilled on completion, so
//     this is the complete linkable set, unaffected by inbox windows or run
//     auto-fold). The trigger is the run's first user message (the prompt).
//   • Inject schedules (--context current): every run is a
//     `<scheduled-task task-id="...">` user message inside the home
//     conversation. Found by scanning the conversation's user turns newest
//     first (the search index can't match 32-char Convex id tokens) with an
//     exact substring check on the task id. The scan is bounded: sessions so
//     long their old runs fall outside it lose only the oldest entries.
//     Encrypted conversations degrade to no history.
// `_id` stays the conversation id for older clients; `run_key` is the unique
// per-run key (inject runs share one conversation).
export const webListRuns = query({
  args: { task_id: v.id("agent_tasks") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const task = await ctx.db.get(args.task_id);
    if (!task || !(await canViewTask(ctx, userId, task))) return [];

    if (task.originating_conversation_id) {
      const convId = task.originating_conversation_id;
      const conv = await ctx.db.get(convId);
      if (!conv) return [];
      const marker = `task-id="${args.task_id}"`;
      const userTurns = await ctx.db
        .query("messages")
        .withIndex("by_conversation_role_timestamp", (q) =>
          q.eq("conversation_id", convId).eq("role", "user")
        )
        .order("desc")
        .take(1000);
      return userTurns
        .filter((m) => m.content?.includes(marker))
        .slice(0, 100)
        .map((m) => ({
          _id: convId,
          run_key: m._id as string,
          kind: "inject" as const,
          short_id: conv.short_id,
          title: conv.title || "Untitled",
          created_at: m.timestamp,
          status: conv.status,
          idle_summary: undefined as string | undefined,
          trigger_message_id: m._id,
          trigger_message_timestamp: m.timestamp,
        }));
    }

    const runs = await ctx.db
      .query("conversations")
      .withIndex("by_agent_task", (q) => q.eq("agent_task_id", args.task_id))
      .collect();
    const newest = runs.sort((a, b) => b._creationTime - a._creationTime).slice(0, 100);
    return await Promise.all(
      newest.map(async (c) => {
        const trigger = await ctx.db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (q) =>
            q.eq("conversation_id", c._id).eq("role", "user")
          )
          .order("asc")
          .first();
        return {
          _id: c._id,
          run_key: c._id as string,
          kind: "spawn" as const,
          short_id: c.short_id,
          title: c.title || "Untitled",
          created_at: c._creationTime,
          status: c.status,
          idle_summary: c.idle_summary,
          trigger_message_id: trigger?._id,
          trigger_message_timestamp: trigger?.timestamp,
        };
      })
    );
  },
});

export const webCreate = mutation({
  args: {
    title: v.optional(v.string()),
    prompt: v.string(),
    schedule_type: v.union(v.literal("once"), v.literal("recurring"), v.literal("event")),
    run_at: v.optional(v.number()),
    interval_ms: v.optional(v.number()),
    event_filter: v.optional(v.object({
      event_type: v.string(),
      action: v.optional(v.string()),
      repository: v.optional(v.string()),
      pr_number: v.optional(v.number()),
    })),
    mode: v.optional(v.string()),
    agent_type: v.optional(v.string()),
    model: v.optional(v.string()),
    project_path: v.optional(v.string()),
    max_runtime_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return await insertTask(ctx, userId, {
      ...args,
      title: args.title?.trim() || args.prompt.slice(0, 60),
    });
  },
});

export const webPause = webTaskAction(applyPause);
export const webResume = webTaskAction(applyResume);
export const webReactivate = webTaskAction(applyReactivate);
export const webRunNow = webTaskAction(applyRunNow);
export const webCancel = webTaskAction(applyCancel);

// Delete a trigger row with its revision history, then restamp the old home:
// deleting an armed trigger is a lifecycle transition like cancel, and the
// home's denormalized armed_trigger_kind must not keep parking a session whose
// wake no longer exists (sync-convergence C1). Exported so the restamp-on-
// delete contract is unit-testable without the mutation wrapper.
export async function deleteTaskCascade(ctx: TaskCtx, task: Doc<"agent_tasks">): Promise<void> {
  // Delete erases history (see getManageableTask's note) — the edit log
  // goes with the row rather than orphaning.
  const revisions = await ctx.db
    .query("agent_task_revisions")
    .withIndex("by_task", (q: any) => q.eq("task_id", task._id))
    .collect();
  for (const r of revisions) await ctx.db.delete(r._id);
  await ctx.db.delete(task._id);
  if (task.originating_conversation_id) await refreshArmedTriggerKind(ctx, task.originating_conversation_id);
}

export const webDelete = mutation({
  args: { task_id: v.id("agent_tasks") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const task = await getOwnedTask(ctx, args.task_id, userId);
    if (!task) return false;
    await deleteTaskCascade(ctx, task);
    return true;
  },
});

// Re-run the Haiku distillation on demand — the escape hatch for a summary
// that reads wrong or predates a prompt edit.
export const webRegenerateSummary = mutation({
  args: { task_id: v.id("agent_tasks") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const task = await getManageableTask(ctx, args.task_id, userId);
    if (!task) return false;
    await ctx.scheduler.runAfter(0, internal.agentTasks.generateDisplaySummary, { task_id: args.task_id });
    return true;
  },
});

// --- Editing: shared core with version history + audit log ---

type TaskUpdateArgs = {
  title?: string;
  prompt?: string;
  schedule_type?: "once" | "recurring" | "event";
  run_at?: number;
  interval_ms?: number;
  event_filter?: { event_type: string; action?: string; repository?: string; pr_number?: number };
  mode?: string;
  agent_type?: string;
  model?: string;
  project_path?: string;
  max_runtime_ms?: number;
};

// The editable surface — exactly the fields agent_task_revisions.before
// snapshots. Everything else on the row is lifecycle/bookkeeping state that
// edits never touch.
const EDITABLE_FIELDS = [
  "title",
  "prompt",
  "schedule_type",
  "run_at",
  "interval_ms",
  "event_filter",
  "mode",
  "agent_type",
  "model",
  "project_path",
  "max_runtime_ms",
] as const;

function snapshotEditable(task: Doc<"agent_tasks">) {
  return {
    title: task.title,
    prompt: task.prompt,
    schedule_type: task.schedule_type,
    run_at: task.run_at,
    interval_ms: task.interval_ms,
    event_filter: task.event_filter,
    mode: task.mode,
    agent_type: task.agent_type,
    model: task.model,
    project_path: task.project_path,
    max_runtime_ms: task.max_runtime_ms,
  };
}

// Edit a schedule in place — the ONLY writer for trigger edits, shared by
// `cast trigger update` (CLI) and the web edit dialog so the two surfaces
// can't drift. Mirrors insertTask's timing rules. Only scheduled/paused tasks
// are editable; a running or finished task is rejected. Every effective edit
// appends an agent_task_revisions row (pre-edit snapshot + who/where/what),
// so `cast trigger history` can show both the audit trail and any prior
// version. A no-op edit (nothing actually differs) writes neither.
export async function applyTaskUpdate(
  ctx: TaskCtx,
  task: Doc<"agent_tasks">,
  args: TaskUpdateArgs,
  actor: { userId: Id<"users">; source: "cli" | "web" },
): Promise<{ ok: boolean; changed: string[] }> {
  if (task.status !== "scheduled" && task.status !== "paused") return { ok: false, changed: [] };

  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) patch.title = args.title.trim() || task.title;
  const promptChanged =
    args.prompt !== undefined && !!args.prompt.trim() && args.prompt.trim() !== task.prompt;
  if (promptChanged) {
    patch.prompt = args.prompt!.trim();
    // Stale distillations must not describe the old prompt.
    patch.display_title = undefined;
    patch.display_summary = undefined;
  }
  if (args.mode !== undefined) patch.mode = args.mode === "apply" ? "apply" : "propose";
  if (args.agent_type !== undefined) patch.agent_type = args.agent_type || "claude";
  // "" or "default" clears the pin — the run goes back to the agent's saved default.
  if (args.model !== undefined) patch.model = args.model && args.model !== "default" ? args.model : undefined;
  if (args.project_path !== undefined) patch.project_path = args.project_path || undefined;
  if (args.max_runtime_ms !== undefined) patch.max_runtime_ms = args.max_runtime_ms;

  if (args.schedule_type !== undefined) {
    patch.schedule_type = args.schedule_type;
    if (args.schedule_type === "recurring") {
      if (!args.interval_ms) throw new Error("interval_ms required for recurring tasks");
      patch.interval_ms = args.interval_ms;
      patch.run_at = args.run_at ?? Date.now() + args.interval_ms;
      patch.event_filter = undefined;
    } else if (args.schedule_type === "event") {
      if (!args.event_filter) throw new Error("event_filter required for event tasks");
      patch.event_filter = args.event_filter;
      patch.run_at = undefined;
      patch.interval_ms = undefined;
    } else {
      patch.run_at = args.run_at ?? Date.now();
      patch.interval_ms = undefined;
      patch.event_filter = undefined;
    }
  } else {
    if (args.interval_ms !== undefined) patch.interval_ms = args.interval_ms;
    if (args.run_at !== undefined) patch.run_at = args.run_at;
  }

  // Which editable fields actually differ. The display_* resets ride along
  // with a prompt change but aren't edits themselves, so they never appear in
  // the audit line. event_filter is the one object field — compare by value.
  const changed = (EDITABLE_FIELDS as readonly string[]).filter(
    (k) =>
      k in patch &&
      JSON.stringify((patch as any)[k] ?? null) !== JSON.stringify((task as any)[k] ?? null)
  );
  if (changed.length === 0) return { ok: true, changed };

  const prior = await ctx.db
    .query("agent_task_revisions")
    .withIndex("by_task", (q: any) => q.eq("task_id", task._id))
    .collect();
  const revision = prior.reduce((max: number, r: any) => Math.max(max, r.revision), 0) + 1;
  await ctx.db.insert("agent_task_revisions", {
    task_id: task._id,
    revision,
    actor_user_id: actor.userId,
    source: actor.source,
    changed_fields: changed,
    before: snapshotEditable(task),
    created_at: Date.now(),
  });

  await patchTask(ctx, task, patch);
  if (promptChanged) {
    await ctx.scheduler?.runAfter(0, internal.agentTasks.generateDisplaySummary, { task_id: task._id });
  }
  return { ok: true, changed };
}

const TASK_UPDATE_ARG_VALIDATORS = {
  title: v.optional(v.string()),
  prompt: v.optional(v.string()),
  schedule_type: v.optional(v.union(v.literal("once"), v.literal("recurring"), v.literal("event"))),
  run_at: v.optional(v.number()),
  interval_ms: v.optional(v.number()),
  event_filter: v.optional(v.object({
    event_type: v.string(),
    action: v.optional(v.string()),
    repository: v.optional(v.string()),
    pr_number: v.optional(v.number()),
  })),
  mode: v.optional(v.string()),
  agent_type: v.optional(v.string()),
  model: v.optional(v.string()),
  project_path: v.optional(v.string()),
  max_runtime_ms: v.optional(v.number()),
};

export const webUpdate = mutation({
  args: { task_id: v.id("agent_tasks"), ...TASK_UPDATE_ARG_VALIDATORS },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const task = await getManageableTask(ctx, args.task_id, userId);
    if (!task) return false;
    const { task_id: _id, ...rest } = args;
    const result = await applyTaskUpdate(ctx, task, rest, { userId, source: "web" });
    return result.ok;
  },
});

// `cast trigger update` — same core, api_token auth. Returns the changed
// field names so the CLI can echo what the edit actually did.
export const updateTask = mutation({
  args: { api_token: v.string(), task_id: v.id("agent_tasks"), ...TASK_UPDATE_ARG_VALIDATORS },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const task = await getManageableTask(ctx, args.task_id, auth.userId);
    if (!task) return { ok: false, changed: [] };
    const { api_token: _token, task_id: _id, ...rest } = args;
    return await applyTaskUpdate(ctx, task, rest, { userId: auth.userId, source: "cli" });
  },
});

// Full edit history of one trigger, oldest first, with actor names resolved
// and the task's current editable fields appended — revision N's "after" is
// revision N+1's before, or `current` for the newest. Shared by the CLI
// (`cast trigger history`, via /cli/tasks/history) and the web.
async function listTaskRevisions(ctx: { db: any }, userId: Id<"users">, taskId: Id<"agent_tasks">) {
  const task = await getManageableTask(ctx, taskId, userId);
  if (!task) return null;
  const revisions = await ctx.db
    .query("agent_task_revisions")
    .withIndex("by_task", (q: any) => q.eq("task_id", taskId))
    .collect();
  revisions.sort((a: any, b: any) => a.revision - b.revision);
  const actorNames = new Map<string, string>();
  await Promise.all(
    [...new Set(revisions.map((r: any) => r.actor_user_id.toString()))].map(async (id) => {
      const user = await ctx.db.get(id);
      if (user) actorNames.set(id as string, user.name || user.email || "unknown");
    })
  );
  return {
    task_id: taskId,
    short_id: task.short_id,
    title: task.title,
    status: task.status,
    current: snapshotEditable(task),
    revisions: revisions.map((r: any) => ({
      revision: r.revision,
      actor_user_id: r.actor_user_id,
      actor_name: actorNames.get(r.actor_user_id.toString()) ?? "unknown",
      source: r.source,
      changed_fields: r.changed_fields,
      before: r.before,
      created_at: r.created_at,
    })),
  };
}

export const listRevisions = query({
  args: { api_token: v.string(), task_id: v.id("agent_tasks") },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    return await listTaskRevisions(ctx, auth.userId, args.task_id);
  },
});

export const webListRevisions = query({
  args: { task_id: v.id("agent_tasks") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await listTaskRevisions(ctx, userId, args.task_id);
  },
});

export const matchTaskTriggers = internalMutation({
  args: {
    event_type: v.string(),
    action: v.optional(v.string()),
    repository: v.optional(v.string()),
    // Set by the derived PR events (pr_check_failed, pr_approved and the rest),
    // which are always about one pull request. A trigger that names a pr_number
    // fires only for that PR; one that does not still fires for every PR in the
    // repository, which is what the raw GitHub event shorthands rely on.
    pr_number: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const tasks = await ctx.db
      .query("agent_tasks")
      .withIndex("by_event_filter", (q) => q.eq("status", "scheduled"))
      .collect();

    let matched = 0;
    for (const task of tasks) {
      if (!task.event_filter) continue;
      if (task.event_filter.event_type !== args.event_type) continue;
      if (task.event_filter.action && task.event_filter.action !== args.action) continue;
      if (task.event_filter.repository && task.event_filter.repository !== args.repository) continue;
      if (task.event_filter.pr_number != null && task.event_filter.pr_number !== args.pr_number) continue;

      await ctx.db.patch(task._id, { run_at: Date.now() });
      matched++;
    }

    return matched;
  },
});

export const reclaimStaleTasks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const runningTasks = await ctx.db
      .query("agent_tasks")
      .withIndex("by_status_run_at", (q) => q.eq("status", "running"))
      .collect();

    let reclaimed = 0;
    for (const task of runningTasks) {
      if (task.lease_expires_at && task.lease_expires_at < now) {
        const maxRetries = task.max_retries ?? DEFAULT_MAX_RETRIES;
        if (task.retry_count < maxRetries) {
          await patchTask(ctx, task, {
            status: "scheduled",
            run_at: now,
            retry_count: task.retry_count + 1,
            lease_holder: undefined,
            lease_expires_at: undefined,
          });
          reclaimed++;
        } else {
          await patchTask(ctx, task, {
            status: "failed",
            lease_holder: undefined,
            lease_expires_at: undefined,
            last_run_summary: "Lease expired, max retries exceeded",
          });

          const user = await ctx.db.get(task.user_id);
          if (user?.push_token && user.notifications_enabled) {
            await ctx.db.insert("notifications", {
              recipient_user_id: task.user_id,
              type: "task_failed",
              message: `Task "${task.title}" failed: lease expired after ${task.retry_count} retries`,
              read: false,
              created_at: now,
            });
          }
        }
      }
    }

    return reclaimed;
  },
});

// --- Haiku-distilled presentation fields (display_title / display_summary) ---
//
// A schedule's stored title is usually just prompt.slice(0, 60), so every row
// surface was showing a truncated wall of prompt text. These functions turn
// the prompt into a short display_title (2-5 words) and a display_summary (one
// plain sentence: what the agent does each run). Same idiom as
// titleGeneration.ts: an internalAction calls Haiku at temperature 0 and an
// internalMutation patches the result; extractTitleJson is reused for the
// {"title","subtitle"} parse. Triggered from insertTask and from webUpdate on
// prompt change; backfillDisplaySummaries sweeps pre-existing schedules.

// A title that is just the leading slice of the prompt carries no signal — it's
// the CLI/web default, not a human choice. Only such titles get replaced by the
// generated display_title; an explicit human title always wins in the UI.
export function isPromptDerivedTitle(title: string, prompt: string): boolean {
  const t = title.trim();
  return t.length === 0 || t === prompt.slice(0, 60).trim() || t === prompt.trim();
}

export function buildTaskSummaryPrompt(input: { prompt: string; scheduleLine: string }): string {
  return `A user scheduled a recurring/automated agent task. Distill its instruction prompt so a dashboard row is readable at a glance.

Title: 2-5 words naming what the task does. Short noun/verb phrase, like a git branch name but readable. No trailing period.
Examples: "Growth blocker sweep", "CI health check", "PR comment triage"

Subtitle: ONE plain-English sentence (max ~160 chars) saying what the agent does each run and what it escalates to a human, in ordinary words. Do NOT restate the timing/cadence (shown separately: ${input.scheduleLine}). Avoid jargon from the prompt that a reader outside the project can't parse — say the plain thing.

Task instruction prompt:
${input.prompt.slice(0, 4000)}

Do not respond to the instruction itself. Output ONLY the JSON object, no markdown, no preamble:
{"title": "...", "subtitle": "..."}`;
}

export const setDisplaySummary = internalMutation({
  args: {
    task_id: v.id("agent_tasks"),
    display_title: v.optional(v.string()),
    display_summary: v.string(),
    // The prompt the summary was generated FROM — skip the patch if the task
    // was edited while the action was in flight (the edit reschedules its own
    // generation, which must not be clobbered by this stale result).
    source_prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    if (!task || task.prompt !== args.source_prompt) return;
    await ctx.db.patch(args.task_id, {
      ...(args.display_title ? { display_title: args.display_title } : {}),
      display_summary: args.display_summary,
    });
  },
});

export const getTaskForSummary = internalQuery({
  args: { task_id: v.id("agent_tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    if (!task) return null;
    return {
      title: task.title,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      interval_ms: task.interval_ms,
      event_filter: task.event_filter,
    };
  },
});

export const generateDisplaySummary = internalAction({
  args: { task_id: v.id("agent_tasks") },
  // Explicit return type: the handler references internal.agentTasks.* (its
  // own module), and without it TS inference cycles and silently drops this
  // export from the module type — breaking every internal.agentTasks.
  // generateDisplaySummary reference at deploy-time typecheck.
  handler: async (ctx, args): Promise<void> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not configured");
      return;
    }

    const task = await ctx.runQuery(internal.agentTasks.getTaskForSummary, {
      task_id: args.task_id,
    });
    if (!task || !task.prompt.trim()) return;

    const scheduleLine =
      task.schedule_type === "recurring"
        ? `every ${Math.round((task.interval_ms ?? 0) / 60000)} minutes`
        : task.schedule_type === "event"
          ? `on ${task.event_filter?.event_type ?? "event"}`
          : "once";

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          // Deterministic: the same prompt must yield the same summary.
          temperature: 0,
          messages: [
            { role: "user", content: buildTaskSummaryPrompt({ prompt: task.prompt, scheduleLine }) },
          ],
        }),
      });

      if (!response.ok) {
        console.error("Task summary Haiku error:", response.status, await response.text());
        return;
      }

      const data = await response.json();
      const text = data.content?.[0]?.text?.trim();
      if (!text) return;

      const parsed = extractTitleJson(text);
      const title = parsed?.title?.trim();
      const summary = parsed?.subtitle?.trim();
      // isRefusalProse: valid JSON can still carry refusal/meta prose in the
      // value ("I don't see a recent conversation…") — same guard as the
      // conversation subtitle writer in titleGeneration.
      if (!summary || summary.length > 400 || isRefusalProse(summary)) {
        console.error("Task summary returned no usable JSON:", text.slice(0, 120));
        return;
      }

      await ctx.runMutation(internal.agentTasks.setDisplaySummary, {
        task_id: args.task_id,
        display_title:
          title && title.length < 80 && isPromptDerivedTitle(task.title, task.prompt)
            ? title
            : undefined,
        display_summary: summary,
        source_prompt: task.prompt,
      });
    } catch (error) {
      console.error("Failed to generate task summary:", error);
    }
  },
});

// One-shot sweep for schedules created before display summaries existed: every
// task without one gets a generation scheduled — history included, so the
// /schedules finished section reads as names too. Safe to re-run.
export const backfillDisplaySummaries = internalMutation({
  args: {},
  handler: async (ctx) => {
    let scheduled = 0;
    for (const status of ["scheduled", "running", "paused", "completed", "failed"] as const) {
      const tasks = await ctx.db
        .query("agent_tasks")
        .withIndex("by_status_run_at", (q) => q.eq("status", status))
        .collect();
      for (const task of tasks) {
        if (task.display_summary) continue;
        // Stagger to stay clear of API rate limits on large backfills.
        await ctx.scheduler.runAfter(scheduled * 500, internal.agentTasks.generateDisplaySummary, {
          task_id: task._id,
        });
        scheduled++;
      }
    }
    return { scheduled };
  },
});
