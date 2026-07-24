import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { enqueueStartSession } from "./devices";
import { fromConvexAgentType } from "@codecast/shared/contracts";
import { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext, scopeByProject } from "./data";
import { nextShortId } from "./counters";
import { internal } from "./_generated/api";
import { isViableInboxParent } from "./inboxFilters";
import { pickInheritedGitMeta, type GitMetaSource } from "./projectPaths";
import { enqueuePendingMessage } from "./pendingMessages";
import { resolveTeamForPath, teamVisibleConvTeam } from "./privacy";
// Owner-or-team access check for a task. Moved to lib/access.ts (Wave-1
// auth/access seam). Imported for local use here and re-exported so existing
// callers keep working unchanged.
import {
  canAccessTask,
  canAccessConversation,
  canAccessDoc,
  canAccessPlan,
  canAccessProject,
  isSameWorkspace,
  requireAccessibleProject,
  requireSameWorkspace,
  requireTeamMembership,
  requireWorkspaceMatch,
  workspaceForConversation,
  workspaceForResource,
  workspacesMatch,
} from "./lib/access";
import { forbidden, notFound } from "./lib/auth";
export { canAccessTask };

const VALID_TASK_STATUSES = ["backlog", "open", "in_progress", "in_review", "done", "dropped"] as const;

// Resolve the orchestrator conversation a task's worker session should nest
// under: the session that created the task's plan
// (plans.created_from_conversation_id), which is the de-facto orchestrator and
// — unlike plans.current_session_id — is stamped once and never churned by
// per-worker auto-binding. Returns undefined when there's no plan, no recorded
// creator, or the creator isn't a renderable inbox parent, in which case the
// worker stays top-level and the client's plan-grouping fallback handles it.
export async function resolveWorkerParentConversation(
  ctx: any,
  userId: Id<"users">,
  planId: Id<"plans"> | undefined,
): Promise<Id<"conversations"> | undefined> {
  if (!planId) return undefined;
  let plan;
  try {
    plan = await ctx.db.get(planId);
  } catch {
    return undefined;
  }
  const creatorId = plan?.created_from_conversation_id as Id<"conversations"> | undefined;
  if (!creatorId) return undefined;
  let parent;
  try {
    parent = await ctx.db.get(creatorId);
  } catch {
    return undefined;
  }
  return isViableInboxParent(parent, userId.toString()) ? creatorId : undefined;
}

/**
 * Resolve the project/git context a task-bound session must launch in:
 * `project_path` (the task's own, or its team's directory mapping), `git_root`,
 * and the `git_remote_url` recovered from the task's source conversations (a task
 * itself stores no remote). Shared by `dispatch.createSession` and
 * `tasks.assignToAgent` so both task-launch paths stamp the conversation and
 * route the daemon identically — without a project_path the conversation can't
 * be started by any daemon (the "start agent run did nothing" bug). `seed` lets
 * a caller-supplied path win over the task's.
 */
export async function resolveTaskGitContext(
  ctx: any,
  userId: Id<"users">,
  task: any,
  mappings: any[],
  seed?: { project_path?: string; git_root?: string },
): Promise<{ project_path?: string; git_root?: string; git_remote_url?: string }> {
  let project_path = seed?.project_path;
  let git_root = seed?.git_root;
  let git_remote_url: string | undefined;

  if (!project_path) {
    if (task.project_path) {
      project_path = task.project_path;
    } else if (task.team_id) {
      const teamMapping = mappings.find((m: any) => m.team_id?.toString() === task.team_id.toString());
      if (teamMapping) project_path = teamMapping.path_prefix;
    }
    if (!git_root) git_root = project_path;
  }

  // A task stores project_path but never git_remote_url; recover it from the
  // task's source conversations (which a daemon stamped git metadata onto) so a
  // daemon on a different machine can remap a foreign path to the local checkout.
  const sourceIds: Id<"conversations">[] = [];
  if (task.created_from_conversation) sourceIds.push(task.created_from_conversation);
  for (const cid of (task.conversation_ids ?? [])) {
    if (!sourceIds.some((s) => s.toString() === cid.toString())) sourceIds.push(cid);
  }
  const sources: GitMetaSource[] = [];
  for (const cid of sourceIds) {
    const c = await ctx.db.get(cid).catch(() => null);
    if (c && c.user_id.toString() === userId.toString()) {
      sources.push({ git_remote_url: c.git_remote_url, git_root: c.git_root, updated_at: c.updated_at, started_at: c.started_at });
    }
  }
  const inherited = pickInheritedGitMeta(sources);
  if (inherited.git_remote_url) {
    git_remote_url = inherited.git_remote_url;
    // Prefer the real repo root over a foreign full path so the daemon can keep
    // the in-repo subpath when remapping to a local checkout.
    if (inherited.git_root && project_path
        && project_path.startsWith(inherited.git_root)
        && inherited.git_root !== git_root) {
      git_root = inherited.git_root;
    }
  }

  return { project_path, git_root, git_remote_url };
}

type TaskStatus = typeof VALID_TASK_STATUSES[number];

function assertValidTaskStatus(status: string | undefined): asserts status is TaskStatus | undefined {
  if (status !== undefined && !VALID_TASK_STATUSES.includes(status as TaskStatus)) {
    throw new Error(`Invalid task status '${status}'. Valid: ${VALID_TASK_STATUSES.join(", ")}`);
  }
}

// Resolve a free-form assignee ("Jason", "Jason Benn", an email, a github
// handle) to a team member's user id. Mirrors the feed member resolver in
// conversations.ts: exact match on github_username/name/email first, then a
// UNIQUE case-insensitive substring on name/email. Returns null when nothing
// matches or a substring is ambiguous — it never guesses between two people.
async function findTeamMemberId(
  ctx: any,
  query: string,
  teamId?: Id<"teams">
): Promise<Id<"users"> | null> {
  if (!teamId) return null;
  const lower = query.toLowerCase();
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
    .collect();
  const members = (await Promise.all(memberships.map((m: any) => ctx.db.get(m.user_id)))).filter(Boolean);
  const exact = members.find((u: any) =>
    u.github_username?.toLowerCase() === lower ||
    u.name?.toLowerCase() === lower ||
    u.email?.toLowerCase() === lower ||
    u.alternate_emails?.some((e: string) => e.toLowerCase() === lower)
  );
  if (exact) return exact._id;
  const partial = members.filter((u: any) =>
    u.name?.toLowerCase().includes(lower) ||
    u.email?.toLowerCase().includes(lower) ||
    u.alternate_emails?.some((e: string) => e.toLowerCase().includes(lower))
  );
  return partial.length === 1 ? partial[0]._id : null;
}

export async function resolveAssigneeToUserId(
  ctx: any,
  assignee: string,
  teamId?: Id<"teams">
): Promise<Id<"users"> | null> {
  if (!assignee) return null;
  // Only call ctx.db.get when the input actually is a document id — it throws
  // on a malformed id, so a raw name like "Jason Benn" must never reach it.
  // normalizeId returns null for non-ids instead of throwing.
  const directId = ctx.db.normalizeId("users", assignee);
  if (directId) {
    const direct = await ctx.db.get(directId);
    if (direct) return direct._id;
  }
  const lower = assignee.toLowerCase();
  const byGh = await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", lower)).first();
  if (byGh) return byGh._id;
  return findTeamMemberId(ctx, assignee, teamId);
}

