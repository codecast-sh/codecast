import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";

export const create = mutation({
  args: {
    workflow_id: v.id("workflows"),
    task_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
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
      task_id: args.task_id,
      plan_id: args.plan_id,
      status: "pending",
      node_statuses: [],
      goal_override: args.goal_override,
      project_path: args.project_path,
      created_at: now,
      updated_at: now,
    });

    if (args.task_id) {
      await ctx.db.patch(args.task_id, {
        workflow_run_id: runId,
        status: "in_progress" as any,
        updated_at: now,
      });
    }

    if (args.plan_id) {
      await ctx.db.patch(args.plan_id, {
        workflow_run_id: runId,
        updated_at: now,
      });
    }

    // Create primary conversation — the single inbox entry for this run
    const primaryConvId = await ctx.db.insert("conversations", {
      user_id: userId,
      agent_type: "claude_code",
      session_id: `wf-${runId}`,
      title: workflow.name,
      project_path: args.project_path,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: false,
      status: "active",
      workflow_run_id: runId,
      is_workflow_primary: true,
    });

    await ctx.db.patch(runId, { primary_conversation_id: primaryConvId });

    await ctx.db.insert("messages", {
      conversation_id: primaryConvId,
      role: "assistant",
      content: JSON.stringify({ __wf: "started", goal: args.goal_override || workflow.goal || "", workflow_name: workflow.name }),
      subtype: "workflow_event",
      timestamp: now,
    });

    await ctx.db.patch(primaryConvId, { message_count: 1, last_message_role: "assistant" });

    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "run_workflow",
      args: JSON.stringify({ workflow_run_id: runId }),
      created_at: now,
    });

    return runId;
  },
});

export const createFromCli = mutation({
  args: {
    api_token: v.string(),
    workflow_name: v.string(),
    workflow_goal: v.optional(v.string()),
    workflow_id: v.optional(v.string()),
    task_id: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    goal_override: v.optional(v.string()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) throw new Error("Unauthorized");
    const userId = result.userId;

    const now = Date.now();

    let taskDocId: any = undefined;
    if (args.task_id) {
      const tasks = await ctx.db.query("tasks").withIndex("by_short_id", q => q.eq("short_id", args.task_id!)).first();
      if (tasks) taskDocId = tasks._id;
    }

    let planDocId: any = undefined;
    if (args.plan_id) {
      const plan = await ctx.db.query("plans").withIndex("by_short_id", q => q.eq("short_id", args.plan_id!)).first();
      if (plan) planDocId = plan._id;
    }

    // Resolve workflow_id — either passed directly or look up by name
    let workflowDocId: any = args.workflow_id ? (args.workflow_id as any) : undefined;
    if (!workflowDocId) {
      const wf = await ctx.db.query("workflows")
        .withIndex("by_user_id", q => q.eq("user_id", userId))
        .collect();
      const match = wf.find(w => w.name === args.workflow_name);
      if (match) workflowDocId = match._id;
    }

    const runId = await ctx.db.insert("workflow_runs", {
      user_id: userId,
      workflow_id: workflowDocId || (undefined as any),
      task_id: taskDocId,
      plan_id: planDocId,
      status: "pending",
      node_statuses: [],
      goal_override: args.goal_override,
      project_path: args.project_path,
      created_at: now,
      updated_at: now,
    });

    if (taskDocId) {
      await ctx.db.patch(taskDocId, { workflow_run_id: runId, status: "in_progress" as any, updated_at: now });
    }
    if (planDocId) {
      await ctx.db.patch(planDocId, { workflow_run_id: runId, updated_at: now });
    }

    const primaryConvId = await ctx.db.insert("conversations", {
      user_id: userId,
      agent_type: "claude_code",
      session_id: `wf-${runId}`,
      title: args.workflow_name,
      project_path: args.project_path,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: false,
      status: "active",
      workflow_run_id: runId,
      is_workflow_primary: true,
    });

    await ctx.db.patch(runId, { primary_conversation_id: primaryConvId });

    await ctx.db.insert("messages", {
      conversation_id: primaryConvId,
      role: "assistant",
      content: JSON.stringify({ __wf: "started", goal: args.goal_override || args.workflow_goal || "", workflow_name: args.workflow_name }),
      subtype: "workflow_event",
      timestamp: now,
    });

    await ctx.db.patch(primaryConvId, { message_count: 1, last_message_role: "assistant" });

    return { run_id: runId };
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

    const now = Date.now();
    await ctx.db.patch(args.id, {
      gate_response: args.response,
      status: "running",
      updated_at: now,
    });

    // Post the human's response as a user message to the primary conversation
    if (run.primary_conversation_id) {
      const primaryConv = await ctx.db.get(run.primary_conversation_id);
      if (primaryConv) {
        await ctx.db.insert("messages", {
          conversation_id: run.primary_conversation_id,
          role: "user",
          content: args.response,
          timestamp: now,
        });
        await ctx.db.patch(run.primary_conversation_id, {
          message_count: (primaryConv.message_count || 0) + 1,
          updated_at: now,
          last_message_role: "user",
        });
      }
    }
  },
});

export const respondToGateFromCli = mutation({
  args: { api_token: v.string(), run_id: v.id("workflow_runs"), response: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };
    if (run.status !== "paused") return { error: "Not paused" };
    await ctx.db.patch(args.run_id, { gate_response: args.response, status: "running", updated_at: Date.now() });
    return { ok: true };
  },
});

