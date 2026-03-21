import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext } from "./data";
import { nextShortId } from "./counters";

async function recalcPlanProgress(ctx: any, planId: Id<"plans">, updatedTaskId: Id<"tasks">, newStatus: string) {
  const plan = await ctx.db.get(planId);
  if (!plan || !plan.task_ids) return;

  let total = 0, done = 0, in_progress = 0, open = 0;
  for (const tid of plan.task_ids) {
    const t = tid === updatedTaskId
      ? { status: newStatus }
      : await ctx.db.get(tid);
    if (t) {
      total++;
      if (t.status === "done") done++;
      else if (t.status === "in_progress" || t.status === "in_review") in_progress++;
      else if (t.status === "open" || t.status === "backlog") open++;
    }
  }

  const now = Date.now();
  const updates: any = { progress: { total, done, in_progress, open }, updated_at: now };
  if (done > 0 && in_progress === 0 && open === 0 && plan.status !== "done") {
    updates.status = "done";
  }
  await ctx.db.patch(plan._id, updates);
}


async function canAccessTask(ctx: any, userId: Id<"users">, task: any): Promise<boolean> {
  if (task.user_id === userId) return true;
  if (!task.team_id) return false;
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", task.team_id))
    .first();
  return !!membership;
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
    plan_id: v.optional(v.string()),
    max_retries: v.optional(v.number()),
    model: v.optional(v.string()),
    verify_with: v.optional(v.string()),
    max_visits: v.optional(v.number()),
    retry_target: v.optional(v.string()),
    thread_id: v.optional(v.string()),
    fidelity: v.optional(v.string()),
    condition: v.optional(v.string()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });
    const now = Date.now();
    const short_id = await nextShortId(ctx.db, "ct");

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

    let plan_id: Id<"plans"> | undefined;
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (plan) plan_id = plan._id;
    }

    const id = await db.insert("tasks", {
      project_id,
      parent_id: args.parent_id as any,
      plan_id,
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
      retry_count: 0,
      max_retries: args.max_retries ?? 3,
      model: args.model,
      verify_with: args.verify_with,
      max_visits: args.max_visits,
      retry_target: args.retry_target,
      thread_id: args.thread_id,
      fidelity: args.fidelity,
      condition: args.condition,
      project_path: args.project_path,
    } as any);

    if (plan_id) {
      const plan = await ctx.db.get(plan_id);
      if (plan) {
        const taskIds = plan.task_ids || [];
        taskIds.push(id);
        const progress = plan.progress || { total: 0, done: 0, in_progress: 0, open: 0 };
        progress.total++;
        progress.open++;
        await ctx.db.patch(plan._id, { task_ids: taskIds, progress, updated_at: now });
      }
    }

    if (created_from_conversation) {
      const conv = await ctx.db.get(created_from_conversation);
      if (conv) {
        await ctx.db.patch(created_from_conversation, { active_task_id: id });
        if (plan_id && !conv.active_plan_id) {
          await ctx.db.patch(created_from_conversation, { active_plan_id: plan_id });
        }
      }
    }

    return { id, short_id };
  },
});

// Promote a derived (mined) task to a real/promoted task
export const promote = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task) throw new Error("Task not found");

    if (task.user_id !== auth.userId) {
      const accessed = await db.get(task._id);
      if (!accessed) throw new Error("Task not found");
    }

    await ctx.db.patch(task._id, { promoted: true, updated_at: Date.now() });
    return { success: true };
  },
});

