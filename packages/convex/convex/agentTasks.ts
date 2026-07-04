import { v } from "convex/values";
import { mutation, query, internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Doc, Id } from "./_generated/dataModel";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1000; // 10 min
const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 min

// --- Shared core: CLI (api_token) and web (session auth) entry points resolve
// to a userId, then go through these so the two surfaces can't drift. ---

type TaskCtx = { db: any };

async function getOwnedTask(
  ctx: TaskCtx,
  taskId: Id<"agent_tasks">,
  userId: Id<"users">
): Promise<Doc<"agent_tasks"> | null> {
  const task = await ctx.db.get(taskId);
  if (!task || task.user_id !== userId) return null;
  return task;
}

async function applyPause(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  if (task.status !== "scheduled" && task.status !== "running") return false;
  await ctx.db.patch(task._id, { status: "paused" });
  return true;
}

async function applyResume(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  if (task.status !== "paused") return false;
  await ctx.db.patch(task._id, {
    status: "scheduled",
    run_at: task.run_at || Date.now(),
  });
  return true;
}

async function applyRunNow(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  await ctx.db.patch(task._id, { status: "scheduled", run_at: Date.now() });
  return true;
}

async function applyCancel(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  await ctx.db.patch(task._id, { status: "completed" });
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
      await ctx.db.patch(task._id, { status: "completed" });
      cancelled++;
    }
  }
  return cancelled;
}

interface NewTaskArgs {
  title: string;
  prompt: string;
  context_summary?: string;
  originating_conversation_id?: string;
  target_conversation_id?: string;
  project_path?: string;
  agent_type?: string;
  created_device_id?: string;
  schedule_type: "once" | "recurring" | "event";
  run_at?: number;
  interval_ms?: number;
  event_filter?: { event_type: string; action?: string; repository?: string };
  mode?: string;
  max_runtime_ms?: number;
  max_retries?: number;
}

async function insertTask(ctx: TaskCtx, userId: Id<"users">, args: NewTaskArgs) {
  if (args.schedule_type === "recurring" && !args.interval_ms) {
    throw new Error("interval_ms required for recurring tasks");
  }
  if (args.schedule_type === "event" && !args.event_filter) {
    throw new Error("event_filter required for event tasks");
  }

  const now = Date.now();
  const run_at = args.schedule_type === "event" ? undefined : (args.run_at || now);

  return await ctx.db.insert("agent_tasks", {
    user_id: userId,
    title: args.title,
    prompt: args.prompt,
    context_summary: args.context_summary,
    originating_conversation_id: args.originating_conversation_id
      ? args.originating_conversation_id as Id<"conversations">
      : undefined,
    target_conversation_id: args.target_conversation_id
      ? args.target_conversation_id as Id<"conversations">
      : undefined,
    project_path: args.project_path,
    agent_type: args.agent_type || "claude",
    created_device_id: args.created_device_id,
    schedule_type: args.schedule_type,
    run_at,
    interval_ms: args.interval_ms,
    event_filter: args.event_filter,
    mode: (args.mode === "apply" ? "apply" : "propose") as "propose" | "apply",
    max_runtime_ms: args.max_runtime_ms || DEFAULT_MAX_RUNTIME_MS,
    status: "scheduled" as const,
    retry_count: 0,
    max_retries: args.max_retries ?? DEFAULT_MAX_RETRIES,
    run_count: 0,
    created_at: now,
  });
}

