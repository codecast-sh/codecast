import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext, scopeByProject, scopedFetch } from "./data";
import { nextShortId } from "./counters";

async function recalcProgress(ctx: any, taskIds: Id<"tasks">[]) {
  let total = 0, done = 0, in_progress = 0, open = 0;
  let exec_done = 0, exec_done_with_concerns = 0, exec_blocked = 0, exec_needs_context = 0;

  for (const tid of taskIds) {
    const task = await ctx.db.get(tid);
    if (!task || task.status === "dropped") continue;
    total++;
    if (task.status === "done") done++;
    else if (task.status === "in_progress" || task.status === "in_review") in_progress++;
    else if (task.status === "open" || task.status === "backlog") open++;

    const es = (task as any).execution_status;
    if (es === "done") exec_done++;
    else if (es === "done_with_concerns") exec_done_with_concerns++;
    else if (es === "blocked") exec_blocked++;
    else if (es === "needs_context") exec_needs_context++;
  }

  return {
    total, done, in_progress, open,
    execution_status: {
      done: exec_done,
      done_with_concerns: exec_done_with_concerns,
      blocked: exec_blocked,
      needs_context: exec_needs_context,
    },
  };
}


async function canAccessPlan(ctx: any, userId: Id<"users">, plan: any): Promise<boolean> {
  if (plan.user_id === userId) return true;
  if (!plan.team_id) return false;
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", plan.team_id))
    .first();
  return !!membership;
}