// Generate a task snippet for agent instructions
export const snippet = query({
  args: {
    api_token: v.string(),
    conversation_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });

    const tasks = await db.query("tasks").collect();

    const activeTasks = tasks.filter((t: any) =>
      (t.status === "open" || t.status === "in_progress" || t.status === "in_review") &&
      (t.source !== "insight" || t.promoted === true)
    );

    const userIds = [...new Set(activeTasks.map((t: any) => t.user_id as Id<"users">))] as Id<"users">[];
    const userMap = new Map<string, string>();
    for (const uid of userIds) {
      const u = await ctx.db.get(uid) as any;
      if (u) userMap.set(uid.toString(), u.name || u.email || "unknown");
    }

    let sessionPlans: { title: string; doc_type: string; content: string }[] = [];
    let activePlanSnippet = "";
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv) {
        const allDocs = await db.query("docs").collect();

        sessionPlans = allDocs
          .filter((d: any) => !d.archived_at && (d.conversation_id === conv._id || d.project_path === conv.project_path))
          .slice(0, 5)
          .map((d: any) => ({ title: d.title, doc_type: d.doc_type, content: (d.content || "").slice(0, 500) }));

        if (conv.active_plan_id) {
          const plan = await ctx.db.get(conv.active_plan_id);
          if (plan) {
            const planLines: string[] = [];
            planLines.push(`Active Plan: ${plan.title} (${plan.short_id}) [${plan.status}]`);
            if (plan.goal) planLines.push(`Goal: ${plan.goal}`);
            if (plan.progress) {
              const p = plan.progress;
              planLines.push(`Progress: ${p.done}/${p.total} done, ${p.in_progress} in progress, ${p.open} open`);
            }
            if (plan.task_ids) {
              for (const tid of plan.task_ids.slice(0, 10)) {
                const t = await ctx.db.get(tid);
                if (t) planLines.push(`  - ${t.short_id}: ${t.title} [${t.status}]`);
              }
            }
            activePlanSnippet = planLines.join("\n");
          }
        }
      }
    }

    const lines: string[] = [];
    if (activeTasks.length > 0) {
      const inProgress = activeTasks.filter((t: any) => t.status === "in_progress");
      const open = activeTasks.filter((t: any) => t.status === "open");

      if (inProgress.length > 0) {
        lines.push("In Progress:");
        for (const t of inProgress.slice(0, 10)) {
          const owner = userMap.get(t.user_id.toString()) || "";
          lines.push(`- ${t.short_id}: ${t.title}${owner ? ` (${owner})` : ""}${t.labels?.length ? ` [${t.labels.join(", ")}]` : ""}`);
        }
      }

      if (open.length > 0) {
        lines.push("Open:");
        for (const t of open.slice(0, 10)) {
          const owner = userMap.get(t.user_id.toString()) || "";
          lines.push(`- ${t.short_id}: ${t.title}${owner ? ` (${owner})` : ""}${t.priority === "high" || t.priority === "urgent" ? ` [${t.priority}]` : ""}`);
        }
      }
    }

    if (activePlanSnippet) {
      lines.push(activePlanSnippet);
    }

    if (sessionPlans.length > 0) {
      lines.push("Related Plans:");
      for (const p of sessionPlans) {
        lines.push(`- ${p.title} (${p.doc_type})`);
      }
    }

    return {
      snippet: lines.join("\n"),
      task_count: activeTasks.length,
      plan_count: sessionPlans.length,
    };
  },
});

