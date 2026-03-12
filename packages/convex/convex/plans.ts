import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";

function generateShortId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "pl-";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- API token mutations ---

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    source: v.optional(v.string()),
    project_id: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
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

    let created_from_conversation_id: Id<"conversations"> | undefined;
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv) created_from_conversation_id = conv._id;
    }

    const id = await ctx.db.insert("plans", {
      user_id: auth.userId,
      team_id,
      project_id,
      short_id,
      title: args.title,
      goal: args.goal,
      acceptance_criteria: args.acceptance_criteria,
      status: (args.status || "draft") as any,
      source: (args.source || "human") as any,
      owner_id: auth.userId,
      task_ids: [],
      progress: { total: 0, done: 0, in_progress: 0, open: 0 },
      progress_log: [],
      decision_log: [],
      discoveries: [],
      context_pointers: [],
      session_ids: [],
      created_from_conversation_id,
      created_at: now,
      updated_at: now,
    });

    return { id, short_id };
  },
});

export const update = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    title: v.optional(v.string()),
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    task_ids: v.optional(v.array(v.string())),
    context_pointers: v.optional(v.array(v.object({
      label: v.string(),
      path_or_url: v.string(),
    }))),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const user = await ctx.db.get(auth.userId);
    const team_id = user?.active_team_id || user?.team_id;
    if (plan.user_id !== auth.userId && plan.team_id !== team_id) throw new Error("Plan not found");

    const updates: any = { updated_at: Date.now() };
    if (args.title) updates.title = args.title;
    if (args.goal !== undefined) updates.goal = args.goal;
    if (args.acceptance_criteria) updates.acceptance_criteria = args.acceptance_criteria;
    if (args.status) updates.status = args.status;
    if (args.context_pointers) updates.context_pointers = args.context_pointers;

    if (args.task_ids) {
      const taskDocIds = args.task_ids.map(id => id as Id<"tasks">);
      updates.task_ids = taskDocIds;

      let total = 0, done = 0, in_progress = 0, open = 0;
      for (const tid of taskDocIds) {
        const task = await ctx.db.get(tid);
        if (task) {
          total++;
          if (task.status === "done") done++;
          else if (task.status === "in_progress" || task.status === "in_review") in_progress++;
          else if (task.status === "open" || task.status === "draft") open++;
        }
      }
      updates.progress = { total, done, in_progress, open };
    }

    await ctx.db.patch(plan._id, updates);
    return { success: true };
  },
});

export const updateStatus = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const user = await ctx.db.get(auth.userId);
    const team_id = user?.active_team_id || user?.team_id;
    if (plan.user_id !== auth.userId && plan.team_id !== team_id) throw new Error("Plan not found");

    const validStatuses = ["draft", "active", "paused", "done", "abandoned"];
    if (!validStatuses.includes(args.status)) throw new Error(`Invalid status: ${args.status}`);

    await ctx.db.patch(plan._id, { status: args.status as any, updated_at: Date.now() });
    return { success: true };
  },
});

export const addLogEntry = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    entry: v.string(),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const log = plan.progress_log || [];
    log.push({ timestamp: Date.now(), entry: args.entry, session_id: args.session_id });

    await ctx.db.patch(plan._id, { progress_log: log, updated_at: Date.now() });
    return { success: true };
  },
});

export const addDecision = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    decision: v.string(),
    rationale: v.optional(v.string()),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const log = plan.decision_log || [];
    log.push({ timestamp: Date.now(), decision: args.decision, rationale: args.rationale, session_id: args.session_id });

    await ctx.db.patch(plan._id, { decision_log: log, updated_at: Date.now() });
    return { success: true };
  },
});

export const addDiscovery = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    finding: v.string(),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const discoveries = plan.discoveries || [];
    discoveries.push({ timestamp: Date.now(), finding: args.finding, session_id: args.session_id });

    await ctx.db.patch(plan._id, { discoveries, updated_at: Date.now() });
    return { success: true };
  },
});

export const addPointer = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    label: v.string(),
    path_or_url: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const pointers = plan.context_pointers || [];
    pointers.push({ label: args.label, path_or_url: args.path_or_url });

    await ctx.db.patch(plan._id, { context_pointers: pointers, updated_at: Date.now() });
    return { success: true };
  },
});