export async function resolveAssigneeStr(
  ctx: any,
  assignee: string | undefined,
  userId: Id<"users">
): Promise<string | undefined> {
  if (!assignee) return undefined;
  if (assignee === "me") return userId.toString();
  if (assignee.startsWith("agent:")) return assignee;
  if (/^[a-z0-9]{32}$/.test(assignee)) return assignee;
  const lower = assignee.toLowerCase();
  const found = await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", lower)).first();
  if (found) return found._id.toString();
  // Fall back to a team-member name/email match so friendly names persist a
  // real user id (consistent with github-handle matches) rather than a bare
  // string that the UI roster and notification routing can't resolve.
  const actor = await ctx.db.get(userId);
  const teamId = (actor?.active_team_id || actor?.team_id) as Id<"teams"> | undefined;
  const memberId = await findTeamMemberId(ctx, assignee, teamId);
  return memberId ? memberId.toString() : assignee;
}

export async function notifySubscribers(
  ctx: any,
  eventType: string,
  actorUserId: Id<"users">,
  task: { _id: Id<"tasks">; short_id: string; title: string },
  message: string,
  conversationId?: Id<"conversations">
) {
  await ctx.runMutation(internal.notificationRouter.emit, {
    event_type: eventType,
    actor_user_id: actorUserId,
    entity_type: "task",
    entity_id: task._id.toString(),
    message,
    conversation_id: conversationId,
  });
}

export async function subscribeUser(
  ctx: any,
  userId: Id<"users">,
  taskId: Id<"tasks">,
  reason: "creator" | "assignee" | "commenter" | "mentioned" | "watching"
) {
  await ctx.runMutation(internal.notificationRouter.ensureSubscribed, {
    user_id: userId,
    entity_type: "task",
    entity_id: taskId.toString(),
    reason,
  });
}

