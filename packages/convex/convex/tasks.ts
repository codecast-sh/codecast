import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";

function generateShortId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "ct-";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    task_type: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    project_id: v.optional(v.string()),
    parent_id: v.optional(v.string()),
    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    blocked_by: v.optional(v.array(v.string())),
    source: v.optional(v.string()),
    confidence: v.optional(v.number()),
    conversation_id: v.optional(v.string()),
    insight_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const now = Date.now();
    const short_id = generateShortId();

    const user = await ctx.db.get(auth.userId);
    const team_id = user?.active_team_id || user?.team_id;

    let project_id: Id<"projects"> | undefined;
    if (args.project_id) {
      const project = await ctx.db
        .query("projects")
        .filter((q) => q.eq(q.field("_id"), args.project_id as any))
        .first();
      if (project) project_id = project._id;
    }

    let conversation_ids: Id<"conversations">[] | undefined;
    let created_from_conversation: Id<"conversations"> | undefined;
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv) {
        conversation_ids = [conv._id];
        created_from_conversation = conv._id;
      }
    }

    const id = await ctx.db.insert("tasks", {
      user_id: auth.userId,
      team_id,
      project_id,
      parent_id: args.parent_id as any,
      short_id,
      title: args.title,
      description: args.description,
      task_type: (args.task_type || "task") as any,
      status: (args.status || "open") as any,
      priority: (args.priority || "medium") as any,
      assignee: args.assignee,
      labels: args.labels,
      blocked_by: args.blocked_by,
      blocks: [],
      conversation_ids,
      created_from_conversation,
      created_from_insight: args.insight_id as any,
      source: (args.source || "human") as any,
      confidence: args.confidence,
      attempt_count: 0,
      created_at: now,
      updated_at: now,
    });

    return { id, short_id };
  },
});

export const list = query({
  args: {
    api_token: v.string(),
    project_id: v.optional(v.string()),
    status: v.optional(v.string()),
    ready: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    let tasks;
    if (args.project_id) {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else if (args.status) {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_status", (q) =>
          q.eq("user_id", auth.userId).eq("status", args.status as any)
        )
        .collect();
    } else {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q) => q.eq("user_id", auth.userId))
        .collect();
    }

    // Filter out done/dropped unless explicitly requested
    if (!args.status) {
      tasks = tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
    }

    // Ready = open + no blockers
    if (args.ready) {
      const allShortIds = new Set(tasks.map((t) => t.short_id));
      tasks = tasks.filter((t) => {
        if (t.status !== "open") return false;
        if (!t.blocked_by || t.blocked_by.length === 0) return true;
        // Check if all blockers are done
        return t.blocked_by.every((bid) => {
          const blocker = tasks.find((bt) => bt.short_id === bid);
          return blocker && (blocker.status === "done" || blocker.status === "dropped");
        });
      });
    }

    const limit = args.limit || 50;
    return tasks.slice(0, limit);
  },
});

export const get = query({
  args: {
    api_token: v.string(),
    short_id: v.optional(v.string()),
    id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    let task;
    if (args.short_id) {
      task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id!))
        .first();
    } else if (args.id) {
      task = await ctx.db.get(args.id as any);
    }

    if (!task || task.user_id !== auth.userId) return null;

    // Fetch comments
    const comments = await ctx.db
      .query("task_comments")
      .withIndex("by_task_id", (q) => q.eq("task_id", task!._id))
      .collect();

    return { ...task, comments };
  },
});

export const update = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    project_id: v.optional(v.string()),
    blocked_by: v.optional(v.array(v.string())),
    blocks: v.optional(v.array(v.string())),
    last_session_summary: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || task.user_id !== auth.userId) throw new Error("Task not found");

    const updates: any = { updated_at: Date.now() };
    if (args.status) updates.status = args.status;
    if (args.priority) updates.priority = args.priority;
    if (args.title) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.assignee !== undefined) updates.assignee = args.assignee;
    if (args.labels) updates.labels = args.labels;
    if (args.project_id !== undefined) updates.project_id = args.project_id || undefined;
    if (args.blocked_by) updates.blocked_by = args.blocked_by;
    if (args.blocks) updates.blocks = args.blocks;
    if (args.last_session_summary) updates.last_session_summary = args.last_session_summary;

    if (args.status === "done" || args.status === "dropped") {
      updates.closed_at = Date.now();
    }

    // Link conversation if provided
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv) {
        const existing = task.conversation_ids || [];
        if (!existing.some((id) => id === conv._id)) {
          updates.conversation_ids = [...existing, conv._id];
        }
      }
    }

    if (args.status === "in_progress") {
      updates.attempt_count = (task.attempt_count || 0) + 1;
    }

    await ctx.db.patch(task._id, updates);
    return { success: true };
  },
});

export const addComment = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    text: v.string(),
    author: v.optional(v.string()),
    comment_type: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || task.user_id !== auth.userId) throw new Error("Task not found");

    const user = await ctx.db.get(auth.userId);

    let conversation_id: Id<"conversations"> | undefined;
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv) conversation_id = conv._id;
    }

    const id = await ctx.db.insert("task_comments", {
      task_id: task._id,
      author: args.author || user?.name || "unknown",
      text: args.text,
      conversation_id,
      comment_type: (args.comment_type || "note") as any,
      created_at: Date.now(),
    });

    return { id };
  },
});