export const list = query({
  args: {
    api_token: v.string(),
    project_id: v.optional(v.string()),
    status: v.optional(v.string()),
    execution_status: v.optional(v.string()),
    ready: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    team: v.optional(v.boolean()),
    include_derived: v.optional(v.boolean()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    let teamIdForScope: Id<"teams"> | undefined;
    if (args.team) {
      const user = await ctx.db.get(auth.userId);
      teamIdForScope = user?.active_team_id || user?.team_id;
    }
    const db = await createDataContext(ctx, {
      userId: auth.userId,
      project_path: args.project_path,
      ...(args.team && teamIdForScope ? { workspace: "team" as const, team_id: teamIdForScope } : {}),
    });

    let tasks: any[];
    if (args.project_id) {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else if (args.status && !args.team) {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_status", (q) =>
          q.eq("user_id", auth.userId).eq("status", args.status as any)
        )
        .collect();
    } else {
      tasks = await db.query("tasks").collect();
    }

    // Filter out done/dropped unless explicitly requested
    if (!args.status) {
      tasks = tasks.filter((t: any) => t.status !== "done" && t.status !== "dropped");
    }

    // By default, exclude unpromoted insight-sourced tasks (derived noise)
    if (!args.include_derived) {
      tasks = tasks.filter((t: any) => t.source !== "insight" || t.promoted === true);
    }

    if (args.execution_status) {
      tasks = tasks.filter((t: any) => t.execution_status === args.execution_status);
    }

    // Ready = open + no blockers
    if (args.ready) {
      const allShortIds = new Set(tasks.map((t: any) => t.short_id));
      tasks = tasks.filter((t: any) => {
        if (t.status !== "open") return false;
        if (!t.blocked_by || t.blocked_by.length === 0) return true;
        // Check if all blockers are done
        return t.blocked_by.every((bid: string) => {
          const blocker = tasks.find((bt: any) => bt.short_id === bid);
          return blocker && (blocker.status === "done" || blocker.status === "dropped");
        });
      });
    }

    const limit = args.limit || 300;
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
      task = await ctx.db.get(args.id as Id<"tasks">);
    }

    if (!task) return null;
    if (!(await canAccessTask(ctx, auth.userId, task))) return null;

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
    plan_id: v.optional(v.string()),
    blocked_by: v.optional(v.array(v.string())),
    blocks: v.optional(v.array(v.string())),
    last_session_summary: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
    // Structured execution fields
    steps: v.optional(v.array(v.object({
      title: v.string(),
      done: v.optional(v.boolean()),
      verification: v.optional(v.string()),
    }))),
    acceptance_criteria: v.optional(v.array(v.string())),
    execution_status: v.optional(v.string()),
    execution_concerns: v.optional(v.string()),
    verification_evidence: v.optional(v.string()),
    files_changed: v.optional(v.array(v.string())),
    estimated_minutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) throw new Error("Task not found");

    const now = Date.now();
    const updates: any = { updated_at: now };
    if (args.status) updates.status = args.status;
    if (args.priority) updates.priority = args.priority;
    if (args.title) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.assignee !== undefined) updates.assignee = args.assignee;
    if (args.labels) updates.labels = args.labels;
    if (args.project_id !== undefined) updates.project_id = args.project_id || undefined;
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (plan) {
        updates.plan_id = plan._id;
        const taskIds = plan.task_ids || [];
        if (!taskIds.some((id: any) => id === task._id)) {
          taskIds.push(task._id);
          await ctx.db.patch(plan._id, { task_ids: taskIds, updated_at: now });
        }
      }
    }
    if (args.blocked_by) updates.blocked_by = args.blocked_by;
    if (args.blocks) updates.blocks = args.blocks;
    if (args.last_session_summary) updates.last_session_summary = args.last_session_summary;
    if (args.steps) updates.steps = args.steps;
    if (args.acceptance_criteria) updates.acceptance_criteria = args.acceptance_criteria;
    if (args.execution_status) updates.execution_status = args.execution_status;
    if (args.execution_concerns !== undefined) updates.execution_concerns = args.execution_concerns;
    if (args.verification_evidence !== undefined) updates.verification_evidence = args.verification_evidence;
    if (args.files_changed) updates.files_changed = args.files_changed;
    if (args.estimated_minutes !== undefined) updates.estimated_minutes = args.estimated_minutes;

    if (args.status === "done" || args.status === "dropped") {
      updates.closed_at = now;
    }

    // Link conversation if provided
    let linkedConvId: Id<"conversations"> | undefined;
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv) {
        linkedConvId = conv._id;
        const existing = task.conversation_ids || [];
        if (!existing.some((id) => id === conv._id)) {
          updates.conversation_ids = [...existing, conv._id];
        }
        await ctx.db.patch(conv._id, { active_task_id: task._id });
        if (task.plan_id && !conv.active_plan_id) {
          await ctx.db.patch(conv._id, { active_plan_id: task.plan_id });
        }
      }
    }

    if (args.status === "in_progress") {
      updates.attempt_count = (task.attempt_count || 0) + 1;
      updates.last_attempted_at = now;
      if (!task.started_at) updates.started_at = now;
    }

    if (args.status === "done" && task.started_at) {
      updates.actual_minutes = Math.round((now - task.started_at) / 60000);
    }

    // Record history for changed fields
    const trackFields: [string, any, any][] = [];
    if (args.status && args.status !== task.status) trackFields.push(["status", task.status, args.status]);
    if (args.priority && args.priority !== task.priority) trackFields.push(["priority", task.priority, args.priority]);
    if (args.title && args.title !== task.title) trackFields.push(["title", task.title, args.title]);
    if (args.assignee !== undefined && args.assignee !== task.assignee) trackFields.push(["assignee", task.assignee || "", args.assignee || ""]);

    for (const [field, oldVal, newVal] of trackFields) {
      await ctx.db.insert("task_history", {
        task_id: task._id,
        user_id: auth.userId,
        actor_type: "user",
        action: "updated",
        field,
        old_value: String(oldVal),
        new_value: String(newVal),
        created_at: now,
      });
    }

    await ctx.db.patch(task._id, updates);

    if (args.status && args.status !== task.status && task.plan_id) {
      await recalcPlanProgress(ctx, task.plan_id, task._id, args.status);
    }

    return {
      success: true,
      plan_id: task.plan_id ? (await ctx.db.get(task.plan_id))?.short_id : undefined,
    };
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
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) throw new Error("Task not found");

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
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) throw new Error("Task not found");

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
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task) return null;

    if (task.user_id !== auth.userId) {
      const accessed = await db.get(task._id);
      if (!accessed) return null;
    }

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

    // Get related docs/plans from linked conversations
    const relatedDocs: { title: string; doc_type: string; content: string }[] = [];
    if (task.conversation_ids) {
      for (const convId of task.conversation_ids.slice(-3)) {
        const docs = await ctx.db
          .query("docs")
          .withIndex("by_user_id", (q) => q.eq("user_id", task.user_id))
          .collect();
        for (const d of docs) {
          if (d.conversation_id === convId && !d.archived_at) {
            relatedDocs.push({ title: d.title, doc_type: d.doc_type, content: d.content || "" });
          }
        }
      }
    }

    return {
      task,
      comments,
      sessionSummaries,
      project: project ? { title: project.title, description: project.description } : null,
      relatedDocs,
    };
  },
});

// --- Web-facing queries (use Convex auth, no api_token) ---