// Single-task action exposed under both auth schemes.
const cliTaskAction = (apply: (ctx: TaskCtx, task: Doc<"agent_tasks">) => Promise<boolean>) =>
  mutation({
    args: { api_token: v.string(), task_id: v.id("agent_tasks") },
    handler: async (ctx, args) => {
      const auth = await verifyApiToken(ctx, args.api_token);
      if (!auth) throw new Error("Unauthorized");
      const task = await getOwnedTask(ctx, args.task_id, auth.userId);
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
      const task = await getOwnedTask(ctx, args.task_id, userId);
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
    project_path: v.optional(v.string()),
    agent_type: v.optional(v.string()),
    created_device_id: v.optional(v.string()),
    schedule_type: v.union(v.literal("once"), v.literal("recurring"), v.literal("event")),
    run_at: v.optional(v.number()),
    interval_ms: v.optional(v.number()),
    event_filter: v.optional(v.object({
      event_type: v.string(),
      action: v.optional(v.string()),
      repository: v.optional(v.string()),
    })),
    mode: v.optional(v.string()),
    max_runtime_ms: v.optional(v.number()),
    max_retries: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const { api_token: _token, ...taskArgs } = args;
    return await insertTask(ctx, auth.userId, taskArgs);
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

    if (args.status) {
      return await ctx.db
        .query("agent_tasks")
        .withIndex("by_user_status", (q) =>
          q.eq("user_id", auth.userId).eq("status", args.status as any)
        )
        .collect();
    }

    return await ctx.db
      .query("agent_tasks")
      .withIndex("by_user_status", (q) => q.eq("user_id", auth.userId))
      .collect();
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
    await ctx.db.patch(args.task_id, {
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
      last_run_conversation_id: args.conversation_id
        ? args.conversation_id as Id<"conversations">
        : undefined,
      last_run_session_uuid: args.run_session_uuid || undefined,
      lease_holder: undefined,
      lease_expires_at: undefined,
    };

    // Keep the run conversation attributable to its schedule even after a
    // later run overwrites last_run_*. This is the backfill for the daemon's
    // post-spawn linkRunConversation — it rides whichever completion is
    // accepted (the agent's own `cast schedule complete` lands first and wins;
    // the daemon's tmux-exit completion is rejected by the status guard above).
    // Spawn tasks only: for an inject task the agent self-completes from INSIDE
    // the originating session, so its uuid resolves to the originating
    // conversation — which is the schedule's home, not a run of it.
    if (args.run_session_uuid && !task.originating_conversation_id) {
      await stampRunConversation(ctx, auth.userId, args.task_id, args.run_session_uuid);
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

    await ctx.db.patch(args.task_id, updates);

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

    // Create notification
    const user = await ctx.db.get(auth.userId);
    if (user?.push_token && user.notifications_enabled) {
      await ctx.db.insert("notifications", {
        recipient_user_id: auth.userId,
        type: "task_completed",
        message: `Task "${task.title}" completed${args.summary ? `: ${args.summary.slice(0, 100)}` : ""}`,
        read: false,
        created_at: now,
      });
      await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
        push_token: user.push_token,
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
      await ctx.db.patch(args.task_id, {
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
      await ctx.db.patch(args.task_id, {
        status: "failed",
        retry_count: newRetryCount,
        lease_holder: undefined,
        lease_expires_at: undefined,
        last_run_summary: args.error ? `Failed: ${args.error}` : "Failed (max retries)",
        last_run_failed: true,
        last_run_session_uuid: runUuid,
      });

      const user = await ctx.db.get(auth.userId);
      if (user?.push_token && user.notifications_enabled) {
        await ctx.db.insert("notifications", {
          recipient_user_id: auth.userId,
          type: "task_failed",
          message: `Task "${task.title}" failed: ${args.error || "max retries exceeded"}`,
          read: false,
          created_at: Date.now(),
        });
        await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
          push_token: user.push_token,
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
        !prev.has_pending_messages
      ) {
        await ctx.db.patch(prev._id, { inbox_dismissed_at: Date.now() });
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

export const webList = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const tasks = await ctx.db
      .query("agent_tasks")
      .withIndex("by_user_status", (q) => q.eq("user_id", userId))
      .collect();

    // Enrich with conversation titles so rows can link to the last run and
    // the originating session without N client queries.
    const convIds = new Set<Id<"conversations">>();
    for (const t of tasks) {
      if (t.last_run_conversation_id) convIds.add(t.last_run_conversation_id);
      if (t.originating_conversation_id) convIds.add(t.originating_conversation_id);
    }
    const titles = new Map<string, string>();
    await Promise.all(
      [...convIds].map(async (id) => {
        const conv = await ctx.db.get(id);
        if (conv) titles.set(id, conv.title || "Untitled");
      })
    );

    // Resolve spawned-run session UUIDs to their conversation (by_session_id).
    // Done at read time because the run's conversation may not have synced yet
    // when the daemon reported completion. Only needed when the run didn't
    // already record a conversation_id directly (the --context-current path).
    const uuidToConv = new Map<string, { id: Id<"conversations">; title: string }>();
    const pendingUuids = [
      ...new Set(
        tasks
          .filter((t) => t.last_run_session_uuid && !t.last_run_conversation_id)
          .map((t) => t.last_run_session_uuid as string)
      ),
    ];
    await Promise.all(
      pendingUuids.map(async (uuid) => {
        const conv = await ctx.db
          .query("conversations")
          .withIndex("by_session_id", (q) => q.eq("session_id", uuid))
          .filter((q) => q.eq(q.field("user_id"), userId))
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
      return {
        ...t,
        last_run_conversation_id: lastRunConvId,
        last_run_conversation_title: t.last_run_conversation_id
          ? titles.get(t.last_run_conversation_id)
          : resolved?.title,
        originating_conversation_title: t.originating_conversation_id
          ? titles.get(t.originating_conversation_id)
          : undefined,
      };
    });
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
    })),
    mode: v.optional(v.string()),
    agent_type: v.optional(v.string()),
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
export const webRunNow = webTaskAction(applyRunNow);
export const webCancel = webTaskAction(applyCancel);

export const webDelete = mutation({
  args: { task_id: v.id("agent_tasks") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const task = await getOwnedTask(ctx, args.task_id, userId);
    if (!task) return false;
    await ctx.db.delete(args.task_id);
    return true;
  },
});

// Edit an existing schedule in place (web-only — the CLI has no update verb).
// Mirrors insertTask's timing rules so the two surfaces can't drift. Only
// scheduled/paused tasks are editable; a running or finished task is rejected.
export const webUpdate = mutation({
  args: {
    task_id: v.id("agent_tasks"),
    title: v.optional(v.string()),
    prompt: v.optional(v.string()),
    schedule_type: v.optional(v.union(v.literal("once"), v.literal("recurring"), v.literal("event"))),
    run_at: v.optional(v.number()),
    interval_ms: v.optional(v.number()),
    event_filter: v.optional(v.object({
      event_type: v.string(),
      action: v.optional(v.string()),
      repository: v.optional(v.string()),
    })),
    mode: v.optional(v.string()),
    agent_type: v.optional(v.string()),
    project_path: v.optional(v.string()),
    max_runtime_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const task = await getOwnedTask(ctx, args.task_id, userId);
    if (!task) return false;
    if (task.status !== "scheduled" && task.status !== "paused") return false;

    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title.trim() || task.title;
    if (args.prompt !== undefined && args.prompt.trim()) patch.prompt = args.prompt.trim();
    if (args.mode !== undefined) patch.mode = args.mode === "apply" ? "apply" : "propose";
    if (args.agent_type !== undefined) patch.agent_type = args.agent_type || "claude";
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

    await ctx.db.patch(task._id, patch);
    return true;
  },
});

export const matchTaskTriggers = internalMutation({
  args: {
    event_type: v.string(),
    action: v.optional(v.string()),
    repository: v.optional(v.string()),
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
          await ctx.db.patch(task._id, {
            status: "scheduled",
            run_at: now,
            retry_count: task.retry_count + 1,
            lease_holder: undefined,
            lease_expires_at: undefined,
          });
          reclaimed++;
        } else {
          await ctx.db.patch(task._id, {
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