export const addDep = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    blocks: v.optional(v.string()),
    blocked_by: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || task.user_id !== auth.userId) throw new Error("Task not found");

    if (args.blocks) {
      const current = task.blocks || [];
      if (!current.includes(args.blocks)) {
        await ctx.db.patch(task._id, { blocks: [...current, args.blocks], updated_at: Date.now() });
      }
      // Also add reverse dep
      const other = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.blocks!))
        .first();
      if (other) {
        const otherBlocked = other.blocked_by || [];
        if (!otherBlocked.includes(args.short_id)) {
          await ctx.db.patch(other._id, { blocked_by: [...otherBlocked, args.short_id], updated_at: Date.now() });
        }
      }
    }

    if (args.blocked_by) {
      const current = task.blocked_by || [];
      if (!current.includes(args.blocked_by)) {
        await ctx.db.patch(task._id, { blocked_by: [...current, args.blocked_by], updated_at: Date.now() });
      }
      // Also add reverse dep
      const other = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.blocked_by!))
        .first();
      if (other) {
        const otherBlocks = other.blocks || [];
        if (!otherBlocks.includes(args.short_id)) {
          await ctx.db.patch(other._id, { blocks: [...otherBlocks, args.short_id], updated_at: Date.now() });
        }
      }
    }

    return { success: true };
  },
});

export const context = query({
  args: {
    api_token: v.string(),
    short_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || task.user_id !== auth.userId) return null;

    const comments = await ctx.db
      .query("task_comments")
      .withIndex("by_task_id", (q) => q.eq("task_id", task._id))
      .collect();

    // Get session summaries from linked conversations
    const sessionSummaries: string[] = [];
    if (task.conversation_ids) {
      for (const convId of task.conversation_ids.slice(-5)) {
        const insight = await ctx.db
          .query("session_insights")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", convId))
          .first();
        if (insight) {
          sessionSummaries.push(insight.summary);
        }
      }
    }

    // Get project info
    let project = null;
    if (task.project_id) {
      project = await ctx.db.get(task.project_id);
    }

    return {
      task,
      comments,
      sessionSummaries,
      project: project ? { title: project.title, description: project.description } : null,
    };
  },
});

// --- Web-facing queries (use Convex auth, no api_token) ---

export const webList = query({
  args: {
    project_id: v.optional(v.string()),
    status: v.optional(v.string()),
    ready: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    let tasks;
    if (args.project_id) {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else if (args.status) {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_status", (q) =>
          q.eq("user_id", userId).eq("status", args.status as any)
        )
        .collect();
    } else {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
    }

    if (!args.status) {
      tasks = tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
    }

    if (args.ready) {
      tasks = tasks.filter((t) => {
        if (t.status !== "open") return false;
        if (!t.blocked_by || t.blocked_by.length === 0) return true;
        return t.blocked_by.every((bid) => {
          const blocker = tasks.find((bt) => bt.short_id === bid);
          return blocker && (blocker.status === "done" || blocker.status === "dropped");
        });
      });
    }

    return tasks.slice(0, args.limit || 50);
  },
});

export const webGet = query({
  args: {
    short_id: v.optional(v.string()),
    id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    let task;
    if (args.short_id) {
      task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id!))
        .first();
    } else if (args.id) {
      task = await ctx.db.get(args.id as any);
    }

    if (!task || task.user_id !== userId) return null;

    const comments = await ctx.db
      .query("task_comments")
      .withIndex("by_task_id", (q) => q.eq("task_id", task!._id))
      .collect();

    return { ...task, comments };
  },
});

export const webUpdate = mutation({
  args: {
    short_id: v.string(),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    project_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || task.user_id !== userId) throw new Error("Task not found");

    const updates: any = { updated_at: Date.now() };
    if (args.status) updates.status = args.status;
    if (args.priority) updates.priority = args.priority;
    if (args.title) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.assignee !== undefined) updates.assignee = args.assignee;
    if (args.labels) updates.labels = args.labels;
    if (args.project_id !== undefined) updates.project_id = args.project_id || undefined;

    if (args.status === "done" || args.status === "dropped") {
      updates.closed_at = Date.now();
    }
    if (args.status === "in_progress") {
      updates.attempt_count = (task.attempt_count || 0) + 1;
    }

    await ctx.db.patch(task._id, updates);
    return { success: true };
  },
});

export const webAddComment = mutation({
  args: {
    short_id: v.string(),
    text: v.string(),
    comment_type: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || task.user_id !== userId) throw new Error("Task not found");

    const user = await ctx.db.get(userId);

    await ctx.db.insert("task_comments", {
      task_id: task._id,
      author: user?.name || "unknown",
      text: args.text,
      comment_type: (args.comment_type || "note") as any,
      created_at: Date.now(),
    });

    return { success: true };
  },
});

export const webCreate = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    task_type: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    project_id: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const user = await ctx.db.get(userId);
    const team_id = user?.active_team_id || user?.team_id;
    const short_id = generateShortId();

    let project_id: Id<"projects"> | undefined;
    if (args.project_id) {
      const project = await ctx.db
        .query("projects")
        .filter((q) => q.eq(q.field("_id"), args.project_id as any))
        .first();
      if (project) project_id = project._id;
    }

    const now = Date.now();
    const id = await ctx.db.insert("tasks", {
      user_id: userId,
      team_id,
      project_id,
      short_id,
      title: args.title,
      description: args.description,
      task_type: (args.task_type || "task") as any,
      status: (args.status || "open") as any,
      priority: (args.priority || "medium") as any,
      labels: args.labels,
      source: "human",
      attempt_count: 0,
      created_at: now,
      updated_at: now,
    });

    return { id, short_id };
  },
});
