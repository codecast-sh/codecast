import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1000; // 10 min
const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 min

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

    if (args.schedule_type === "recurring" && !args.interval_ms) {
      throw new Error("interval_ms required for recurring tasks");
    }
    if (args.schedule_type === "event" && !args.event_filter) {
      throw new Error("event_filter required for event tasks");
    }

    const now = Date.now();
    const run_at = args.schedule_type === "event" ? undefined : (args.run_at || now);

    const taskId = await ctx.db.insert("agent_tasks", {
      user_id: auth.userId,
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
      schedule_type: args.schedule_type,
      run_at,
      interval_ms: args.interval_ms,
      event_filter: args.event_filter,
      mode: (args.mode === "apply" ? "apply" : "propose") as "propose" | "apply",
      max_runtime_ms: args.max_runtime_ms || DEFAULT_MAX_RUNTIME_MS,
      status: "scheduled",
      retry_count: 0,
      max_retries: args.max_retries ?? DEFAULT_MAX_RETRIES,
      run_count: 0,
      created_at: now,
    });

    return taskId;
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
      last_run_conversation_id: args.conversation_id
        ? args.conversation_id as Id<"conversations">
        : undefined,
      lease_holder: undefined,
      lease_expires_at: undefined,
    };

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
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db.get(args.task_id);
    if (!task || task.user_id !== auth.userId) return false;
    if (task.lease_holder !== args.daemon_id) return false;

    const maxRetries = task.max_retries ?? DEFAULT_MAX_RETRIES;
    const newRetryCount = task.retry_count + 1;

    if (newRetryCount < maxRetries) {
      await ctx.db.patch(args.task_id, {
        status: "scheduled",
        retry_count: newRetryCount,
        run_at: Date.now() + 60_000 * newRetryCount, // backoff
        lease_holder: undefined,
        lease_expires_at: undefined,
        last_run_summary: args.error ? `Failed: ${args.error}` : "Failed",
      });
    } else {
      await ctx.db.patch(args.task_id, {
        status: "failed",
        retry_count: newRetryCount,
        lease_holder: undefined,
        lease_expires_at: undefined,
        last_run_summary: args.error ? `Failed: ${args.error}` : "Failed (max retries)",
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

export const cancelTask = mutation({
  args: {
    api_token: v.string(),
    task_id: v.id("agent_tasks"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db.get(args.task_id);
    if (!task || task.user_id !== auth.userId) return false;

    await ctx.db.patch(args.task_id, { status: "completed" });
    return true;
  },
});

export const pauseTask = mutation({
  args: {
    api_token: v.string(),
    task_id: v.id("agent_tasks"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db.get(args.task_id);
    if (!task || task.user_id !== auth.userId) return false;
    if (task.status !== "scheduled" && task.status !== "running") return false;

    await ctx.db.patch(args.task_id, { status: "paused" });
    return true;
  },
});

export const resumeTask = mutation({
  args: {
    api_token: v.string(),
    task_id: v.id("agent_tasks"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db.get(args.task_id);
    if (!task || task.user_id !== auth.userId) return false;
    if (task.status !== "paused") return false;

    await ctx.db.patch(args.task_id, {
      status: "scheduled",
      run_at: task.run_at || Date.now(),
    });
    return true;
  },
});

export const runTaskNow = mutation({
  args: {
    api_token: v.string(),
    task_id: v.id("agent_tasks"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db.get(args.task_id);
    if (!task || task.user_id !== auth.userId) return false;

    await ctx.db.patch(args.task_id, {
      status: "scheduled",
      run_at: Date.now(),
    });
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