export const bindSession = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    conversation_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id))
      .first();
    if (!conv) throw new Error("Conversation not found");

    const sessionIds = plan.session_ids || [];
    if (!sessionIds.some(id => id === conv._id)) {
      sessionIds.push(conv._id);
    }

    await ctx.db.patch(plan._id, {
      current_session_id: conv._id,
      session_ids: sessionIds,
      updated_at: Date.now(),
    });

    await ctx.db.patch(conv._id, { active_plan_id: plan._id });

    return { success: true };
  },
});

export const unbindSession = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    if (plan.current_session_id) {
      const conv = await ctx.db.get(plan.current_session_id);
      if (conv) {
        await ctx.db.patch(conv._id, { active_plan_id: undefined });
      }
    }

    await ctx.db.patch(plan._id, {
      current_session_id: undefined,
      updated_at: Date.now(),
    });

    return { success: true };
  },
});

// --- API token queries ---

export const get = query({
  args: {
    api_token: v.string(),
    short_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) return null;

    const user = await ctx.db.get(auth.userId);
    const team_id = user?.active_team_id || user?.team_id;
    if (plan.user_id !== auth.userId && plan.team_id !== team_id) return null;

    const tasks = [];
    if (plan.task_ids) {
      for (const tid of plan.task_ids) {
        const task = await ctx.db.get(tid);
        if (task) tasks.push(task);
      }
    }

    return { ...plan, tasks };
  },
});

export const list = query({
  args: {
    api_token: v.string(),
    status: v.optional(v.string()),
    project_id: v.optional(v.string()),
    team: v.optional(v.boolean()),
    include_all: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const user = await ctx.db.get(auth.userId);
    const team_id = user?.active_team_id || user?.team_id;

    let plans;
    if (args.project_id) {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else if (args.team && team_id) {
      if (args.status) {
        plans = await ctx.db
          .query("plans")
          .withIndex("by_team_status", (q) => q.eq("team_id", team_id).eq("status", args.status as any))
          .collect();
      } else {
        plans = await ctx.db
          .query("plans")
          .withIndex("by_team_id", (q) => q.eq("team_id", team_id))
          .collect();
      }
    } else if (args.status) {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_user_status", (q) => q.eq("user_id", auth.userId).eq("status", args.status as any))
        .collect();
    } else {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_user_id", (q) => q.eq("user_id", auth.userId))
        .collect();
    }

    if (!args.status && !args.include_all) {
      plans = plans.filter(p => p.status !== "done" && p.status !== "abandoned");
    }

    return plans.slice(0, args.limit || 50);
  },
});

export const snippet = query({
  args: {
    api_token: v.string(),
    plan_short_id: v.optional(v.string()),
    plan_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    let plan;
    if (args.plan_short_id) {
      plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_short_id!))
        .first();
    } else if (args.plan_id) {
      plan = await ctx.db.get(args.plan_id as Id<"plans">);
    }

    if (!plan) return { snippet: "", task_count: 0 };

    const lines: string[] = [];
    lines.push(`Plan: ${plan.title} (${plan.short_id}) [${plan.status}]`);
    if (plan.goal) lines.push(`Goal: ${plan.goal}`);

    if (plan.acceptance_criteria?.length) {
      lines.push("Acceptance Criteria:");
      for (const c of plan.acceptance_criteria) {
        lines.push(`  - ${c}`);
      }
    }

    if (plan.progress) {
      const p = plan.progress;
      lines.push(`Progress: ${p.done}/${p.total} done, ${p.in_progress} in progress, ${p.open} open`);
    }

    const tasks = [];
    if (plan.task_ids) {
      for (const tid of plan.task_ids) {
        const task = await ctx.db.get(tid);
        if (task) tasks.push(task);
      }
    }

    if (tasks.length > 0) {
      lines.push("Tasks:");
      for (const t of tasks) {
        lines.push(`  - ${t.short_id}: ${t.title} [${t.status}]`);
      }
    }

    if (plan.decision_log?.length) {
      lines.push("Recent Decisions:");
      for (const d of plan.decision_log.slice(-3)) {
        lines.push(`  - ${d.decision}${d.rationale ? ` (${d.rationale})` : ""}`);
      }
    }

    if (plan.discoveries?.length) {
      lines.push("Discoveries:");
      for (const d of plan.discoveries.slice(-3)) {
        lines.push(`  - ${d.finding}`);
      }
    }

    if (plan.context_pointers?.length) {
      lines.push("Context:");
      for (const p of plan.context_pointers) {
        lines.push(`  - ${p.label}: ${p.path_or_url}`);
      }
    }

    return {
      snippet: lines.join("\n"),
      task_count: tasks.length,
    };
  },
});