export const webList = query({
  args: {
    project_id: v.optional(v.string()),
    status: v.optional(v.string()),
    execution_status: v.optional(v.string()),
    ready: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    page: v.optional(v.number()),
    include_derived: v.optional(v.boolean()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    let tasks: any[];
    if (args.project_id) {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else if (args.workspace === "team" && args.team_id) {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id!))
        .collect();
      if (args.status) {
        tasks = tasks.filter((t) => t.status === args.status);
      }
    } else if (args.workspace === "personal") {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      tasks = tasks.filter((t: any) => !t.team_id);
      if (args.status) {
        tasks = tasks.filter((t) => t.status === args.status);
      }
    } else {
      const db = await createDataContext(ctx, { userId, workspace: args.workspace, team_id: args.team_id });
      tasks = await db.query("tasks").collect();
      if (args.status) {
        tasks = tasks.filter((t) => t.status === args.status);
      }
    }

    if (!args.status) {
      tasks = tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
    }

    // By default, exclude unpromoted insight-sourced tasks
    if (!args.include_derived) {
      tasks = tasks.filter((t) => t.source !== "insight" || t.promoted === true);
    }

    if (args.execution_status) {
      tasks = tasks.filter((t: any) => t.execution_status === args.execution_status);
    }

    if (args.ready) {
      tasks = tasks.filter((t) => {
        if (t.status !== "open") return false;
        if (!t.blocked_by || t.blocked_by.length === 0) return true;
        return t.blocked_by.every((bid: string) => {
          const blocker = tasks.find((bt: any) => bt.short_id === bid);
          return blocker && (blocker.status === "done" || blocker.status === "dropped");
        });
      });
    }

    const numItems = args.limit || 300;
    const offset = (args.page || 0) * numItems;
    const hasMore = offset + numItems < tasks.length;
    const result = tasks.slice(offset, offset + numItems);

    // Enrich with creator and assignee info
    const allUserIds = new Set<string>();
    for (const t of result) {
      allUserIds.add(t.user_id.toString());
      if (t.assignee) allUserIds.add(t.assignee.toString());
    }
    const userMap = new Map<string, { name: string; image?: string }>();
    for (const uid of allUserIds) {
      try {
        const u = await ctx.db.get(uid as Id<"users">);
        if (u) userMap.set(uid, { name: u.name || u.email || "Unknown", image: u.image || u.github_avatar_url });
      } catch {}
    }

    const planIds = new Set<string>();
    for (const t of result) {
      if (t.plan_id) planIds.add(t.plan_id.toString());
    }
    const planMap = new Map<string, { _id: any; short_id: string; title: string; status: string }>();
    for (const pid of planIds) {
      try {
        const p = await ctx.db.get(pid as Id<"plans">);
        if (p) planMap.set(pid, { _id: p._id, short_id: p.short_id, title: p.title, status: p.status });
      } catch {}
    }

    const now = Date.now();
    const HEARTBEAT_ALIVE_MS = 90 * 1000;
    const managedSessions = await ctx.db
      .query("managed_sessions")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const liveSessions = managedSessions.filter(
      (s) => now - s.last_heartbeat < HEARTBEAT_ALIVE_MS && s.conversation_id
    );
    const activeTaskMap = new Map<string, { session_id: string; title?: string; agent_status?: string; agent_type?: string }>();
    for (const s of liveSessions) {
      const conv = await ctx.db.get(s.conversation_id!);
      if (conv && conv.active_task_id) {
        activeTaskMap.set(conv.active_task_id.toString(), {
          session_id: conv.session_id,
          title: conv.title || undefined,
          agent_status: s.agent_status || undefined,
          agent_type: conv.agent_type || undefined,
        });
      }
    }

    const sourceConvIds = new Set<string>();
    for (const t of result) {
      if (t.created_from_conversation) {
        sourceConvIds.add(t.created_from_conversation.toString());
      }
    }
    const sourceAgentMap = new Map<string, string>();
    for (const cid of sourceConvIds) {
      try {
        const c = await ctx.db.get(cid as Id<"conversations">);
        if (c?.agent_type) sourceAgentMap.set(cid, c.agent_type);
      } catch {}
    }

    const items = result.map(t => ({
      ...t,
      creator: userMap.get(t.user_id.toString()) || null,
      assignee_info: t.assignee ? userMap.get(t.assignee.toString()) || null : null,
      plan: t.plan_id ? planMap.get(t.plan_id.toString()) || null : null,
      activeSession: activeTaskMap.get(t._id.toString()) || null,
      source_agent_type: t.created_from_conversation ? sourceAgentMap.get(t.created_from_conversation.toString()) || null : null,
    }));
    return { items, hasMore };
  },
});