export async function recalcPlanProgress(ctx: any, planId: Id<"plans">, updatedTaskId: Id<"tasks">, newStatus: string) {
  const plan = await ctx.db.get(planId);
  if (!plan || !plan.task_ids) return;
  const updatedTask = await ctx.db.get(updatedTaskId);
  const containsUpdatedTask = plan.task_ids.some((id: Id<"tasks">) =>
    String(id) === String(updatedTaskId));
  if (
    !updatedTask
    || !containsUpdatedTask
    || !isSameWorkspace(updatedTask, workspaceForResource(plan))
  ) return;

  let total = 0, done = 0, in_progress = 0, open = 0;
  for (const tid of plan.task_ids) {
    const t = tid === updatedTaskId
      ? { ...updatedTask, status: newStatus }
      : await ctx.db.get(tid);
    if (t && isSameWorkspace(t, workspaceForResource(plan))) {
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
    steps: v.optional(v.array(v.object({
      title: v.string(),
      done: v.optional(v.boolean()),
      verification: v.optional(v.string()),
    }))),
    acceptance_criteria: v.optional(v.array(v.string())),
    estimated_minutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    assertValidTaskStatus(args.status);

    // Resolve conversation first so we can propagate team_id to the task
    let conversation_ids: Id<"conversations">[] | undefined;
    let created_from_conversation: Id<"conversations"> | undefined;
    let convTeamId: Id<"teams"> | undefined;
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (!conv || !(await canAccessConversation(ctx, auth.userId, conv))) {
        notFound("Conversation not found");
      }
      conversation_ids = [conv._id];
      created_from_conversation = conv._id;
      // Only team-visible conversations hand their team to the task — a
      // private session's team_id is routing, and copying it here would make
      // the task readable by the whole team (see teamVisibleConvTeam).
      convTeamId = teamVisibleConvTeam(conv);
    }

    const db = await createDataContext(ctx, {
      userId: auth.userId,
      project_path: args.project_path,
      ...(convTeamId ? { workspace: "team" as const, team_id: convTeamId } : {}),
    });
    const now = Date.now();
    const short_id = await nextShortId(ctx.db, "ct");

    let project_id: Id<"projects"> | undefined;
    if (args.project_id) {
      const pid = ctx.db.normalizeId("projects", args.project_id);
      if (!pid) notFound("Project not found");
      const project = await requireAccessibleProject(ctx, auth.userId, pid);
      requireSameWorkspace(project, db.workspace, "project");
      project_id = pid;
    }

    let plan_id: Id<"plans"> | undefined;
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (!plan || !(await canAccessPlan(ctx, auth.userId, plan))) notFound("Plan not found");
      requireSameWorkspace(plan, db.workspace, "plan");
      plan_id = plan._id;
    }

    const resolvedAssignee = await resolveAssigneeStr(ctx, args.assignee, auth.userId);

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
      assignee: resolvedAssignee,
      labels: args.labels,
      blocked_by: args.blocked_by,
      blocks: [],
      conversation_ids,
      created_from_conversation,
      created_from_insight: args.insight_id as any,
      source: (args.source || "human") as any,
      triage_status: args.source === "insight" ? "suggested" : "active",
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
      steps: args.steps,
      acceptance_criteria: args.acceptance_criteria,
      estimated_minutes: args.estimated_minutes,
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

    if (created_from_conversation && plan_id) {
      const conv = await ctx.db.get(created_from_conversation);
      if (conv && !conv.active_plan_id) {
        await ctx.db.patch(created_from_conversation, { active_plan_id: plan_id });
      }
    }

    await subscribeUser(ctx, auth.userId, id, "creator");
    if (resolvedAssignee) {
      const createdTask = await ctx.db.get(id) as any;
      const assigneeId = await resolveAssigneeToUserId(ctx, resolvedAssignee, createdTask?.team_id);
      if (assigneeId) {
        await subscribeUser(ctx, assigneeId, id, "assignee");
        await ctx.runMutation(internal.notificationRouter.emit, {
          event_type: "task_assigned",
          actor_user_id: auth.userId,
          entity_type: "task",
          entity_id: id.toString(),
          message: `assigned you to ${short_id}: ${args.title}`,
          direct_recipient_id: assigneeId,
        });
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

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) throw new Error("Task not found");

    await ctx.db.patch(task._id, { promoted: true, triage_status: "active" as const, updated_at: Date.now() });
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
      (!t.triage_status || t.triage_status === "active")
    );

    const userIds = [...new Set(activeTasks.map((t: any) => t.user_id as Id<"users">))] as Id<"users">[];
    const userMap = new Map<string, string>();
    for (const uid of userIds) {
      const u = await ctx.db.get(uid) as any;
      if (u) userMap.set(uid.toString(), u.name || u.email || "unknown");
    }

    let sessionPlans: { title: string; doc_type: string }[] = [];
    let activePlanSnippet = "";
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv) {
        if (!(await canAccessConversation(ctx, auth.userId, conv))) notFound("Conversation not found");
        // Fetch only this conversation's docs through the by_conversation_id
        // index. Collecting the whole team docs table (every row's full markdown
        // content — which this snippet never even returns, only titles below)
        // blew the 64 MB UDF heap for doc-heavy teams. db.get re-applies the
        // workspace access the scoped db.query() used to provide.
        const convDocs = await ctx.db
          .query("docs")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
          .collect();
        for (const d of convDocs) {
          if (sessionPlans.length >= 5) break;
          if (d.archived_at) continue;
          if (await db.get(d._id)) {
            sessionPlans.push({ title: d.title, doc_type: d.doc_type });
          }
        }

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
    include_done: v.optional(v.boolean()),
    project_path: v.optional(v.string()),
    query: v.optional(v.string()),
    assignee: v.optional(v.string()),
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

    let resolvedAssignee: string | undefined;
    if (args.assignee) {
      resolvedAssignee = await resolveAssigneeStr(ctx, args.assignee, auth.userId);
    }

    let tasks: any[];
    // The assignee and project_id indexes are global — they return rows the
    // caller may not be able to see, so those two branches get an explicit
    // owner-or-team-member filter below. The other branches are already
    // user/workspace-scoped.
    let needsAccessFilter = false;
    if (resolvedAssignee) {
      // When filtering by assignee, query the assignee index directly so
      // tasks assigned to the user but missing team_id aren't dropped by
      // the workspace-scoped query.
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_assignee_updated", (q: any) =>
          q.eq("assignee", resolvedAssignee)
        )
        .collect();
      needsAccessFilter = true;
    } else if (args.project_id) {
      tasks = await ctx.db
        .query("tasks")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
      needsAccessFilter = true;
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

    if (needsAccessFilter) {
      const memberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", auth.userId))
        .collect();
      const memberTeamIds = new Set(memberships.map((m: any) => String(m.team_id)));
      tasks = tasks.filter((t: any) =>
        String(t.user_id) === String(auth.userId) ||
        (t.team_id && memberTeamIds.has(String(t.team_id)))
      );
    }

    if (!args.status && !args.include_done) {
      tasks = tasks.filter((t: any) => t.status !== "done" && t.status !== "dropped");
    }

    if (!args.include_derived) {
      tasks = tasks.filter((t: any) => !t.triage_status || t.triage_status === "active");
    }

    if (args.execution_status) {
      tasks = tasks.filter((t: any) => t.execution_status === args.execution_status);
    }

    if (args.query) {
      const q = args.query.toLowerCase();
      tasks = tasks.filter((t: any) =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q) ||
        (t.short_id || "").toLowerCase().includes(q),
      );
    }

    // Ready = open + no blockers
    if (args.ready) {
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
    const result = tasks.slice(0, limit);

    const assigneeIds = [...new Set(result.map((t: any) => t.assignee).filter(Boolean))];
    const assigneeNames: Record<string, string> = {};
    for (const id of assigneeIds) {
      if (id.startsWith("agent:")) {
        assigneeNames[id] = id;
      } else {
        const user = await ctx.db.get(id as any) as any;
        if (user?.name) assigneeNames[id] = user.name;
        else if (user?.github_username) assigneeNames[id] = user.github_username;
      }
    }
    return result.map((t: any) => ({
      ...t,
      assignee_name: t.assignee ? (assigneeNames[t.assignee] || t.assignee) : undefined,
    }));
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
      // CLI-supplied id may be malformed; normalizeId returns null rather than
      // letting ctx.db.get throw "Invalid ID length". (Mirrors tasks.webGet.)
      const taskId = ctx.db.normalizeId("tasks", args.id);
      task = taskId ? await ctx.db.get(taskId) : null;
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
    project_path: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
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
    assertValidTaskStatus(args.status);

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
    if (args.assignee !== undefined) updates.assignee = await resolveAssigneeStr(ctx, args.assignee, auth.userId) || args.assignee;
    if (args.labels) updates.labels = args.labels;
    const targetWorkspace = args.team_id
      ? { type: "team" as const, teamId: args.team_id }
      : task.team_id
        ? { type: "team" as const, teamId: task.team_id }
        : { type: "personal" as const, userId: task.user_id };
    if (args.team_id) {
      await requireTeamMembership(ctx, auth.userId, args.team_id);
      if (task.team_id && String(task.team_id) !== String(args.team_id) && String(task.user_id) !== String(auth.userId)) {
        forbidden("Forbidden: only the task owner may move it between teams");
      }
    }
    if (args.project_id !== undefined) {
      if (!args.project_id) {
        updates.project_id = undefined;
      } else {
        const projectId = ctx.db.normalizeId("projects", args.project_id);
        if (!projectId) notFound("Project not found");
        const project = await requireAccessibleProject(ctx, auth.userId, projectId);
        requireSameWorkspace(project, targetWorkspace, "project");
        updates.project_id = projectId;
      }
    }
    if (args.project_path !== undefined) updates.project_path = args.project_path || undefined;
    if (args.team_id) updates.team_id = args.team_id;
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (!plan || !(await canAccessPlan(ctx, auth.userId, plan))) notFound("Plan not found");
      requireSameWorkspace(plan, targetWorkspace, "plan");
      updates.plan_id = plan._id;
      const taskIds = plan.task_ids || [];
      if (!taskIds.some((id: any) => id === task._id)) {
        taskIds.push(task._id);
        await ctx.db.patch(plan._id, { task_ids: taskIds, updated_at: now });
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
      if (!conv || !(await canAccessConversation(ctx, auth.userId, conv))) {
        notFound("Conversation not found");
      }
      requireWorkspaceMatch(
        workspaceForConversation(conv),
        targetWorkspace,
        "conversation",
      );
      linkedConvId = conv._id;
      const existing = task.conversation_ids || [];
      if (!existing.some((id) => id === conv._id)) {
        updates.conversation_ids = [...existing, conv._id];
      }
      // Only bind conversation to task on explicit start (cast task start)
      if (args.status === "in_progress" && (!conv.active_task_id || conv.active_task_id === task._id)) {
        await ctx.db.patch(conv._id, { active_task_id: task._id });
        if (task.plan_id && !conv.active_plan_id) {
          const relatedPlan = await ctx.db.get(task.plan_id);
          if (
            relatedPlan
            && isSameWorkspace(relatedPlan, targetWorkspace)
            && (await canAccessPlan(ctx, auth.userId, relatedPlan))
          ) {
            await ctx.db.patch(conv._id, { active_plan_id: task.plan_id });
          }
        }
      }
      // Clear active_task_id when task is closed
      if ((args.status === "done" || args.status === "dropped") && conv.active_task_id === task._id) {
        await ctx.db.patch(conv._id, { active_task_id: undefined });
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
    if (args.assignee !== undefined && updates.assignee !== task.assignee) trackFields.push(["assignee", task.assignee || "", updates.assignee || ""]);

    for (const [field, oldVal, newVal] of trackFields) {
      await ctx.db.insert("task_history", {
        task_id: task._id,
        user_id: auth.userId,
        actor_type: "user",
        action: "updated",
        field,
        old_value: String(oldVal),
        new_value: String(newVal),
        ...(linkedConvId ? { conversation_id: linkedConvId } : {}),
        created_at: now,
      });
    }

    await ctx.db.patch(task._id, updates);

    if (args.status && args.status !== task.status) {
      if (task.plan_id) {
        await recalcPlanProgress(ctx, task.plan_id, task._id, args.status);
      }
      await notifySubscribers(ctx, "task_status_changed", auth.userId, task as any, `changed ${task.short_id} to ${args.status}`, linkedConvId);
    }
    if (args.assignee !== undefined && updates.assignee !== task.assignee) {
      const assigneeId = await resolveAssigneeToUserId(ctx, updates.assignee || "", task.team_id);
      if (assigneeId) {
        await subscribeUser(ctx, assigneeId, task._id, "assignee");
        await ctx.runMutation(internal.notificationRouter.emit, {
          event_type: "task_assigned",
          actor_user_id: auth.userId,
          entity_type: "task",
          entity_id: task._id.toString(),
          message: `assigned you to ${task.short_id}: ${task.title}`,
          direct_recipient_id: assigneeId,
        });
      }
    }

    let planShortId: string | undefined;
    if (task.plan_id) {
      const plan = await ctx.db.get(task.plan_id);
      if (
        plan
        && isSameWorkspace(plan, targetWorkspace)
        && (await canAccessPlan(ctx, auth.userId, plan))
      ) {
        planShortId = plan.short_id;
      }
    }
    return { success: true, plan_id: planShortId };
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
      if (!conv || !(await canAccessConversation(ctx, auth.userId, conv))) {
        notFound("Conversation not found");
      }
      requireWorkspaceMatch(
        workspaceForConversation(conv),
        workspaceForResource(task),
        "conversation",
      );
      conversation_id = conv._id;
    }

    const id = await ctx.db.insert("task_comments", {
      task_id: task._id,
      author: args.author || user?.name || "unknown",
      text: args.text,
      conversation_id,
      comment_type: (args.comment_type || "note") as any,
      created_at: Date.now(),
    });

    await subscribeUser(ctx, auth.userId, task._id, "commenter");
    await notifySubscribers(ctx, "task_commented", auth.userId, task as any, `commented on ${task.short_id}: ${args.text.slice(0, 100)}`, conversation_id);

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
      const other = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.blocks!))
        .first();
      if (!other || !(await canAccessTask(ctx, auth.userId, other))) notFound("Task not found");
      requireSameWorkspace(other, workspaceForResource(task), "dependency task");
      const current = task.blocks || [];
      if (!current.includes(args.blocks)) {
        await ctx.db.patch(task._id, { blocks: [...current, args.blocks], updated_at: Date.now() });
      }
      const otherBlocked = other.blocked_by || [];
      if (!otherBlocked.includes(args.short_id)) {
        await ctx.db.patch(other._id, { blocked_by: [...otherBlocked, args.short_id], updated_at: Date.now() });
      }
    }

    if (args.blocked_by) {
      const other = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.blocked_by!))
        .first();
      if (!other || !(await canAccessTask(ctx, auth.userId, other))) notFound("Task not found");
      requireSameWorkspace(other, workspaceForResource(task), "dependency task");
      const current = task.blocked_by || [];
      if (!current.includes(args.blocked_by)) {
        await ctx.db.patch(task._id, { blocked_by: [...current, args.blocked_by], updated_at: Date.now() });
      }
      const otherBlocks = other.blocks || [];
      if (!otherBlocks.includes(args.short_id)) {
        await ctx.db.patch(other._id, { blocks: [...otherBlocks, args.short_id], updated_at: Date.now() });
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

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) return null;

    const comments = await ctx.db
      .query("task_comments")
      .withIndex("by_task_id", (q) => q.eq("task_id", task._id))
      .collect();

    // Get session summaries from linked conversations
    const sessionSummaries: string[] = [];
    if (task.conversation_ids) {
      for (const convId of task.conversation_ids.slice(-5)) {
        const conversation = await ctx.db.get(convId);
        if (
          !conversation
          || !workspacesMatch(workspaceForConversation(conversation), workspaceForResource(task))
          || !(await canAccessConversation(ctx, auth.userId, conversation))
        ) continue;
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
      const candidate = await ctx.db.get(task.project_id);
      if (
        candidate
        && isSameWorkspace(candidate, workspaceForResource(task))
        && (await canAccessProject(ctx, auth.userId, candidate))
      ) project = candidate;
    }

    // Get related docs/plans from linked conversations. Query by conversation_id
    // so each scan loads only that conversation's docs — collecting the user's
    // entire docs table (full markdown content and all) per linked conversation
    // blew the 64 MB UDF heap for prolific doc authors.
    const relatedDocs: { title: string; doc_type: string; content: string }[] = [];
    if (task.conversation_ids) {
      for (const convId of task.conversation_ids.slice(-3)) {
        const conversation = await ctx.db.get(convId);
        if (
          !conversation
          || !workspacesMatch(workspaceForConversation(conversation), workspaceForResource(task))
          || !(await canAccessConversation(ctx, auth.userId, conversation))
        ) continue;
        const docs = await ctx.db
          .query("docs")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", convId))
          .collect();
        for (const d of docs) {
          if (
            !d.archived_at
            && isSameWorkspace(d, workspaceForResource(task))
            && (await canAccessDoc(ctx, auth.userId, d))
          ) {
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

// Enrich a page of task rows in place with creator/assignee/plan/source info.
// Shared by webList (the live delta channel) and webListPaginated (the full
// reconcile crawl) so both return identical task shapes. Mutates `result` in
// place — the spread form `{...t, ...}` doubled peak heap and was a top
// contributor to TooMuchMemoryCarryOver on these UDFs.
async function enrichTasks(ctx: any, userId: Id<"users">, result: any[]): Promise<any[]> {
  const allUserIds = new Set<string>();
  for (const t of result) {
    allUserIds.add(t.user_id.toString());
    if (t.assignee) allUserIds.add(t.assignee.toString());
  }
  const userMap = new Map<string, { name: string; image?: string; github_username?: string }>();
  await Promise.all([...allUserIds].map(async (uid) => {
    try {
      const u = await ctx.db.get(uid as Id<"users">);
      if (u) userMap.set(uid, { name: u.name || u.email || "Unknown", image: u.image || u.github_avatar_url, github_username: u.github_username });
    } catch {
      const lower = uid.toLowerCase();
      const u = await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", uid)).first()
        || await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", lower)).first();
      if (u) {
        userMap.set(uid, { name: u.name || u.email || "Unknown", image: u.image || u.github_avatar_url, github_username: u.github_username });
      }
    }
  }));

  const planIds = new Set<string>();
  for (const t of result) {
    if (t.plan_id) planIds.add(t.plan_id.toString());
  }
  const planMap = new Map<string, {
    _id: any;
    user_id: Id<"users">;
    team_id?: Id<"teams">;
    short_id: string;
    title: string;
    status: string;
  }>();
  await Promise.all([...planIds].map(async (pid) => {
    try {
      const p = await ctx.db.get(pid as Id<"plans">);
      if (p && (await canAccessPlan(ctx, userId, p))) {
        planMap.set(pid, {
          _id: p._id,
          user_id: p.user_id,
          team_id: p.team_id,
          short_id: p.short_id,
          title: p.title,
          status: p.status,
        });
      }
    } catch {}
  }));

  // NOTE: session enrichment is intentionally NOT inlined here — reading
  // managed_sessions or conversations from a list query subscribes it to tables
  // that churn on every heartbeat/message, re-running the query and re-shipping
  // a multi-MB response every few seconds (isolate memory churn + "too many
  // system operations" timeouts under load). The live overlay is
  // `webActiveSessions`; the dormant origin badge is `webTaskOrigins`, fetched
  // one-shot by the client (a dormant session's badge data no longer changes).

  for (const t of result) {
    t.creator = userMap.get(t.user_id.toString()) || null;
    t.assignee_info = t.assignee ? userMap.get(t.assignee.toString()) || null : null;
    const relatedPlan = t.plan_id ? planMap.get(t.plan_id.toString()) : undefined;
    t.plan = relatedPlan && isSameWorkspace(relatedPlan, workspaceForResource(t))
      ? {
          _id: relatedPlan._id,
          short_id: relatedPlan.short_id,
          title: relatedPlan.title,
          status: relatedPlan.status,
        }
      : null;
    t.session_count = (t.conversation_ids || []).length;
  }
  return result;
}

export const webList = query({
  args: {
    project_id: v.optional(v.string()),
    status: v.optional(v.string()),
    execution_status: v.optional(v.string()),
    ready: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    page: v.optional(v.number()),
    include_derived: v.optional(v.boolean()),
    triage_status: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"), v.literal("all"))),
    project_path: v.optional(v.string()),
    // Delta cursor: when provided, only return tasks with updated_at > since.
    // First subscription omits it (full snapshot); subsequent subscriptions
    // pass the high-water-mark from the prior response. The web client merges
    // results additively — rows missing from a delta are NOT removed locally,
    // since tasks are soft-deleted via status="dropped" (which bumps
    // updated_at, so the dropped row flows through naturally).
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { items: [], hasMore: false, cursor: args.since ?? 0, isDelta: !!args.since };
    if (args.team_id) await requireTeamMembership(ctx, userId, args.team_id);
    if (args.workspace === "team" && !args.team_id) {
      throw new Error("team_id is required for the team workspace");
    }

    const since = args.since;
    const isDelta = since !== undefined;

    // Range-scan helper: when in delta mode, use the *_updated indexes so we
    // only materialize rows whose updated_at > since. Initial (non-delta) load
    // is capped to the most-recently-updated MAX_INITIAL — the unbounded
    // collect blew the Convex isolate's 96 MiB memory limit on heavy users
    // (TooMuchMemoryCarryOver, 2026-05-13). Older rows are still reachable via
    // delta polling after the cursor advances.
    // Initial-load cap. Each task row can carry a large body, and Convex loads
    // whole documents (no field projection), so a big MAX_INITIAL pulls tens of
    // MiB into the isolate and trips the memory limit (TooMuchMemoryCarryOver),
    // forcing isolate restarts that disrupt every other in-flight function on the
    // backend. 300 most-recent rows is plenty for the list view; older rows are
    // still reachable via delta polling once the cursor advances.
    const MAX_INITIAL = 300;
    const collectByUser = async (uid: any) => isDelta
      ? await ctx.db.query("tasks").withIndex("by_user_updated", (q: any) =>
          q.eq("user_id", uid).gt("updated_at", since!)).collect()
      : await ctx.db.query("tasks").withIndex("by_user_updated", (q: any) =>
          q.eq("user_id", uid)).order("desc").take(MAX_INITIAL);
    const collectByTeam = async (tid: any) => isDelta
      ? await ctx.db.query("tasks").withIndex("by_team_updated", (q: any) =>
          q.eq("team_id", tid).gt("updated_at", since!)).collect()
      : await ctx.db.query("tasks").withIndex("by_team_updated", (q: any) =>
          q.eq("team_id", tid)).order("desc").take(MAX_INITIAL);
    const collectByAssignee = async (assignee: string) => isDelta
      ? await ctx.db.query("tasks").withIndex("by_assignee_updated", (q: any) =>
          q.eq("assignee", assignee).gt("updated_at", since!)).collect()
      : await ctx.db.query("tasks").withIndex("by_assignee_updated", (q: any) =>
          q.eq("assignee", assignee)).order("desc").take(MAX_INITIAL);

    let tasks: any[];
    if (args.project_id) {
      const projectId = ctx.db.normalizeId("projects", args.project_id);
      if (!projectId) notFound("Project not found");
      await requireAccessibleProject(ctx, userId, projectId);
      // project_id path has no _updated index yet; fall back to collect+filter
      // (these queries are rarely the memory hot spot — they're scoped to
      // one project at a time).
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_project_id", (q) => q.eq("project_id", projectId))
        .collect();
      const authorizedRows: any[] = [];
      for (const row of rows) {
        if (await canAccessTask(ctx, userId, row)) authorizedRows.push(row);
      }
      tasks = isDelta ? authorizedRows.filter((t: any) => t.updated_at > since!) : authorizedRows;
      if (args.status) {
        tasks = tasks.filter((t) => t.status === args.status);
      } else {
        tasks = tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
      }
    } else {
      const seen = new Set<string>();
      const allTasks: any[] = [];
      const pushUnique = (t: any) => {
        const id = String(t._id);
        if (!seen.has(id)) { seen.add(id); allTasks.push(t); }
      };

      // Scope scans run in parallel: this query dies with "timed out performing
      // too many system operations" when serial index reads stack up under a
      // slow-backend window, so never await these one at a time.
      if (args.workspace === "team" && args.team_id) {
        // TEAM VIEW: fetch ALL tasks for this team — no per-status limits.
        // Client does all filtering (status, source, assignee, priority).
        const [teamTasks, assignedTasks] = await Promise.all([
          collectByTeam(args.team_id),
          collectByAssignee(String(userId)),
        ]);
        for (const t of teamTasks) pushUnique(t);

        // Also rescue orphan tasks (no team_id) assigned to me — CLI-created
        // tasks that never got a team would otherwise be invisible in every
        // view. Do NOT pull in tasks belonging to *other* teams: a task whose
        // team_id is set to another team must not leak into this team's list.
        for (const t of assignedTasks) {
          if (!t.team_id || String(t.team_id) === String(args.team_id)) pushUnique(t);
        }
      } else if (args.workspace === "all") {
        // GLOBAL VIEW: every team the user belongs to + personal tasks
        // (creator or assignee with no team). Used by the client to keep
        // the inbox store warm for cross-team mention search.
        const memberships = await ctx.db
          .query("team_memberships")
          .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
          .collect();
        const [teamLists, userTasks, assignedTasks] = await Promise.all([
          Promise.all(memberships.map((m) => collectByTeam(m.team_id))),
          collectByUser(userId),
          collectByAssignee(String(userId)),
        ]);
        for (const teamTasks of teamLists) {
          for (const t of teamTasks) pushUnique(t);
        }
        for (const t of userTasks) pushUnique(t);
        for (const t of assignedTasks) pushUnique(t);
      } else if (args.workspace === "personal") {
        // PERSONAL VIEW: tasks with no team_id that are mine — either as
        // creator OR assignee. Without the assignee union, a task assigned
        // to me by someone else (e.g. an ops bot) with no team_id is
        // invisible in every view.
        const [userTasks, assignedTasks] = await Promise.all([
          collectByUser(userId),
          collectByAssignee(String(userId)),
        ]);
        for (const t of userTasks) {
          if (!t.team_id) pushUnique(t);
        }
        for (const t of assignedTasks) {
          if (!t.team_id) pushUnique(t);
        }
      } else {
        // UNSCOPED: all user's tasks (creator or assignee).
        const [userTasks, assignedTasks] = await Promise.all([
          collectByUser(userId),
          collectByAssignee(String(userId)),
        ]);
        for (const t of userTasks) pushUnique(t);
        for (const t of assignedTasks) pushUnique(t);
      }
      tasks = allTasks;
    }
    if (args.project_path) {
      tasks = scopeByProject(tasks, args.project_path);
    }

    // Status filtering (supports comma-separated values from frontend)
    if (args.status) {
      const statusSet = new Set(args.status.split(","));
      tasks = tasks.filter((t: any) => statusSet.has(t.status));
    }

    if (args.triage_status) {
      tasks = tasks.filter((t: any) => t.triage_status === args.triage_status);
    } else if (!args.include_derived) {
      tasks = tasks.filter((t: any) => !t.triage_status || t.triage_status === "active");
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

    // Return ALL tasks — no server-side pagination.
    // Client-side filtering handles everything; we never want to silently drop items.
    const result = tasks;

    // Compute the delta cursor from the *unfiltered* row set so the next
    // subscription doesn't keep re-fetching rows the local filters dropped.
    // For full-snapshot mode (no `since`) cursor still reflects the newest
    // row seen, so the next page can switch to delta cleanly.
    let cursor = since ?? 0;
    for (const t of tasks) {
      if (typeof t.updated_at === "number" && t.updated_at > cursor) cursor = t.updated_at;
    }

    await enrichTasks(ctx, userId, result);
    return { items: result, hasMore: false, cursor, isDelta };
  },
});

// Change-feed batch fetch: current state for a set of task ids the user can
// access (own or team). Same enriched row shape as webList (reuses enrichTasks),
// so the client merges via syncTable("tasks"). No status filter — a dropped task
// comes back with status:"dropped" and the client's read-time filter hides it.
// Inaccessible / gone ids are omitted; the feed drives the prune. See changeFeed.ts.
export const webGetByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { items: [] };
    const result: any[] = [];
    for (const raw of args.ids.slice(0, 300)) {
      const id = ctx.db.normalizeId("tasks", raw);
      if (!id) continue;
      const task = await ctx.db.get(id);
      if (!task || !(await canAccessTask(ctx, userId, task))) continue;
      result.push(task);
    }
    await enrichTasks(ctx, userId, result);
    return { items: result };
  },
});

// Full, uncapped task loader — paginated so the client can crawl EVERY task in
// a workspace into its store without the 96 MiB isolate OOM that an unbounded
// collect triggers (TooMuchMemoryCarryOver). webList caps the live snapshot at
// the 300 most-recently-updated rows; on a busy team that window is entirely
// consumed by recently-dropped tasks, hiding cold open tasks (e.g. ones assigned
// to teammates) forever — there was no "load more". This query is the load-more:
// the client (useSyncTasks) pages through it one-shot (NOT a live subscription),
// pacing the crawl, and surfaces a visible "loading all tasks" state.
//
// Soft-deleted (status="dropped") rows are excluded — they are deletions the UI
// never renders; loading thousands of them would only waste pages and store.
// Scoping mirrors webList: team view → all team tasks; personal/unscoped → mine.
export const webListPaginated = query({
  args: {
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"), v.literal("all"))),
    team_id: v.optional(v.id("teams")),
    project_path: v.optional(v.string()),
    include_derived: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
    // Incremental top-up: when set, only page rows with updated_at > since. The
    // client passes its persisted watermark so a periodic reconcile re-crawls a
    // handful of changed rows instead of the whole table (the "syncing 4,529"
    // every few minutes). Omitted on the FIRST crawl for a workspace (cold cache)
    // so that initial pass is a full backfill. Mirrors webList's `since` delta.
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    if (args.team_id) await requireTeamMembership(ctx, userId, args.team_id);
    if (args.workspace === "team" && !args.team_id) {
      throw new Error("team_id is required for the team workspace");
    }

    // Defensive clamp. Task docs are small (~2 KB avg, ~8 KB max observed), so
    // 1000/page is ~16 MB worst case — still well under the 64 MB query memory cap
    // — but cap it so a future task with a huge body can't blow the isolate
    // mid-crawl. Bigger pages = fewer round trips = a faster cold-cache backfill.
    const paginationOpts = {
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, 1000),
    };

    const since = args.since;
    const isDelta = since !== undefined;

    // Primary stream: newest-updated first, scoped to the workspace. Team view
    // reads by_team_updated so EVERY team task (any assignee, any age) is
    // reachable across pages — the whole point of the fix. In delta mode the
    // index range is bounded to updated_at > since (only changed rows), so a
    // top-up crawl is cheap regardless of how big the table is.
    const range = (q: any) => (isDelta ? q.gt("updated_at", since!) : q);
    const base = (args.workspace === "team" && args.team_id)
      ? ctx.db.query("tasks").withIndex("by_team_updated", (q: any) => range(q.eq("team_id", args.team_id))).order("desc")
      : ctx.db.query("tasks").withIndex("by_user_updated", (q: any) => range(q.eq("user_id", userId))).order("desc");

    const result = await base.paginate(paginationOpts);

    // Full backfill skips the dropped graveyard (never load thousands of dead
    // rows). A delta pass KEEPS dropped rows: a task dropped on another device
    // must flow through as a status="dropped" overlay so this client's read-time
    // filter hides it — otherwise it would linger in the cache forever.
    let rows = isDelta ? result.page : result.page.filter((t: any) => t.status !== "dropped");
    if (args.project_path) rows = scopeByProject(rows, args.project_path);
    await enrichTasks(ctx, userId, rows);

    return { page: rows, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

// Companion to webList: the dormant origin-session badge data ("who · when" on
// a task row's session pill). The client calls this ONE-SHOT (convex.query, not
// a subscription) for conversation ids referenced by its task rows: a dormant
// session's badge fields don't change, and a live one is covered by the
// webActiveSessions overlay — so subscribing would only re-run a query per
// message written to any referenced conversation, which is exactly the churn
// enrichTasks used to inflict on webList. Access mirrors canAccessConversation;
// ids the caller can't see are omitted.
//
// Returns: { [conversationId]: { conversation_id, session_id, title?, agent_type?, started_by?, last_message_at?, message_count? } }
export const webTaskOrigins = query({
  args: { conversation_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return {};
    const out: Record<string, any> = {};
    const nameCache = new Map<string, string | undefined>();
    const ownerName = async (uid: any): Promise<string | undefined> => {
      const key = uid.toString();
      if (nameCache.has(key)) return nameCache.get(key);
      let name: string | undefined;
      try { const u = await ctx.db.get(uid as Id<"users">); name = u ? (u.name || u.email || undefined) : undefined; } catch {}
      nameCache.set(key, name);
      return name;
    };
    await Promise.all(args.conversation_ids.slice(0, 300).map(async (raw) => {
      const id = ctx.db.normalizeId("conversations", raw);
      if (!id) return;
      const c = await ctx.db.get(id);
      if (!c || !c.session_id) return;
      if (!(await canAccessConversation(ctx, userId, c as any))) return;
      out[raw] = {
        conversation_id: raw,
        session_id: c.session_id,
        title: c.title || undefined,
        agent_type: c.agent_type || undefined,
        started_by: await ownerName(c.user_id),
        last_message_at: c.updated_at,
        message_count: c.message_count,
      };
    }));
    return out;
  },
});

// Companion to webList: the live-session overlay for the task list. Tiny
// payload, but invalidates on every daemon heartbeat — keep it separate from
// webList so the 13MB task payload doesn't re-ship on every heartbeat.
//
// Returns: { [taskId]: { _id, session_id, title?, agent_status?, agent_type?, started_by?, last_message_at? } }
export const webActiveSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return {};

    const now = Date.now();
    const HEARTBEAT_ALIVE_MS = 90 * 1000;
    const managedSessions = await ctx.db
      .query("managed_sessions")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    // started_by = the session owner's display name, last_message_at =
    // conv.updated_at (bumped on every message). Together the badge reads
    // "who · when" ("ashot · now"), consistent with the dormant origin badge.
    // Owner names are cached since this overlay is scoped to the viewer's own
    // daemons — typically one or two distinct users.
    const nameCache = new Map<string, string | undefined>();
    const ownerName = async (uid: any): Promise<string | undefined> => {
      const key = uid.toString();
      if (nameCache.has(key)) return nameCache.get(key);
      let name: string | undefined;
      try { const u = await ctx.db.get(uid as Id<"users">); name = u ? (u.name || u.email || undefined) : undefined; } catch {}
      nameCache.set(key, name);
      return name;
    };

    const map: Record<string, { _id: string; session_id: string; title?: string; agent_status?: string; agent_type?: string; started_by?: string; last_message_at?: number }> = {};
    for (const s of managedSessions) {
      if (now - s.last_heartbeat >= HEARTBEAT_ALIVE_MS) continue;
      if (!s.conversation_id) continue;
      const conv = await ctx.db.get(s.conversation_id);
      if (!conv || !(await canAccessConversation(ctx, userId, conv)) || !conv.active_task_id) continue;
      const task = await ctx.db.get(conv.active_task_id);
      if (
        !task
        || !workspacesMatch(workspaceForConversation(conv), workspaceForResource(task))
        || !(await canAccessTask(ctx, userId, task))
      ) continue;
      map[conv.active_task_id.toString()] = {
        _id: conv._id.toString(),
        session_id: conv.session_id,
        title: conv.title || undefined,
        agent_status: s.agent_status || undefined,
        agent_type: conv.agent_type || undefined,
        started_by: await ownerName(conv.user_id),
        last_message_at: conv.updated_at,
      };
    }
    return map;
  },
});

// Compact projection of tasks for mention/@-search store sync. Returns only
// the fields needed to render and filter in the dropdown — orders of magnitude
// smaller than `webList`, which enriches with creator/plan/active-session data.
export const webMentionList = query({
  args: {
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"), v.literal("all"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (args.team_id) await requireTeamMembership(ctx, userId, args.team_id);
    if (args.workspace === "team" && !args.team_id) {
      throw new Error("team_id is required for the team workspace");
    }

    // Cap to a small recent slice — the mention dropdown only renders ~6–12
    // results (top-6-per-type in useMentionQuery), and the long tail is served
    // by `mentionSearch`. `.take()` loads whole rows, so a small cap keeps the
    // scan well under both the 8192-array return limit and the 64 MB isolate
    // memory cap (see docs.webMentionList). Per-team cap keeps any single
    // high-volume team from crowding out smaller teams the user belongs to.
    const MAX_TOTAL = 50;
    const MAX_PER_TEAM = 25;
    const seen = new Set<string>();
    const tasks: any[] = [];
    const pushUnique = (t: any) => {
      if (tasks.length >= MAX_TOTAL) return;
      const id = String(t._id);
      if (!seen.has(id)) { seen.add(id); tasks.push(t); }
    };

    if (args.workspace === "all") {
      const memberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .collect();
      for (const m of memberships) {
        const teamTasks = await ctx.db
          .query("tasks")
          .withIndex("by_team_id", (q: any) => q.eq("team_id", m.team_id))
          .order("desc")
          .take(MAX_PER_TEAM);
        for (const t of teamTasks) pushUnique(t);
        if (tasks.length >= MAX_TOTAL) break;
      }
      if (tasks.length < MAX_TOTAL) {
        const userTasks = await ctx.db
          .query("tasks")
          .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
          .order("desc")
          .take(MAX_PER_TEAM);
        for (const t of userTasks) pushUnique(t);
      }
    } else if (args.workspace === "team" && args.team_id) {
      const teamTasks = await ctx.db
        .query("tasks")
        .withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id))
        .order("desc")
        .take(MAX_TOTAL);
      for (const t of teamTasks) pushUnique(t);
    } else {
      const userTasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .order("desc")
        .take(MAX_TOTAL);
      for (const t of userTasks) {
        if (args.workspace === "personal" && t.team_id) continue;
        pushUnique(t);
      }
    }

    return {
      items: tasks.map((t: any) => ({
        _id: String(t._id),
        title: t.title,
        short_id: t.short_id,
        status: t.status,
        priority: t.priority,
        updated_at: t.updated_at,
        team_id: t.team_id ?? null,
        user_id: t.user_id ?? null,
      })),
    };
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
      // ids arrive from clickable pills/links embedded in untrusted message and
      // doc content; a malformed or cross-table id would make ctx.db.get throw
      // ("Invalid ID length") and crash the page. normalizeId returns null for
      // anything that isn't a tasks id, so we degrade to "not found". (Mirrors
      // docs.webGet.)
      const taskId = ctx.db.normalizeId("tasks", args.id);
      task = taskId ? await ctx.db.get(taskId) : null;
    }

    if (!task || !(await canAccessTask(ctx, userId, task))) return null;

    const comments = await ctx.db
      .query("task_comments")
      .withIndex("by_task_id", (q) => q.eq("task_id", task!._id))
      .collect();

    let plan = null;
    if (task.plan_id) {
      const p = await ctx.db.get(task.plan_id);
      if (
        p
        && isSameWorkspace(p, workspaceForResource(task))
        && (await canAccessPlan(ctx, userId, p))
      ) {
        plan = { _id: p._id, short_id: p.short_id, title: p.title, status: p.status };
      }
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
    project_path: v.optional(v.string()),
    execution_status: v.optional(v.string()),
    triage_status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    assertValidTaskStatus(args.status);

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
    if (args.project_id !== undefined) {
      if (!args.project_id) {
        updates.project_id = undefined;
      } else {
        const projectId = ctx.db.normalizeId("projects", args.project_id);
        if (!projectId) notFound("Project not found");
        const project = await requireAccessibleProject(ctx, userId, projectId);
        const taskWorkspace = task.team_id
          ? { type: "team" as const, teamId: task.team_id }
          : { type: "personal" as const, userId: task.user_id };
        requireSameWorkspace(project, taskWorkspace, "project");
        updates.project_id = projectId;
      }
    }
    if (args.project_path !== undefined) updates.project_path = args.project_path || undefined;
    if (args.execution_status !== undefined) updates.execution_status = args.execution_status || undefined;
    if (args.triage_status) {
      updates.triage_status = args.triage_status;
      if (args.triage_status === "active") updates.promoted = true;
    }

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

    if (args.status && args.status !== task.status) {
      if (task.plan_id) {
        await recalcPlanProgress(ctx, task.plan_id, task._id, args.status);
      }
      await notifySubscribers(ctx, "task_status_changed", userId, task as any, `changed ${task.short_id} to ${args.status}`);
    }
    if (args.assignee !== undefined && resolvedAssignee !== task.assignee) {
      const assigneeUserId = resolvedAssignee === userId?.toString()
        ? userId
        : await resolveAssigneeToUserId(ctx, resolvedAssignee || "", task.team_id);
      if (assigneeUserId && assigneeUserId.toString() !== userId.toString()) {
        await subscribeUser(ctx, assigneeUserId, task._id, "assignee");
        await ctx.runMutation(internal.notificationRouter.emit, {
          event_type: "task_assigned",
          actor_user_id: userId,
          entity_type: "task",
          entity_id: task._id.toString(),
          message: `assigned you to ${task.short_id}: ${task.title}`,
          direct_recipient_id: assigneeUserId,
        });
      }
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

    await subscribeUser(ctx, userId, task._id, "commenter");
    await notifySubscribers(ctx, "task_commented", userId, task as any, `commented on ${task.short_id}: ${args.text.slice(0, 100)}`);

    return { success: true };
  },
});

export const assignToAgent = mutation({
  args: {
    short_id: v.string(),
    agent_type: v.union(v.literal("claude_code"), v.literal("codex"), v.literal("cursor"), v.literal("gemini"), v.literal("opencode"), v.literal("pi")),
    // Optional lead-in the user types before launch (defaults to "lets do this
    // task" in the palette). Prepended to the structured task prompt below.
    initial_message: v.optional(v.string()),
  },
  handler: async (ctx, { short_id, agent_type, initial_message }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
      .first();
    if (!task) throw new Error("Task not found");
    // Allow the task's creator OR any member of its team — matches the access
    // check in dispatch.createSession. Without the team clause, "start agent run"
    // on a shared team task is silently rejected as Unauthorized.
    const hasAccess = task.user_id.toString() === userId.toString()
      || (task.team_id && !!(await ctx.db
          .query("team_memberships")
          .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", task.team_id))
          .first()));
    if (!hasAccess) throw new Error("Unauthorized");

    const now = Date.now();
    const sessionId = crypto.randomUUID();

    let workerPlanId: Id<"plans"> | undefined;
    if ((task as any).plan_id) {
      const plan = await ctx.db.get((task as any).plan_id as Id<"plans">);
      if (
        plan
        && isSameWorkspace(plan, workspaceForResource(task))
        && (await canAccessPlan(ctx, userId, plan))
      ) {
        workerPlanId = plan._id;
      }
    }
    const parentConversationId = await resolveWorkerParentConversation(ctx, userId, workerPlanId);

    // Without a project_path the daemon has nowhere to launch the session, so the
    // run silently never starts. Resolve it (and git_root/remote) from the task
    // the same way dispatch.createSession does.
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const { project_path, git_root, git_remote_url } = await resolveTaskGitContext(ctx, userId, task, mappings);

    // Team/privacy come from the launcher's directory mappings, exactly like
    // dispatch.createSession (the sibling launch path) — the task's team is
    // only a routing fallback. A literal is_private here once minted
    // "shared with nobody" rows: non-private but teamless, invisible to every
    // teammate because the visibility gates short-circuit on !team_id.
    const { teamId, isPrivate, autoShared } = resolveTeamForPath(
      mappings,
      git_root || project_path,
      task.team_id
    );

    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      agent_type,
      session_id: sessionId,
      project_path,
      git_root,
      ...(git_remote_url ? { git_remote_url } : {}),
      started_at: now,
      updated_at: now,
      message_count: 0,
      status: "active",
      team_id: teamId,
      is_private: isPrivate,
      auto_shared: autoShared || undefined,
      active_task_id: task._id,
      title: task.title.slice(0, 80),
      // Stamp the plan so the inbox can group plan workers even when there's no
      // viable parent session to nest under (the grouping fallback).
      ...(workerPlanId ? { active_plan_id: workerPlanId } : {}),
      ...(parentConversationId
        ? { parent_conversation_id: parentConversationId, is_subagent: true }
        : {}),
    } as any);
    await ctx.db.patch(conversationId, { short_id: conversationId.toString().slice(0, 7) } as any);

    // Link the new session to the task so it counts as a linked conversation —
    // drives session_count, origin_session, and the "Has session" filter.
    // Mirrors dispatch.createSession, which links the conversation before
    // binding active_task_id. Without this an agent-run task shows a live
    // session pill (from active_task_id) while session_count stays 0, so it
    // wrongly drops out of the "Has session" filter.
    const existingConvIds = task.conversation_ids || [];
    if (!existingConvIds.some((id: any) => id.toString() === conversationId.toString())) {
      await ctx.db.patch(task._id, { conversation_ids: [...existingConvIds, conversationId] } as any);
    }

    // NB: intentionally do NOT reassign the task to "agent" — the launcher stays
    // the owner. The active run is already conveyed by the task status and the
    // session linked via active_task_id, so clobbering assignee only lost the
    // human owner and dropped the task out of the launcher's "assigned to me" view.

    // Build minimal task prompt
    const lines = [`You have been assigned the following task:\n\n**${task.title}**`];
    if ((task as any).description) lines.push(`\n${(task as any).description}`);
    if ((task as any).acceptance_criteria?.length) {
      lines.push("\n**Acceptance criteria:**");
      (task as any).acceptance_criteria.forEach((c: string) => lines.push(`- ${c}`));
    }
    lines.push(`\nTask ID: ${task.short_id} · Priority: ${(task as any).priority || "medium"}`);

    // Lead with the user's instruction when supplied, then the task scaffold.
    const lead = initial_message?.trim();
    const content = lead ? `${lead}\n\n${lines.join("\n")}` : lines.join("\n");

    // Single canonical writer: stamps owner_user_id for the daemon's delivery poll and flips
    // has_pending_messages. The task session is the launcher's own, so owner == sender.
    const taskConversation = await ctx.db.get(conversationId);
    await enqueuePendingMessage(ctx, taskConversation, userId, { content });

    // fromConvexAgentType maps each convex spelling to its daemon client id —
    // opencode/pi are first-class and map to themselves; only unrecognized types
    // fall back to "claude" (identical to the old ternary for claude_code/codex/cursor/gemini).
    const daemonAgentType = fromConvexAgentType(agent_type);
    await enqueueStartSession(ctx, userId, {
      conversationId,
      agentType: daemonAgentType,
      projectPath: project_path || git_root,
      gitRoot: git_root,
      createdAt: now,
    });

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
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    // Workspace comes from the client's explicit picker or the directory
    // mapping — never from the user's active team. An unmapped project_path
    // with no explicit workspace lands personal ("Only Me"), matching sessions.
    const db = await createDataContext(ctx, { userId, workspace: args.workspace, team_id: args.team_id, project_path: args.project_path });

    let project_id: Id<"projects"> | undefined;
    if (args.project_id) {
      const pid = ctx.db.normalizeId("projects", args.project_id);
      if (!pid) notFound("Project not found");
      const project = await requireAccessibleProject(ctx, userId, pid);
      requireSameWorkspace(project, db.workspace, "project");
      project_id = pid;
    }

    let plan_id: Id<"plans"> | undefined;
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (!plan || !(await canAccessPlan(ctx, userId, plan))) notFound("Plan not found");
      requireSameWorkspace(plan, db.workspace, "plan");
      plan_id = plan._id;
    }

    const short_id = await nextShortId(ctx.db, "ct");

    let resolvedAssignee = args.assignee;
    if (resolvedAssignee === "me") {
      resolvedAssignee = userId.toString();
    } else if (resolvedAssignee && !resolvedAssignee.match(/^[a-z0-9]{32}$/)) {
      const lower = resolvedAssignee.toLowerCase();
      const found = await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", lower)).first();
      if (found) resolvedAssignee = found._id.toString();
    }

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
      tasks = tasks.filter((t: any) => !t.triage_status || t.triage_status === "active");
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

    if (args.team_id) await requireTeamMembership(ctx, userId, args.team_id);
    if (args.workspace === "team" && !args.team_id) {
      throw new Error("team_id is required for the team workspace");
    }

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, userId, task))) throw new Error("Task not found");

    await ctx.db.patch(task._id, { promoted: true, triage_status: "active" as const, updated_at: Date.now() });
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