export const getForDaemon = mutation({
  args: { api_token: v.string(), run_id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };

    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };

    const workflow = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;

    let taskShortId: string | undefined;
    if (run.task_id) {
      const task = await ctx.db.get(run.task_id);
      if (task) taskShortId = task.short_id;
    }
    let planShortId: string | undefined;
    if (run.plan_id) {
      const plan = await ctx.db.get(run.plan_id);
      if (plan) planShortId = plan.short_id;
    }

    return {
      run: { ...run, task_short_id: taskShortId, plan_short_id: planShortId },
      workflow: workflow || { name: "workflow", goal: run.goal_override, nodes: [], edges: [] },
    };
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
    session_id: v.optional(v.string()),
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
    const prev = existing >= 0 ? nodeStatuses[existing] : undefined;
    const nodeEntry = {
      node_id: args.node_id,
      status: args.node_status,
      outcome: args.outcome,
      session_id: args.session_id ?? prev?.session_id,
      started_at: args.node_status === "running" ? now : (prev?.started_at ?? now),
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

    // Link the session conversation to this workflow run
    if (args.session_id) {
      const sessionId = args.session_id;
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
        .first();
      if (conv) {
        const isFirst = !run.primary_session_id;
        await ctx.db.patch(conv._id, {
          workflow_run_id: args.run_id,
          is_workflow_sub: !isFirst,
        });
        if (isFirst) {
          await ctx.db.patch(args.run_id, {
            primary_session_id: sessionId,
            updated_at: now,
          });
        }
      }
    }

    // Sync status to bound task/plan
    if (args.run_status) {
      const taskId = (run as any).task_id;
      const planId = (run as any).plan_id;

      if (taskId) {
        const taskUpdates: Record<string, any> = { updated_at: now };
        if (args.run_status === "completed") {
          taskUpdates.status = "in_review";
        } else if (args.run_status === "failed") {
          taskUpdates.execution_status = "blocked";
          if (args.fail_reason) taskUpdates.execution_concerns = args.fail_reason;
        }
        if (Object.keys(taskUpdates).length > 1) {
          await ctx.db.patch(taskId, taskUpdates);
        }
      }

      if (planId) {
        const planUpdates: Record<string, any> = { updated_at: now };
        if (args.run_status === "completed") {
          const progressLog = ((await ctx.db.get(planId)) as any)?.progress_log || [];
          progressLog.push({ timestamp: now, entry: "Workflow run completed" });
          planUpdates.progress_log = progressLog;
        }
        await ctx.db.patch(planId, planUpdates);
      }
    }

    // Post progress message to primary conversation
    if (run.primary_conversation_id && args.node_id !== "start") {
      const primaryConv = await ctx.db.get(run.primary_conversation_id);
      if (primaryConv) {
        const wfType = args.node_status === "running" ? "node_start"
          : args.node_status === "completed" ? "node_done"
          : "node_failed";
        await ctx.db.insert("messages", {
          conversation_id: run.primary_conversation_id,
          role: "assistant",
          content: JSON.stringify({ __wf: wfType, node_id: args.node_id, session_id: args.session_id }),
          subtype: "workflow_event",
          timestamp: now,
        });
        const newCount = (primaryConv.message_count || 0) + 1;
        await ctx.db.patch(run.primary_conversation_id, {
          message_count: newCount,
          updated_at: now,
          last_message_role: "assistant",
          // Mark completed when workflow finishes
          ...(args.run_status === "completed" || args.run_status === "failed" ? { status: "completed" as const } : {}),
        });
      }
    }

    return { ok: true };
  },
});

export const setPrimarySession = mutation({
  args: {
    api_token: v.string(),
    run_id: v.id("workflow_runs"),
    primary_session_id: v.string(),
    tmux_session: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) return { error: "Unauthorized" };
    const run = await ctx.db.get(args.run_id);
    if (!run || run.user_id !== auth.userId) return { error: "Not found" };
    await ctx.db.patch(args.run_id, {
      primary_session_id: args.primary_session_id,
      tmux_session: args.tmux_session,
      updated_at: Date.now(),
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

    const now = Date.now();
    await ctx.db.patch(args.run_id, {
      status: "paused",
      current_node_id: args.node_id,
      gate_prompt: args.prompt,
      gate_choices: args.choices,
      gate_response: undefined,
      updated_at: now,
    });

    if ((run as any).task_id) {
      await ctx.db.patch((run as any).task_id, { status: "in_review" as any, updated_at: now });
    }

    // Post gate message to primary conversation
    if (run.primary_conversation_id) {
      const primaryConv = await ctx.db.get(run.primary_conversation_id);
      if (primaryConv) {
        await ctx.db.insert("messages", {
          conversation_id: run.primary_conversation_id,
          role: "assistant",
          content: JSON.stringify({ __wf: "gate", prompt: args.prompt, choices: args.choices, run_id: args.run_id }),
          subtype: "workflow_event",
          timestamp: now,
        });
        await ctx.db.patch(run.primary_conversation_id, {
          message_count: (primaryConv.message_count || 0) + 1,
          updated_at: now,
          last_message_role: "assistant",
        });
      }
    }

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

export const cancel = mutation({
  args: { id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const run = await ctx.db.get(args.id);
    if (!run || run.user_id !== userId) throw new Error("Not found");
    if (run.status === "completed" || run.status === "failed") return;
    await ctx.db.patch(args.id, {
      status: "failed",
      fail_reason: "Cancelled by user",
      updated_at: Date.now(),
    });
  },
});