export const webListByConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    return tasks
      .filter((t: any) => t.conversation_ids?.includes(args.conversationId))
      .map((t: any) => ({ _id: t._id.toString(), short_id: t.short_id, title: t.title, status: t.status }));
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
      task = await ctx.db.get(args.id as Id<"tasks">);
    }

    if (!task || !(await canAccessTask(ctx, userId, task))) return null;

    const comments = await ctx.db
      .query("task_comments")
      .withIndex("by_task_id", (q) => q.eq("task_id", task!._id))
      .collect();

    let plan = null;
    if (task.plan_id) {
      const p = await ctx.db.get(task.plan_id);
      if (p) plan = { _id: p._id, short_id: p.short_id, title: p.title, status: p.status };
    }

    return { ...task, comments, plan };
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
    execution_status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, userId, task))) throw new Error("Task not found");

    const now = Date.now();
    const updates: any = { updated_at: now };
    if (args.status) updates.status = args.status;
    if (args.priority) updates.priority = args.priority;
    if (args.title) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.assignee !== undefined) {
      updates.assignee = args.assignee === "me" ? userId : args.assignee;
    }
    if (args.labels) updates.labels = args.labels;
    if (args.project_id !== undefined) updates.project_id = args.project_id || undefined;
    if (args.execution_status !== undefined) updates.execution_status = args.execution_status || undefined;

    if (args.status === "done" || args.status === "dropped") {
      updates.closed_at = now;
    }
    if (args.status === "in_progress") {
      updates.attempt_count = (task.attempt_count || 0) + 1;
      updates.last_attempted_at = now;
    }

    const resolvedAssignee = updates.assignee || args.assignee;
    // Record history for changed fields
    const trackFields: [string, any, any][] = [];
    if (args.status && args.status !== task.status) trackFields.push(["status", task.status, args.status]);
    if (args.priority && args.priority !== task.priority) trackFields.push(["priority", task.priority, args.priority]);
    if (args.title && args.title !== task.title) trackFields.push(["title", task.title, args.title]);
    if (args.assignee !== undefined && resolvedAssignee !== task.assignee) trackFields.push(["assignee", task.assignee || "", resolvedAssignee || ""]);
    if (args.execution_status !== undefined && args.execution_status !== (task.execution_status || "")) trackFields.push(["execution_status", task.execution_status || "", args.execution_status || ""]);

    for (const [field, oldVal, newVal] of trackFields) {
      await ctx.db.insert("task_history", {
        task_id: task._id,
        user_id: userId,
        actor_type: "user",
        action: "updated",
        field,
        old_value: String(oldVal),
        new_value: String(newVal),
        created_at: now,
      });
    }

    await ctx.db.patch(task._id, updates);

    if (args.status && args.status !== task.status && task.plan_id) {
      await recalcPlanProgress(ctx, task.plan_id, task._id, args.status);
    }

    return { success: true };
  },
});

export const webAddComment = mutation({
  args: {
    short_id: v.string(),
    text: v.string(),
    comment_type: v.optional(v.string()),
    image_storage_ids: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, userId, task))) throw new Error("Task not found");

    const user = await ctx.db.get(userId);

    await ctx.db.insert("task_comments", {
      task_id: task._id,
      author: user?.name || "unknown",
      text: args.text,
      comment_type: (args.comment_type || "note") as any,
      image_storage_ids: args.image_storage_ids,
      created_at: Date.now(),
    });

    return { success: true };
  },
});

export const assignToAgent = mutation({
  args: {
    short_id: v.string(),
    agent_type: v.union(v.literal("claude_code"), v.literal("codex"), v.literal("cursor"), v.literal("gemini")),
  },
  handler: async (ctx, { short_id, agent_type }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
      .first();
    if (!task) throw new Error("Task not found");
    if (task.user_id.toString() !== userId.toString()) throw new Error("Unauthorized");

    const now = Date.now();
    const sessionId = crypto.randomUUID();

    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      agent_type,
      session_id: sessionId,
      started_at: now,
      updated_at: now,
      message_count: 0,
      status: "active",
      is_private: false,
      active_task_id: task._id,
      title: task.title.slice(0, 80),
    } as any);
    await ctx.db.patch(conversationId, { short_id: conversationId.toString().slice(0, 7) } as any);

    // Update task assignee
    await ctx.db.patch(task._id, { assignee: "agent", updated_at: now } as any);

    // Build minimal task prompt
    const lines = [`You have been assigned the following task:\n\n**${task.title}**`];
    if ((task as any).description) lines.push(`\n${(task as any).description}`);
    if ((task as any).acceptance_criteria?.length) {
      lines.push("\n**Acceptance criteria:**");
      (task as any).acceptance_criteria.forEach((c: string) => lines.push(`- ${c}`));
    }
    lines.push(`\nTask ID: ${task.short_id} · Priority: ${(task as any).priority || "medium"}`);

    await ctx.db.insert("pending_messages", {
      conversation_id: conversationId,
      from_user_id: userId,
      content: lines.join("\n"),
      status: "pending",
      created_at: now,
      retry_count: 0,
    } as any);
    await ctx.db.patch(conversationId, { has_pending_messages: true } as any);

    const daemonAgentType = agent_type === "claude_code" ? "claude" : agent_type === "codex" ? "codex" : agent_type === "cursor" ? "cursor" : "gemini";
    await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "start_session",
      args: JSON.stringify({ agent_type: daemonAgentType, conversation_id: conversationId }),
      created_at: now,
    } as any);

    return { conversationId, sessionId };
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
    plan_id: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    assignee: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId, workspace: args.workspace, team_id: args.team_id });
    const short_id = await nextShortId(ctx.db, "ct");

    let project_id: Id<"projects"> | undefined;
    if (args.project_id) {
      const project = await ctx.db
        .query("projects")
        .filter((q) => q.eq(q.field("_id"), args.project_id as any))
        .first();
      if (project) project_id = project._id;
    }

    let plan_id: Id<"plans"> | undefined;
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (plan) plan_id = plan._id;
    }

    const resolvedAssignee = args.assignee === "me" ? userId.toString() : args.assignee;

    const now = Date.now();
    const id = await db.insert("tasks", {
      project_id,
      plan_id,
      short_id,
      title: args.title,
      description: args.description,
      task_type: (args.task_type || "task") as any,
      status: (args.status || "open") as any,
      priority: (args.priority || "medium") as any,
      labels: args.labels,
      assignee: resolvedAssignee,
      source: "human",
      attempt_count: 0,
      retry_count: 0,
      max_retries: 3,
    } as any);

    if (plan_id) {
      const plan = await ctx.db.get(plan_id);
      if (plan) {
        const taskIds = plan.task_ids || [];
        await ctx.db.patch(plan_id, { task_ids: [...taskIds, id], updated_at: now });
      }
    }

    await ctx.db.insert("task_history", {
      task_id: id,
      user_id: userId,
      actor_type: "user",
      action: "created",
      created_at: now,
    });

    return { id, short_id };
  },
});

