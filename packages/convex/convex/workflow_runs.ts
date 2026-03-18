import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";

export const create = mutation({
  args: {
    workflow_id: v.id("workflows"),
    goal_override: v.optional(v.string()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const workflow = await ctx.db.get(args.workflow_id);
    if (!workflow || workflow.user_id !== userId) throw new Error("Not found");

    const now = Date.now();
    const runId = await ctx.db.insert("workflow_runs", {
      user_id: userId,
      workflow_id: args.workflow_id,
      status: "pending",
      node_statuses: [],
      goal_override: args.goal_override,
      project_path: args.project_path,
      created_at: now,
      updated_at: now,
    });

    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "run_workflow",
      args: JSON.stringify({ workflow_run_id: runId }),
      created_at: now,
    });

    return runId;
  },
});

export const listForWorkflow = query({
  args: { workflow_id: v.id("workflows") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("workflow_runs")
      .withIndex("by_workflow_id", (q) => q.eq("workflow_id", args.workflow_id))
      .order("desc")
      .take(20);
  },
});

export const get = query({
  args: { id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const run = await ctx.db.get(args.id);
    if (!run || run.user_id !== userId) return null;
    return run;
  },
});

export const respondToGate = mutation({
  args: {
    id: v.id("workflow_runs"),
    response: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const run = await ctx.db.get(args.id);
    if (!run || run.user_id !== userId) throw new Error("Not found");
    if (run.status !== "paused") throw new Error("Not paused");

    await ctx.db.patch(args.id, {
      gate_response: args.response,
      status: "running",
      updated_at: Date.now(),
    });
  },
});

export const getForDaemon = mutation({
  args: { api_token: v.string(), run_id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };

    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };

    const workflow = await ctx.db.get(run.workflow_id);
    if (!workflow) return { error: "Workflow not found" };

    return { run, workflow };
  },
});

export const updateProgress = mutation({
  args: {
    api_token: v.string(),
    run_id: v.id("workflow_runs"),
    current_node_id: v.string(),
    node_id: v.string(),
    node_status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    outcome: v.optional(v.string()),
    run_status: v.optional(v.union(v.literal("running"), v.literal("completed"), v.literal("failed"))),
    fail_reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };

    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };

    const now = Date.now();
    const nodeStatuses = [...run.node_statuses];
    const existing = nodeStatuses.findIndex((n) => n.node_id === args.node_id);
    const nodeEntry = {
      node_id: args.node_id,
      status: args.node_status,
      outcome: args.outcome,
      started_at: args.node_status === "running" ? now : (existing >= 0 ? nodeStatuses[existing].started_at : now),
      completed_at: args.node_status !== "running" ? now : undefined,
    };

    if (existing >= 0) {
      nodeStatuses[existing] = nodeEntry;
    } else {
      nodeStatuses.push(nodeEntry);
    }

    await ctx.db.patch(args.run_id, {
      current_node_id: args.current_node_id,
      node_statuses: nodeStatuses,
      status: args.run_status ?? run.status,
      fail_reason: args.fail_reason,
      updated_at: now,
    });

    return { ok: true };
  },
});

export const pauseAtGate = mutation({
  args: {
    api_token: v.string(),
    run_id: v.id("workflow_runs"),
    node_id: v.string(),
    prompt: v.string(),
    choices: v.array(v.object({ key: v.string(), label: v.string(), target: v.string() })),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };

    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };

    await ctx.db.patch(args.run_id, {
      status: "paused",
      current_node_id: args.node_id,
      gate_prompt: args.prompt,
      gate_choices: args.choices,
      gate_response: undefined,
      updated_at: Date.now(),
    });

    return { ok: true };
  },
});

export const pollGateResponse = mutation({
  args: {
    api_token: v.string(),
    run_id: v.id("workflow_runs"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };

    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };

    return {
      status: run.status,
      gate_response: run.gate_response ?? null,
    };
  },
});