export const backfillTriageStatus = internalMutation({
  args: {
    api_token: v.string(),
    cursor: v.optional(v.string()),
    batch_size: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const batchSize = args.batch_size || 100;
    let query = ctx.db.query("tasks");
    const tasks = await query.collect();

    let updated = 0;
    let skipped = 0;
    for (const t of tasks) {
      if ((t as any).triage_status) { skipped++; continue; }
      const status = (t.source === "human" || t.promoted) ? "active" : "suggested";
      await ctx.db.patch(t._id, { triage_status: status as any });
      updated++;
      if (updated >= batchSize) break;
    }

    return { updated, skipped, total: tasks.length, done: updated < batchSize };
  },
});

// Backfill: reset all insight-sourced tasks to triage_status "suggested"
// so they appear in the triage lightbulb, not the main "All" list.
export const backfillInsightTriageStatus = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tasks = await ctx.db.query("tasks").collect();
    let updated = 0;
    for (const t of tasks) {
      if (t.source !== "insight") continue;
      if ((t as any).triage_status === "suggested") continue;
      if ((t as any).triage_status === "dismissed") continue;
      await ctx.db.patch(t._id, { triage_status: "suggested" as any, promoted: false });
      updated++;
    }
    return { updated, total: tasks.length };
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
    assertValidTaskStatus(args.status);

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

      if (args.status !== task.status) {
        if (task.plan_id) affectedPlans.add(`${task.plan_id}:${task._id}:${args.status}`);
        await notifySubscribers(ctx, "task_status_changed", auth.userId, task as any, `changed ${task.short_id} to ${args.status}`);
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
    const resolvedAssignee = await resolveAssigneeStr(ctx, args.assignee, auth.userId) || args.assignee;
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

      if (resolvedAssignee !== task.assignee) {
        await ctx.db.insert("task_history", {
          task_id: task._id,
          user_id: auth.userId,
          actor_type: "user",
          action: "updated",
          field: "assignee",
          old_value: task.assignee || "",
          new_value: resolvedAssignee,
          created_at: now,
        });
      }

      await ctx.db.patch(task._id, { assignee: resolvedAssignee, updated_at: now });

      if (resolvedAssignee !== task.assignee) {
        const assigneeId = await resolveAssigneeToUserId(ctx, resolvedAssignee, task.team_id);
        if (assigneeId) {
          await subscribeUser(ctx, assigneeId, task._id, "assignee");
          await ctx.runMutation(internal.notificationRouter.emit, {
            event_type: "task_assigned",
            actor_user_id: auth.userId,
            entity_type: "task",
            entity_id: task._id.toString(),
            message: `assigned you to ${task.short_id}: ${task.title}`,
            direct_recipient_id: assigneeId,
          });
        }
      }

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
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) throw new Error("Task not found");

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
      if (!plan || !(await canAccessPlan(ctx, auth.userId, plan))) throw new Error("Plan not found");
      if (!plan.task_ids) return [];
      const planTasks: any[] = [];
      for (const tid of plan.task_ids) {
        const t = await ctx.db.get(tid);
        if (
          t
          && isSameWorkspace(t, workspaceForResource(plan))
          && (await canAccessTask(ctx, auth.userId, t))
        ) planTasks.push(t);
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
      if (t.triage_status && t.triage_status !== "active") return false;
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
    if (!root || !(await canAccessTask(ctx, auth.userId, root))) throw new Error("Task not found");

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