// Team-scoped list for web
export const webTeamList = query({
  args: {
    status: v.optional(v.string()),
    execution_status: v.optional(v.string()),
    promoted_only: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    let teamId = args.team_id;
    if (!teamId) {
      const user = await ctx.db.get(userId);
      teamId = user?.active_team_id || user?.team_id;
    }
    if (!teamId) return [];
    const db = await createDataContext(ctx, { userId, workspace: "team", team_id: teamId });

    let tasks = await db.query("tasks").collect();

    if (args.status) {
      tasks = tasks.filter((t: any) => t.status === args.status);
    } else {
      tasks = tasks.filter((t: any) => t.status !== "done" && t.status !== "dropped");
    }

    if (args.execution_status) {
      tasks = tasks.filter((t: any) => (t as any).execution_status === args.execution_status);
    }

    if (args.promoted_only) {
      tasks = tasks.filter((t: any) => t.source !== "insight" || t.promoted === true);
    }

    return tasks.slice(0, args.limit || 300);
  },
});

// Promote a derived task (web auth)
export const webPromote = mutation({
  args: {
    short_id: v.string(),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId, workspace: args.workspace, team_id: args.team_id });

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task) throw new Error("Task not found");

    if (task.user_id !== userId) {
      const accessed = await db.get(task._id);
      if (!accessed) throw new Error("Task not found");
    }

    await ctx.db.patch(task._id, { promoted: true, updated_at: Date.now() });
    return { success: true };
  },
});

export const incrementRetryCount = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) throw new Error("Task not found");

    const now = Date.now();
    const newRetryCount = ((task as any).retry_count || 0) + 1;
    const maxRetries = (task as any).max_retries ?? 3;

    const updates: any = {
      retry_count: newRetryCount,
      last_attempted_at: now,
      updated_at: now,
    };

    if (newRetryCount >= maxRetries) {
      updates.execution_status = "blocked";

      const user = await ctx.db.get(auth.userId);
      await ctx.db.insert("task_comments", {
        task_id: task._id,
        author: user?.name || "system",
        text: `Retry count (${newRetryCount}) exceeded max retries (${maxRetries}). Task automatically blocked.`,
        comment_type: "blocker" as any,
        created_at: now,
      });
    }

    await ctx.db.patch(task._id, updates);

    return { retry_count: newRetryCount, blocked: newRetryCount >= maxRetries };
  },
});

export const updateExecutionStatus = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    execution_status: v.union(
      v.literal("done"),
      v.literal("done_with_concerns"),
      v.literal("blocked"),
      v.literal("needs_context"),
    ),
    execution_comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) throw new Error("Task not found");

    const now = Date.now();
    await ctx.db.patch(task._id, { execution_status: args.execution_status, updated_at: now });

    if (args.execution_comment) {
      const user = await ctx.db.get(auth.userId);
      await ctx.db.insert("task_comments", {
        task_id: task._id,
        author: user?.name || "unknown",
        text: args.execution_comment,
        comment_type: "progress" as any,
        created_at: now,
      });
    }

    await ctx.db.insert("task_history", {
      task_id: task._id,
      user_id: auth.userId,
      actor_type: "user",
      action: "updated",
      field: "execution_status",
      old_value: task.execution_status || "",
      new_value: args.execution_status,
      created_at: now,
    });

    return { success: true };
  },
});