// --- Web mutations/queries (Convex auth) ---

export const webCreate = mutation({
  args: {
    title: v.string(),
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    source: v.optional(v.string()),
    project_id: v.optional(v.string()),
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
    const id = await ctx.db.insert("plans", {
      user_id: userId,
      team_id,
      project_id,
      short_id,
      title: args.title,
      goal: args.goal,
      acceptance_criteria: args.acceptance_criteria,
      status: (args.status || "draft") as any,
      source: (args.source || "human") as any,
      owner_id: userId,
      task_ids: [],
      progress: { total: 0, done: 0, in_progress: 0, open: 0 },
      progress_log: [],
      decision_log: [],
      discoveries: [],
      context_pointers: [],
      session_ids: [],
      created_at: now,
      updated_at: now,
    });

    return { id, short_id };
  },
});

export const webUpdate = mutation({
  args: {
    short_id: v.string(),
    title: v.optional(v.string()),
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    task_ids: v.optional(v.array(v.string())),
    context_pointers: v.optional(v.array(v.object({
      label: v.string(),
      path_or_url: v.string(),
    }))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const user = await ctx.db.get(userId);
    const team_id = user?.active_team_id || user?.team_id;
    if (plan.user_id !== userId && plan.team_id !== team_id) throw new Error("Plan not found");

    const updates: any = { updated_at: Date.now() };
    if (args.title) updates.title = args.title;
    if (args.goal !== undefined) updates.goal = args.goal;
    if (args.acceptance_criteria) updates.acceptance_criteria = args.acceptance_criteria;
    if (args.status) updates.status = args.status;
    if (args.context_pointers) updates.context_pointers = args.context_pointers;

    if (args.task_ids) {
      const taskDocIds = args.task_ids.map(id => id as Id<"tasks">);
      updates.task_ids = taskDocIds;

      let total = 0, done = 0, in_progress = 0, open = 0;
      for (const tid of taskDocIds) {
        const task = await ctx.db.get(tid);
        if (task) {
          total++;
          if (task.status === "done") done++;
          else if (task.status === "in_progress" || task.status === "in_review") in_progress++;
          else if (task.status === "open" || task.status === "draft") open++;
        }
      }
      updates.progress = { total, done, in_progress, open };
    }

    await ctx.db.patch(plan._id, updates);
    return { success: true };
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

    let plan;
    if (args.short_id) {
      plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id!))
        .first();
    } else if (args.id) {
      plan = await ctx.db.get(args.id as Id<"plans">);
    }

    if (!plan) return null;

    const user = await ctx.db.get(userId);
    const team_id = user?.active_team_id || user?.team_id;
    if (plan.user_id !== userId && plan.team_id !== team_id) return null;

    const tasks = [];
    if (plan.task_ids) {
      for (const tid of plan.task_ids) {
        const task = await ctx.db.get(tid);
        if (task) tasks.push(task);
      }
    }

    return { ...plan, tasks };
  },
});

export const webList = query({
  args: {
    status: v.optional(v.string()),
    project_id: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const user = await ctx.db.get(userId);
    const team_id = user?.active_team_id || user?.team_id;

    let plans;
    if (args.project_id) {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else if (team_id) {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_team_id", (q) => q.eq("team_id", team_id))
        .collect();
    } else {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
    }

    if (args.status) {
      plans = plans.filter(p => p.status === args.status);
    } else {
      plans = plans.filter(p => p.status !== "done" && p.status !== "abandoned");
    }

    return plans.slice(0, args.limit || 50);
  },
});

export const webTeamList = query({
  args: {
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const user = await ctx.db.get(userId);
    const team_id = user?.active_team_id || user?.team_id;
    if (!team_id) return [];

    let plans = await ctx.db
      .query("plans")
      .withIndex("by_team_id", (q) => q.eq("team_id", team_id))
      .collect();

    if (args.status) {
      plans = plans.filter(p => p.status === args.status);
    } else {
      plans = plans.filter(p => p.status !== "done" && p.status !== "abandoned");
    }

    return plans.slice(0, args.limit || 100);
  },
});
