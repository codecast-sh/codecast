import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { verifyApiToken } from "./apiTokens";

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
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    source: v.optional(v.string()),
    session_id: v.optional(v.string()),
    project_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const user = await ctx.db.get(auth.userId);
    const team_id = user?.active_team_id || user?.team_id;
    const now = Date.now();
    const short_id = generateShortId();

    const id = await ctx.db.insert("plans", {
      short_id,
      title: args.title,
      goal: args.goal,
      acceptance_criteria: args.acceptance_criteria,
      status: "draft",
      source: (args.source as any) || "human",
      owner_id: auth.userId,
      team_id,
      project_id: args.project_id as any,
      task_ids: [],
      progress: { total: 0, done: 0, in_progress: 0, blocked: 0 },
      progress_log: [],
      decision_log: [],
      discoveries: [],
      context_pointers: [],
      session_ids: args.session_id ? [args.session_id] : [],
      current_session_id: args.session_id,
      created_at: now,
      updated_at: now,
    });

    return { short_id, _id: id };
  },
});

export const list = query({
  args: {
    api_token: v.string(),
    status: v.optional(v.string()),
    project_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const user = await ctx.db.get(auth.userId);
    const team_id = user?.active_team_id || user?.team_id;

    let plans;
    if (args.status && args.status !== "all") {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_team_and_status", (q) => q.eq("team_id", team_id!).eq("status", args.status as any))
        .collect();
    } else {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_team_id", (q) => q.eq("team_id", team_id!))
        .collect();
    }

    return plans.map((p) => ({
      short_id: p.short_id,
      title: p.title,
      status: p.status,
      task_done: p.progress?.done || 0,
      task_total: p.progress?.total || 0,
      goal: p.goal,
    }));
  },
});

export const get = query({
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
    if (!plan) return null;

    const tasks = [];
    for (const taskShortId of plan.task_ids || []) {
      const task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", taskShortId))
        .first();
      if (task) {
        tasks.push({ short_id: task.short_id, title: task.title, status: task.status });
      }
    }

    return {
      ...plan,
      short_id: plan.short_id,
      title: plan.title,
      status: plan.status,
      goal: plan.goal,
      acceptance_criteria: plan.acceptance_criteria,
      task_done: plan.progress?.done || 0,
      task_total: plan.progress?.total || 0,
      tasks,
      progress_log: (plan.progress_log || []).map((e) => ({ timestamp: e.timestamp, text: e.entry })),
      decisions: plan.decision_log || [],
      discoveries: plan.discoveries || [],
      context_pointers: plan.context_pointers || [],
    };
  },
});

export const update = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    title: v.optional(v.string()),
    goal: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const updates: Record<string, any> = { updated_at: Date.now() };
    if (args.title) updates.title = args.title;
    if (args.goal) updates.goal = args.goal;

    await ctx.db.patch(plan._id, updates);
    return { ok: true };
  },
});

export const bindSession = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const sessionIds = plan.session_ids || [];
    if (!sessionIds.includes(args.session_id)) {
      sessionIds.push(args.session_id);
    }

    await ctx.db.patch(plan._id, {
      current_session_id: args.session_id,
      session_ids: sessionIds,
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

export const unbindSession = mutation({
  args: {
    api_token: v.string(),
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plans = await ctx.db
      .query("plans")
      .filter((q) => q.eq(q.field("current_session_id"), args.session_id))
      .collect();

    for (const plan of plans) {
      await ctx.db.patch(plan._id, {
        current_session_id: undefined,
        updated_at: Date.now(),
      });
    }
    return { ok: true };
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
    return { ok: true };
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

    const decisions = plan.decision_log || [];
    decisions.push({
      timestamp: Date.now(),
      decision: args.decision,
      rationale: args.rationale || "",
      session_id: args.session_id,
    });

    await ctx.db.patch(plan._id, { decision_log: decisions, updated_at: Date.now() });
    return { ok: true };
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
    return { ok: true };
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
    return { ok: true };
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

    await ctx.db.patch(plan._id, { status: args.status as any, updated_at: Date.now() });
    return { ok: true };
  },
});