// Backfill: set team_id on tasks/docs missing it, and promoted on human/agent tasks
export const backfillTeamScope = mutation({
  args: {
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const allUsers = await ctx.db.query("users").collect();
    const userTeamMap = new Map<string, any>();
    for (const u of allUsers) {
      userTeamMap.set(u._id.toString(), u.active_team_id || (u as any).team_id);
    }

    let tasksFixed = 0;
    let tasksPromoted = 0;
    let docsFixed = 0;

    const allTasks = await ctx.db.query("tasks").collect();
    for (const t of allTasks) {
      const patches: Record<string, any> = {};

      if (!t.team_id) {
        const tid = userTeamMap.get(t.user_id.toString());
        if (tid) patches.team_id = tid;
      }

      if (t.promoted === undefined && (t.source === "human" || t.source === "agent")) {
        patches.promoted = true;
      }

      if (Object.keys(patches).length > 0) {
        await ctx.db.patch(t._id, patches);
        if (patches.team_id) tasksFixed++;
        if (patches.promoted) tasksPromoted++;
      }
    }

    const allDocs = await ctx.db.query("docs").collect();
    for (const d of allDocs) {
      if (!d.team_id) {
        const tid = userTeamMap.get(d.user_id.toString());
        if (tid) {
          await ctx.db.patch(d._id, { team_id: tid });
          docsFixed++;
        }
      }
    }

    return { tasksFixed, tasksPromoted, docsFixed, totalTasks: allTasks.length, totalDocs: allDocs.length };
  },
});

export const batchUpdateStatus = mutation({
  args: {
    api_token: v.string(),
    short_ids: v.array(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const now = Date.now();
    const results: { short_id: string; success: boolean }[] = [];
    const affectedPlans = new Set<string>();

    for (const short_id of args.short_ids) {
      const task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
        .first();
      if (!task || task.user_id !== auth.userId) {
        results.push({ short_id, success: false });
        continue;
      }

      const updates: any = { status: args.status, updated_at: now };
      if (args.status === "done" || args.status === "dropped") {
        updates.closed_at = now;
      }
      if (args.status === "in_progress") {
        updates.attempt_count = (task.attempt_count || 0) + 1;
        updates.last_attempted_at = now;
        if (!task.started_at) updates.started_at = now;
      }
      if (args.status === "done" && task.started_at) {
        updates.actual_minutes = Math.round((now - task.started_at) / 60000);
      }

      if (args.status !== task.status) {
        await ctx.db.insert("task_history", {
          task_id: task._id,
          user_id: auth.userId,
          actor_type: "user",
          action: "updated",
          field: "status",
          old_value: String(task.status),
          new_value: args.status,
          created_at: now,
        });
      }

      await ctx.db.patch(task._id, updates);

      if (task.plan_id && args.status !== task.status) {
        affectedPlans.add(`${task.plan_id}:${task._id}:${args.status}`);
      }

      results.push({ short_id, success: true });
    }

    for (const key of affectedPlans) {
      const [planId, taskId, status] = key.split(":");
      await recalcPlanProgress(ctx, planId as Id<"plans">, taskId as Id<"tasks">, status);
    }

    return { results, updated: results.filter((r) => r.success).length };
  },
});

export const batchAssign = mutation({
  args: {
    api_token: v.string(),
    short_ids: v.array(v.string()),
    assignee: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const now = Date.now();
    const results: { short_id: string; success: boolean }[] = [];

    for (const short_id of args.short_ids) {
      const task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
        .first();
      if (!task || task.user_id !== auth.userId) {
        results.push({ short_id, success: false });
        continue;
      }

      if (args.assignee !== task.assignee) {
        await ctx.db.insert("task_history", {
          task_id: task._id,
          user_id: auth.userId,
          actor_type: "user",
          action: "updated",
          field: "assignee",
          old_value: task.assignee || "",
          new_value: args.assignee,
          created_at: now,
        });
      }

      await ctx.db.patch(task._id, { assignee: args.assignee, updated_at: now });
      results.push({ short_id, success: true });
    }

    return { results, updated: results.filter((r) => r.success).length };
  },
});

export const scheduleRetry = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) throw new Error("Task not found");

    const now = Date.now();
    const newAttemptCount = (task.attempt_count || 0) + 1;

    await ctx.db.patch(task._id, {
      status: "open" as any,
      execution_status: undefined,
      attempt_count: newAttemptCount,
      updated_at: now,
    });

    const user = await ctx.db.get(auth.userId);
    await ctx.db.insert("task_comments", {
      task_id: task._id,
      author: user?.name || "system",
      text: `Scheduled for retry (attempt ${newAttemptCount})`,
      comment_type: "progress" as any,
      created_at: now,
    });

    if (task.plan_id && task.status !== "open") {
      await recalcPlanProgress(ctx, task.plan_id, task._id, "open");
    }

    return { success: true, attempt_count: newAttemptCount };
  },
});

export const heartbeat = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    progress_pct: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q: any) => q.eq("short_id", args.short_id))
      .first();
    if (!task) throw new Error("Task not found");

    const updates: any = { last_heartbeat: Date.now() };
    if (args.progress_pct !== undefined) updates.progress_pct = args.progress_pct;

    await ctx.db.patch(task._id, updates);
    return { success: true };
  },
});

// --- Dependency graph helpers ---

type TaskNode = { short_id: string; blocked_by?: string[]; status?: string };