// Merge legacy per-type arrays with new unified entries into a single sorted timeline.
// Deduplicates by timestamp+content to avoid showing entries written to both old and new.
function mergePlanEntries(plan: any): Array<{
  type: string; timestamp: number; content: string;
  session_id?: string; author?: string; rationale?: string; path_or_url?: string;
}> {
  const seen = new Set<string>();
  const all: any[] = [];

  const add = (e: any) => {
    const key = `${e.timestamp}:${e.content}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push(e);
  };

  // New unified entries (preferred)
  for (const e of (plan.entries || [])) add(e);

  // Legacy arrays
  for (const e of (plan.progress_log || [])) {
    add({ type: "progress", timestamp: e.timestamp, content: e.entry, session_id: e.session_id });
  }
  for (const e of (plan.decision_log || [])) {
    add({ type: "decision", timestamp: e.timestamp, content: e.decision, rationale: e.rationale, session_id: e.session_id });
  }
  for (const e of (plan.discoveries || [])) {
    add({ type: "discovery", timestamp: e.timestamp, content: e.finding, session_id: e.session_id });
  }
  for (const e of (plan.context_pointers || [])) {
    add({ type: "reference", timestamp: 0, content: e.label, path_or_url: e.path_or_url });
  }

  all.sort((a, b) => a.timestamp - b.timestamp);
  return all;
}

// --- API token mutations ---

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    source: v.optional(v.string()),
    project_id: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
    model_stylesheet: v.optional(v.string()),
    fidelity: v.optional(v.string()),
    join_policy: v.optional(v.string()),
    join_k: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });
    const short_id = await nextShortId(ctx.db, "pl");

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

    const id = await db.insert("plans", {
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
      entries: [],
      session_ids: [],
      created_from_conversation_id,
      model_stylesheet: args.model_stylesheet,
      fidelity: args.fidelity as any,
      join_policy: args.join_policy as any,
      join_k: args.join_k,
    });

    const docId = await db.insert("docs", {
      title: args.title,
      content: args.body || "",
      doc_type: "plan",
      source: "human",
      plan_id: id,
      project_id,
    });
    await ctx.db.patch(id, { doc_id: docId });

    if (created_from_conversation_id) {
      const conv = await ctx.db.get(created_from_conversation_id);
      if (conv) {
        await ctx.db.patch(created_from_conversation_id, {
          active_plan_id: id,
          plan_ids: [...((conv as any).plan_ids || []), id],
        });
      }
      await ctx.db.patch(id, {
        session_ids: [created_from_conversation_id],
        current_session_id: created_from_conversation_id,
      });
    }

    return { id, short_id, doc_id: docId };
  },
});

export const createFromTemplate = mutation({
  args: {
    api_token: v.string(),
    template_id: v.id("plan_templates"),
    title: v.optional(v.string()),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const template = await ctx.db.get(args.template_id);
    if (!template) throw new Error("Template not found");

    const now = Date.now();
    const short_id = await nextShortId(ctx.db, "pl");
    const title = args.title || template.name;

    const planId = await ctx.db.insert("plans", {
      user_id: auth.userId,
      team_id: template.team_id,
      short_id,
      title,
      goal: template.goal_template,
      status: "active",
      progress: { total: template.task_templates.length, done: 0, in_progress: 0, open: template.task_templates.length },
      task_ids: [],
      progress_log: [],
      entries: [{ type: "progress", timestamp: now, content: `Created from template: ${template.name}` }],
      created_at: now,
      updated_at: now,
    } as any);

    const taskIds: Id<"tasks">[] = [];
    const taskShortIds: string[] = [];

    for (let i = 0; i < template.task_templates.length; i++) {
      const tt = template.task_templates[i];
      const taskShortId = await nextShortId(ctx.db, "ct");
      taskShortIds.push(taskShortId);

      const blockedBy: string[] = [];
      if (tt.blocked_by_indices) {
        for (const idx of tt.blocked_by_indices) {
          if (idx < taskShortIds.length) blockedBy.push(taskShortIds[idx]);
        }
      }

      const taskId = await ctx.db.insert("tasks", {
        user_id: auth.userId,
        team_id: template.team_id,
        plan_id: planId,
        short_id: taskShortId,
        title: tt.title,
        description: tt.description,
        task_type: tt.task_type || "task",
        priority: tt.priority || "medium",
        status: "open",
        blocked_by: blockedBy,
        estimated_minutes: tt.estimated_minutes,
        source: "template",
        created_at: now,
        updated_at: now,
      } as any);
      taskIds.push(taskId);
    }

    await ctx.db.patch(planId, { task_ids: taskIds });
    return { id: planId, short_id, task_count: taskIds.length };
  },
});

export const fork = mutation({
  args: {
    api_token: v.string(),
    source_short_id: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const source = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.source_short_id))
      .first();
    if (!source) throw new Error("Source plan not found");

    const now = Date.now();
    const short_id = await nextShortId(ctx.db, "pl");

    const sourceTasks: any[] = [];
    for (const tid of source.task_ids || []) {
      const t = await ctx.db.get(tid);
      if (t) sourceTasks.push(t);
    }

    const planId = await ctx.db.insert("plans", {
      user_id: auth.userId,
      team_id: source.team_id,
      short_id,
      title: args.title || `${source.title} (fork)`,
      goal: source.goal,
      status: "active",
      acceptance_criteria: source.acceptance_criteria,
      progress: { total: sourceTasks.length, done: 0, in_progress: 0, open: sourceTasks.length },
      task_ids: [],
      progress_log: [],
      entries: [{ type: "progress", timestamp: now, content: `Forked from ${args.source_short_id}` }],
      created_at: now,
      updated_at: now,
    } as any);

    const oldToNew = new Map<string, string>();
    const taskIds: Id<"tasks">[] = [];

    for (const st of sourceTasks) {
      const newShortId = await nextShortId(ctx.db, "ct");
      oldToNew.set(st.short_id, newShortId);
    }

    for (const st of sourceTasks) {
      const newShortId = oldToNew.get(st.short_id)!;
      const blockedBy = (st.blocked_by || []).map((bid: string) => oldToNew.get(bid) || bid);

      const tid = await ctx.db.insert("tasks", {
        user_id: auth.userId,
        team_id: source.team_id,
        plan_id: planId,
        short_id: newShortId,
        title: st.title,
        description: st.description,
        task_type: st.task_type || "task",
        priority: st.priority || "medium",
        status: "open",
        blocked_by: blockedBy,
        estimated_minutes: st.estimated_minutes,
        source: "fork",
        created_at: now,
        updated_at: now,
      } as any);
      taskIds.push(tid);
    }

    await ctx.db.patch(planId, { task_ids: taskIds });
    return { id: planId, short_id, task_count: taskIds.length };
  },
});

export const update = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    task_ids: v.optional(v.array(v.string())),
    context_pointers: v.optional(v.array(v.object({
      label: v.string(),
      path_or_url: v.string(),
    }))),
    doc_id: v.optional(v.string()),
    model_stylesheet: v.optional(v.string()),
    workflow_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    if (!(await canAccessPlan(ctx, auth.userId, plan))) throw new Error("Plan not found");

    const now = Date.now();
    const updates: any = { updated_at: now };
    if (args.title) updates.title = args.title;
    if (args.goal !== undefined) updates.goal = args.goal;
    if (args.acceptance_criteria) updates.acceptance_criteria = args.acceptance_criteria;
    if (args.status) updates.status = args.status;
    if (args.context_pointers) updates.context_pointers = args.context_pointers;
    if (args.doc_id) updates.doc_id = args.doc_id as Id<"docs">;
    if (args.model_stylesheet !== undefined) updates.model_stylesheet = args.model_stylesheet;
    if (args.workflow_id) updates.workflow_id = args.workflow_id as Id<"workflows">;

    if (args.task_ids) {
      const taskDocIds = args.task_ids.map(id => id as Id<"tasks">);
      updates.task_ids = taskDocIds;
      updates.progress = await recalcProgress(ctx, taskDocIds);
    }

    if (args.body !== undefined) {
      if (plan.doc_id) {
        await ctx.db.patch(plan.doc_id, { content: args.body, updated_at: now });
        if (args.title) {
          await ctx.db.patch(plan.doc_id, { title: args.title });
        }
      } else {
        const db = await createDataContext(ctx, { userId: auth.userId });
        const docId = await db.insert("docs", {
          title: args.title || plan.title,
          content: args.body,
          doc_type: "plan",
          source: "human",
          plan_id: plan._id,
          project_id: plan.project_id,
        });
        updates.doc_id = docId;
      }
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

    if (!(await canAccessPlan(ctx, auth.userId, plan))) throw new Error("Plan not found");

    const validStatuses = ["draft", "active", "paused", "done", "abandoned"];
    if (!validStatuses.includes(args.status)) throw new Error(`Invalid status: ${args.status}`);

    await ctx.db.patch(plan._id, { status: args.status as any, updated_at: Date.now() });
    return { success: true };
  },
});

// Unified comment mutation — replaces addLogEntry, addDecision, addDiscovery, addPointer
export const addComment = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    content: v.string(),
    type: v.optional(v.string()),
    rationale: v.optional(v.string()),
    path_or_url: v.optional(v.string()),
    session_id: v.optional(v.string()),
    author: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const entries = (plan as any).entries || [];
    const entry: Record<string, any> = {
      type: args.type || "progress",
      timestamp: Date.now(),
      content: args.content,
    };
    if (args.session_id) entry.session_id = args.session_id;
    if (args.author) entry.author = args.author;
    if (args.rationale) entry.rationale = args.rationale;
    if (args.path_or_url) entry.path_or_url = args.path_or_url;

    entries.push(entry);
    await ctx.db.patch(plan._id, { entries, updated_at: Date.now() } as any);
    return { success: true };
  },
});

// Legacy mutations — kept for direct callers (addEscalation, updateDriveState, etc.)
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

    const entries = (plan as any).entries || [];
    entries.push({ type: "progress", timestamp: Date.now(), content: args.entry, session_id: args.session_id });
    await ctx.db.patch(plan._id, { entries, updated_at: Date.now() } as any);
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

    const planIds = (conv as any).plan_ids || [];
    if (!planIds.some((pid: any) => pid === plan._id)) {
      planIds.push(plan._id);
    }
    const patchFields: Record<string, any> = { plan_ids: planIds };
    if (!conv.active_plan_id || conv.active_plan_id === plan._id) {
      patchFields.active_plan_id = plan._id;
    }
    await ctx.db.patch(conv._id, patchFields);

    return { success: true };
  },
});

export const associatePlan = mutation({
  args: {
    api_token: v.string(),
    plan_id: v.string(),
    conversation_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id))
      .first();
    if (!conv) throw new Error("Conversation not found");

    const planIds = (conv as any).plan_ids || [];
    if (!planIds.some((pid: any) => pid.toString() === plan._id.toString())) {
      planIds.push(plan._id);
      await ctx.db.patch(conv._id, { plan_ids: planIds });
    }

    const sessionIds = plan.session_ids || [];
    if (!sessionIds.some((sid: any) => sid.toString() === conv._id.toString())) {
      sessionIds.push(conv._id);
      await ctx.db.patch(plan._id, { session_ids: sessionIds, updated_at: Date.now() });
    }

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

export const recalcPlanProgress = mutation({
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

    if (!(await canAccessPlan(ctx, auth.userId, plan))) throw new Error("Plan not found");

    const progress = await recalcProgress(ctx, plan.task_ids || []);
    await ctx.db.patch(plan._id, { progress, updated_at: Date.now() });
    return progress;
  },
});

export const addEscalation = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    task_short_id: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");

    if (!(await canAccessPlan(ctx, auth.userId, plan))) throw new Error("Plan not found");

    const escalation = {
      timestamp: Date.now(),
      task_short_id: args.task_short_id,
      reason: args.reason,
    };

    const escalationLog = ((plan as any).escalation_log || []) as any[];
    escalationLog.push(escalation);

    const entries = (plan as any).entries || [];
    const logEntry = args.task_short_id
      ? `[ESCALATION] ${args.task_short_id}: ${args.reason}`
      : `[ESCALATION] ${args.reason}`;
    entries.push({ type: "blocker", timestamp: Date.now(), content: logEntry });

    await ctx.db.patch(plan._id, {
      escalation_log: escalationLog,
      entries,
      updated_at: Date.now(),
    } as any);

    return { success: true };
  },
});

export const updateDriveState = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    current_round: v.number(),
    total_rounds: v.number(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");
    if (!(await canAccessPlan(ctx, auth.userId, plan))) throw new Error("Plan not found");

    const existing = (plan as any).drive_state || { current_round: 0, total_rounds: 0, rounds: [] };
    const drive_state = {
      ...existing,
      current_round: args.current_round,
      total_rounds: args.total_rounds,
    };

    const entries = (plan as any).entries || [];
    entries.push({ type: "progress", timestamp: Date.now(), content: `Starting drive round ${args.current_round}/${args.total_rounds}` });

    await ctx.db.patch(plan._id, {
      drive_state,
      entries,
      updated_at: Date.now(),
    } as any);

    return { success: true };
  },
});

export const recordDriveFindings = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    round: v.number(),
    findings: v.array(v.string()),
    fixed: v.array(v.string()),
    deferred: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");
    if (!(await canAccessPlan(ctx, auth.userId, plan))) throw new Error("Plan not found");

    const drive_state = (plan as any).drive_state || { current_round: 0, total_rounds: 0, rounds: [] };
    const existingIdx = drive_state.rounds.findIndex((r: any) => r.round === args.round);
    const roundData = {
      round: args.round,
      findings: args.findings,
      fixed: args.fixed,
      deferred: args.deferred || [],
    };

    if (existingIdx >= 0) {
      drive_state.rounds[existingIdx] = roundData;
    } else {
      drive_state.rounds.push(roundData);
    }

    const entries = (plan as any).entries || [];
    entries.push({
      type: "progress",
      timestamp: Date.now(),
      content: `Drive round ${args.round}: ${args.findings.length} findings, ${args.fixed.length} fixed${args.deferred?.length ? `, ${args.deferred.length} deferred` : ""}`,
    });

    await ctx.db.patch(plan._id, {
      drive_state,
      entries,
      updated_at: Date.now(),
    } as any);

    return { success: true, round: roundData };
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

    if (!(await canAccessPlan(ctx, auth.userId, plan))) return null;

    const tasks = [];
    if (plan.task_ids) {
      for (const tid of plan.task_ids) {
        const task = await ctx.db.get(tid);
        if (task) tasks.push(task);
      }
    }

    let doc_content: string | undefined;
    if (plan.doc_id) {
      const doc = await ctx.db.get(plan.doc_id);
      if (doc) doc_content = doc.content;
    }

    // Merge legacy arrays + new entries into unified comments timeline
    const comments = mergePlanEntries(plan);

    return { ...plan, tasks, doc_content, comments };
  },
});

export const getOrchestrationStatus = query({
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
    if (!plan) throw new Error("Plan not found");

    if (!(await canAccessPlan(ctx, auth.userId, plan))) throw new Error("Plan not found");

    const taskIds = plan.task_ids || [];
    const tasks: any[] = [];
    for (const tid of taskIds) {
      const task = await ctx.db.get(tid);
      if (task) tasks.push(task);
    }

    const now = Date.now();
    const HEARTBEAT_ALIVE_MS = 90 * 1000;

    const managedSessions = await ctx.db
      .query("managed_sessions")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", auth.userId))
      .collect();

    const liveSessions = managedSessions.filter(
      (s: any) => now - s.last_heartbeat < HEARTBEAT_ALIVE_MS && s.conversation_id
    );

    const activeConvIds = new Set<string>();
    for (const s of liveSessions) {
      if (s.conversation_id) activeConvIds.add(s.conversation_id.toString());
    }

    let activeAgentCount = 0;
    const taskDocIds = new Set(taskIds.map(id => id.toString()));
    for (const convId of activeConvIds) {
      const conv = await ctx.db.get(convId as any);
      if (conv && (conv as any).active_task_id && taskDocIds.has((conv as any).active_task_id.toString())) {
        activeAgentCount++;
      }
    }

    const waveMap = new Map<number, { done: number; total: number }>();
    let blockedCount = 0;
    let needsContextCount = 0;
    let currentWave = 0;

    for (const task of tasks) {
      if (task.status === "dropped") continue;
      const waveNumber = (task as any).wave_number as number | undefined;
      if (waveNumber !== undefined && waveNumber !== null) {
        const wave = waveMap.get(waveNumber) || { done: 0, total: 0 };
        wave.total++;
        if (task.status === "done") wave.done++;
        waveMap.set(waveNumber, wave);
      }

      const es = (task as any).execution_status;
      if (es === "blocked") blockedCount++;
      else if (es === "needs_context") needsContextCount++;

      if (task.status === "in_progress" || task.status === "in_review") {
        const wn = (task as any).wave_number as number | undefined;
        if (wn !== undefined && wn !== null && wn > currentWave) {
          currentWave = wn;
        }
      }
    }

    const waveProgress: Record<number, { done: number; total: number }> = {};
    for (const [wn, progress] of waveMap) {
      waveProgress[wn] = progress;
    }

    return {
      active_agents: activeAgentCount,
      wave_progress: waveProgress,
      blocked_count: blockedCount,
      needs_context_count: needsContextCount,
      current_wave: currentWave,
    };
  },
});

export const list = query({
  args: {
    api_token: v.string(),
    status: v.optional(v.string()),
    project_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
    team: v.optional(v.boolean()),
    include_all: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });

    let plans;
    if (args.project_id) {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else if (args.team && db.workspace.type === "team") {
      const teamId = (db.workspace as { type: "team"; teamId: Id<"teams"> }).teamId;
      if (args.status) {
        plans = await ctx.db
          .query("plans")
          .withIndex("by_team_status", (q) => q.eq("team_id", teamId).eq("status", args.status as any))
          .collect();
      } else {
        plans = await ctx.db
          .query("plans")
          .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
          .collect();
      }
    } else if (args.status) {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_user_status", (q) => q.eq("user_id", auth.userId).eq("status", args.status as any))
        .collect();
    } else {
      plans = await db.query("plans").collect();
    }

    if (!args.status && !args.include_all) {
      plans = plans.filter((p: any) => p.status !== "done" && p.status !== "abandoned");
    }

    plans.sort((a: any, b: any) => (b.updated_at || 0) - (a.updated_at || 0));
    return plans.slice(0, args.limit || 500);
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
    if (plan.doc_id) {
      const doc = await ctx.db.get(plan.doc_id);
      if (doc?.content) lines.push(`Body: ${doc.content.slice(0, 2000)}`);
    }
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

    const comments = mergePlanEntries(plan);
    const decisions = comments.filter(e => e.type === "decision").slice(-3);
    const discoveries = comments.filter(e => e.type === "discovery").slice(-3);
    const references = comments.filter(e => e.type === "reference");

    if (decisions.length) {
      lines.push("Recent Decisions:");
      for (const d of decisions) {
        lines.push(`  - ${d.content}${d.rationale ? ` (${d.rationale})` : ""}`);
      }
    }

    if (discoveries.length) {
      lines.push("Discoveries:");
      for (const d of discoveries) {
        lines.push(`  - ${d.content}`);
      }
    }

    if (references.length) {
      lines.push("Context:");
      for (const r of references) {
        lines.push(`  - ${r.content}: ${r.path_or_url}`);
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
    body: v.optional(v.string()),
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    source: v.optional(v.string()),
    project_id: v.optional(v.string()),
    model_stylesheet: v.optional(v.string()),
    fidelity: v.optional(v.string()),
    join_policy: v.optional(v.string()),
    join_k: v.optional(v.number()),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId, workspace: args.workspace as any, team_id: args.team_id });
    const short_id = await nextShortId(ctx.db, "pl");

    let project_id: Id<"projects"> | undefined;
    if (args.project_id) {
      const project = await ctx.db
        .query("projects")
        .filter((q) => q.eq(q.field("_id"), args.project_id as any))
        .first();
      if (project) project_id = project._id;
    }

    const id = await db.insert("plans", {
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
      entries: [],
      session_ids: [],
      model_stylesheet: args.model_stylesheet,
      fidelity: args.fidelity as any,
      join_policy: args.join_policy as any,
      join_k: args.join_k,
    });

    const docId = await db.insert("docs", {
      title: args.title,
      content: args.body || "",
      doc_type: "plan",
      source: "human",
      plan_id: id,
      project_id,
    });
    await ctx.db.patch(id, { doc_id: docId });

    return { id, short_id, doc_id: docId };
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

    if (!(await canAccessPlan(ctx, userId, plan))) throw new Error("Plan not found");

    const updates: any = { updated_at: Date.now() };
    if (args.title) updates.title = args.title;
    if (args.goal !== undefined) updates.goal = args.goal;
    if (args.acceptance_criteria) updates.acceptance_criteria = args.acceptance_criteria;
    if (args.status) updates.status = args.status;
    if (args.context_pointers) updates.context_pointers = args.context_pointers;

    if (args.task_ids) {
      const taskDocIds = args.task_ids.map(id => id as Id<"tasks">);
      updates.task_ids = taskDocIds;
      updates.progress = await recalcProgress(ctx, taskDocIds);
    }

    if (args.title && plan.doc_id) {
      await ctx.db.patch(plan.doc_id, { title: args.title, updated_at: Date.now() });
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

    if (!(await canAccessPlan(ctx, userId, plan))) return null;

    // Find live agent sessions for tasks
    const now = Date.now();
    const HEARTBEAT_ALIVE_MS = 90 * 1000;
    const managedSessions = await ctx.db
      .query("managed_sessions")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const liveSessions = managedSessions.filter(
      (s: any) => now - s.last_heartbeat < HEARTBEAT_ALIVE_MS && s.conversation_id
    );
    const activeTaskMap = new Map<string, { session_id: string; title?: string }>();
    for (const s of liveSessions) {
      const conv = await ctx.db.get(s.conversation_id!);
      if (conv && (conv as any).active_task_id) {
        activeTaskMap.set((conv as any).active_task_id.toString(), {
          session_id: conv.session_id,
          title: conv.title || undefined,
        });
      }
    }

    const tasks = [];
    if (plan.task_ids) {
      for (const tid of plan.task_ids) {
        const task = await ctx.db.get(tid);
        if (task) {
          tasks.push({
            ...task,
            activeSession: activeTaskMap.get(task._id.toString()) || null,
          });
        }
      }
    }

    let doc_content: string | undefined;
    if (plan.doc_id) {
      const doc = await ctx.db.get(plan.doc_id);
      if (doc) {
        doc_content = doc.content;
      }
    }

    const sessions: any[] = [];
    if (plan.session_ids) {
      for (const sid of plan.session_ids) {
        const conv = await ctx.db.get(sid);
        if (conv) {
          sessions.push({
            _id: conv._id,
            session_id: conv.session_id,
            title: conv.title,
            headline: (conv as any).headline,
            project_path: conv.project_path,
            message_count: conv.message_count || 0,
            is_active: (conv as any).is_active,
            started_at: (conv as any).started_at || conv._creationTime,
            updated_at: conv.updated_at,
            agent_type: conv.agent_type,
            outcome_type: (conv as any).outcome_type,
            git_branch: (conv as any).git_branch,
            active_task_id: (conv as any).active_task_id?.toString() || null,
          });
        }
      }
    }

    const author = await ctx.db.get(plan.user_id);
    const comments = mergePlanEntries(plan);

    return {
      ...plan,
      tasks,
      sessions,
      doc_content,
      comments,
      author: author ? { name: author.name, image: author.image } : null,
    };
  },
});

export const ensureDoc = mutation({
  args: { plan_id: v.id("plans") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const plan = await ctx.db.get(args.plan_id);
    if (!plan) throw new Error("Plan not found");
    if (plan.doc_id) return { doc_id: plan.doc_id, created: false };

    const now = Date.now();
    const docId = await ctx.db.insert("docs", {
      title: plan.title,
      content: "",
      doc_type: "plan" as any,
      source: "human" as any,
      plan_id: plan._id,
      project_id: plan.project_id,
      user_id: plan.user_id,
      team_id: (plan as any).team_id,
      created_at: now,
      updated_at: now,
    });
    await ctx.db.patch(plan._id, { doc_id: docId });
    return { doc_id: docId, created: true };
  },
});

export const qualityScore = query({
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

    const tasks: any[] = [];
    for (const tid of plan.task_ids || []) {
      const t = await ctx.db.get(tid);
      if (t) tasks.push(t);
    }

    let readiness = 0, completeness = 0, risk = 0;
    const activeTasks = tasks.filter((t: any) => t.status !== "dropped");
    const total = activeTasks.length;
    if (total === 0) return { readiness: 0, completeness: 0, risk: 0, overall: 0, details: {} };

    const done = activeTasks.filter((t: any) => t.status === "done").length;
    const withDesc = activeTasks.filter((t: any) => t.description && t.description.length > 10).length;
    const withDeps = activeTasks.filter((t: any) => t.blocked_by?.length > 0).length;
    const needsContext = activeTasks.filter((t: any) => t.execution_status === "needs_context").length;
    const highRetry = activeTasks.filter((t: any) => (t.retry_count || 0) >= 2).length;

    readiness = Math.round((withDesc / total) * 50 + (withDeps > 0 ? 25 : 0) + (plan.goal ? 25 : 0));
    completeness = Math.round((done / total) * 100);
    risk = Math.min(100, Math.round((needsContext / Math.max(1, total)) * 50 + (highRetry / Math.max(1, total)) * 50));

    const overall = Math.round((readiness * 0.3 + completeness * 0.5 + (100 - risk) * 0.2));

    return {
      readiness, completeness, risk, overall,
      details: { total, done, withDesc, withDeps, needsContext, highRetry },
    };
  },
});

export const webList = query({
  args: {
    status: v.optional(v.string()),
    project_id: v.optional(v.string()),
    include_all: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    let plans;
    if (args.project_id) {
      plans = await ctx.db
        .query("plans")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else {
      const { records } = await scopedFetch(ctx, "plans", {
        userId,
        teamId: args.team_id,
        workspace: args.workspace,
      });
      plans = records;
    }
    if (args.project_path) {
      plans = scopeByProject(plans, args.project_path);
    }

    if (args.status) {
      plans = plans.filter((p: any) => p.status === args.status);
    } else if (!args.include_all) {
      plans = plans.filter((p: any) => p.status !== "done" && p.status !== "abandoned");
    }

    plans.sort((a: any, b: any) => (b.updated_at || 0) - (a.updated_at || 0));
    const result = plans.slice(0, args.limit || 500);
    return enrichPlansWithLiveness(ctx, userId, result);
  },
});

async function enrichPlansWithLiveness(ctx: any, userId: any, plans: any[]) {
  const now = Date.now();
  const HEARTBEAT_ALIVE_MS = 90 * 1000;
  const managedSessions = await ctx.db
    .query("managed_sessions")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const liveSessions = managedSessions.filter(
    (s: any) => now - s.last_heartbeat < HEARTBEAT_ALIVE_MS && s.conversation_id,
  );
  const activeTaskIds = new Set<string>();
  for (const s of liveSessions) {
    const conv = await ctx.db.get(s.conversation_id!);
    if (conv && (conv as any).active_task_id) {
      activeTaskIds.add((conv as any).active_task_id.toString());
    }
  }
  return plans.map((p: any) => {
    const taskIds = (p.task_ids || []).map((id: any) => id.toString());
    const activeAgents = taskIds.filter((id: string) => activeTaskIds.has(id)).length;
    return { ...p, active_agents: activeAgents };
  });
}

export const webTeamList = query({
  args: {
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const db = await createDataContext(ctx, { userId, workspace: args.workspace as any, team_id: args.team_id });
    if (db.workspace.type !== "team") return [];

    let plans = await db.query("plans").collect();

    if (args.status) {
      plans = plans.filter((p: any) => p.status === args.status);
    } else {
      plans = plans.filter((p: any) => p.status !== "done" && p.status !== "abandoned");
    }

    const result = plans.slice(0, args.limit || 500);
    return enrichPlansWithLiveness(ctx, userId, result);
  },
});

export const webPlanContext = query({
  args: {
    plan_id: v.id("plans"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const plan = await ctx.db.get(args.plan_id);
    if (!plan) return null;

    const tasks: any[] = [];
    if (plan.task_ids) {
      for (const tid of plan.task_ids) {
        const t = await ctx.db.get(tid);
        if (t) {
          tasks.push({
            _id: t._id,
            short_id: t.short_id,
            title: t.title,
            status: t.status,
            priority: t.priority,
          });
        }
      }
    }

    const done = tasks.filter(t => t.status === "done").length;
    const inProgress = tasks.filter(t => t.status === "in_progress").length;

    return {
      _id: plan._id,
      short_id: plan.short_id,
      title: plan.title,
      goal: plan.goal,
      status: plan.status,
      tasks,
      progress: { total: tasks.length, done, in_progress: inProgress },
      recent_log: mergePlanEntries(plan).filter(e => e.type === "progress").slice(-3),
    };
  },
});

export const saveRetro = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    smoothness: v.string(),
    headline: v.string(),
    learnings: v.any(),
    friction_points: v.any(),
    open_items: v.any(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!plan) throw new Error("Plan not found");
    if (!(await canAccessPlan(ctx, auth.userId, plan))) throw new Error("Plan not found");

    const normalizeArray = (arr: any[]) =>
      arr.map((item: any) => typeof item === "string" ? { text: item } : item);

    await ctx.db.patch(plan._id, {
      retro: {
        smoothness: args.smoothness,
        headline: args.headline,
        learnings: normalizeArray(args.learnings),
        friction_points: normalizeArray(args.friction_points),
        open_items: normalizeArray(args.open_items),
        generated_at: Date.now(),
      },
      updated_at: Date.now(),
    });
    return { success: true };
  },
});