function getTopologicalOrder(tasks: TaskNode[]): { sorted: string[]; cycles: string[][] } {
  const taskMap = new Map<string, TaskNode>();
  for (const t of tasks) taskMap.set(t.short_id, t);

  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const t of tasks) {
    inDegree.set(t.short_id, 0);
    adjacency.set(t.short_id, []);
  }

  for (const t of tasks) {
    if (t.blocked_by) {
      for (const dep of t.blocked_by) {
        if (taskMap.has(dep)) {
          adjacency.get(dep)!.push(t.short_id);
          inDegree.set(t.short_id, (inDegree.get(t.short_id) || 0) + 1);
        }
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adjacency.get(node) || []) {
      const newDeg = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  const cycles: string[][] = [];
  if (sorted.length < tasks.length) {
    const remaining = new Set(tasks.map(t => t.short_id).filter(id => !sorted.includes(id)));
    const visited = new Set<string>();
    for (const start of remaining) {
      if (visited.has(start)) continue;
      const cycle: string[] = [];
      let current: string | undefined = start;
      while (current && !visited.has(current)) {
        visited.add(current);
        cycle.push(current);
        const node = taskMap.get(current);
        current = node?.blocked_by?.find(dep => remaining.has(dep) && !visited.has(dep));
      }
      if (cycle.length > 0) cycles.push(cycle);
    }
  }

  return { sorted, cycles };
}

function getCriticalPath(tasks: TaskNode[]): string[] {
  const taskMap = new Map<string, TaskNode>();
  for (const t of tasks) taskMap.set(t.short_id, t);

  const { sorted, cycles } = getTopologicalOrder(tasks);
  if (cycles.length > 0) return [];

  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const id of sorted) {
    dist.set(id, 0);
    prev.set(id, null);
  }

  for (const id of sorted) {
    const node = taskMap.get(id);
    if (node?.blocked_by) {
      for (const dep of node.blocked_by) {
        if (taskMap.has(dep)) {
          const newDist = (dist.get(dep) || 0) + 1;
          if (newDist > (dist.get(id) || 0)) {
            dist.set(id, newDist);
            prev.set(id, dep);
          }
        }
      }
    }
  }

  let maxId = sorted[0];
  let maxDist = 0;
  for (const [id, d] of dist) {
    if (d > maxDist) {
      maxDist = d;
      maxId = id;
    }
  }

  const path: string[] = [];
  let cur: string | null | undefined = maxId;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur);
  }

  return path;
}

export const getReadyTasks = query({
  args: {
    api_token: v.string(),
    plan_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });

    let tasks: any[];
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (!plan || !plan.task_ids) return [];
      const planTasks: any[] = [];
      for (const tid of plan.task_ids) {
        const t = await ctx.db.get(tid);
        if (t) planTasks.push(t);
      }
      tasks = planTasks;
    } else {
      tasks = await db.query("tasks").collect();
    }

    const allTasks = tasks;
    const statusMap = new Map<string, string>();
    for (const t of allTasks) statusMap.set(t.short_id, t.status);

    return allTasks.filter((t: any) => {
      if (t.status !== "open") return false;
      if (t.source === "insight" && !t.promoted) return false;
      if (!t.blocked_by || t.blocked_by.length === 0) return true;
      return t.blocked_by.every((bid: string) => {
        const status = statusMap.get(bid);
        return status === "done" || status === "dropped";
      });
    });
  },
});

export const getDependencyChain = query({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });

    const root = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!root) throw new Error("Task not found");

    const allTasks = await db.query("tasks").collect();
    const taskByShortId = new Map<string, any>();
    for (const t of allTasks) taskByShortId.set(t.short_id, t);

    const ancestors = new Set<string>();
    const descendants = new Set<string>();

    function collectAncestors(shortId: string) {
      const task = taskByShortId.get(shortId);
      if (!task?.blocked_by) return;
      for (const dep of task.blocked_by) {
        if (!ancestors.has(dep) && taskByShortId.has(dep)) {
          ancestors.add(dep);
          collectAncestors(dep);
        }
      }
    }

    function collectDescendants(shortId: string) {
      const task = taskByShortId.get(shortId);
      if (!task?.blocks) return;
      for (const dep of task.blocks) {
        if (!descendants.has(dep) && taskByShortId.has(dep)) {
          descendants.add(dep);
          collectDescendants(dep);
        }
      }
      for (const t of allTasks) {
        if (t.blocked_by?.includes(shortId) && !descendants.has(t.short_id)) {
          descendants.add(t.short_id);
          collectDescendants(t.short_id);
        }
      }
    }

    collectAncestors(args.short_id);
    collectDescendants(args.short_id);

    const chainIds = new Set([...ancestors, args.short_id, ...descendants]);
    const chainTasks = allTasks.filter((t: any) => chainIds.has(t.short_id));

    const { sorted, cycles } = getTopologicalOrder(chainTasks);
    const criticalPath = getCriticalPath(chainTasks);

    return {
      task: root,
      ancestors: allTasks.filter((t: any) => ancestors.has(t.short_id)),
      descendants: allTasks.filter((t: any) => descendants.has(t.short_id)),
      topological_order: sorted,
      critical_path: criticalPath,
      cycles,
    };
  },
});
