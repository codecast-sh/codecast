import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { enqueueStartSession } from "./devices";
import { fromConvexAgentType } from "@codecast/shared/contracts";
import {
  MAX_TASK_DEPTH,
  TASK_STATUS_CATEGORIES,
  isActiveTask,
  isHumanOrigin,
  subtaskProgressOf,
  teamTaskStatuses,
} from "@codecast/shared/tasks";
import { Id } from "./_generated/dataModel";
import type { SubscriptionVia } from "./notificationRouter";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext, scopeByProject } from "./data";
import { nextShortId } from "./counters";
import { internal } from "./_generated/api";
import { isViableInboxParent } from "./inboxFilters";
import { listLiveManagedSessions } from "./lib/liveSessions";
import { attachCommentSessionInfo } from "./lib/commentSessionInfo";
import { pickInheritedGitMeta, type GitMetaSource } from "./projectPaths";
import { bucketTs } from "./presenceState";
import { enqueuePendingMessage } from "./pendingMessages";
import { linkConversationToEntityBestEffort } from "./conversationLinks";
import { dropThreadRead, taskThreadParticipants, touchThread } from "./threadReads";
import { resolveTeamForPath, teamVisibleConvTeam } from "./privacy";
// Owner-or-team access check for a task. Moved to lib/access.ts (Wave-1
// auth/access seam). Imported for local use here and re-exported so existing
// callers keep working unchanged.
import {
  type AuthorizedWorkspace,
  canAccessTask,
  canAccessConversation,
  canAccessDoc,
  canAccessPlan,
  canAccessProject,
  isSameWorkspace,
  requireAccessibleProject,
  requireSameWorkspace,
  requireTeamMembership,
  resolveSessionConversation,
  workspaceForConversation,
  workspaceForResource,
  workspacesMatch,
  visibleInTeamList,
} from "./lib/access";
import { forbidden, notFound } from "./lib/auth";
export { canAccessTask };

// The six status CATEGORIES (see @codecast/shared/tasks/statuses.ts). Teams
// refine them with named statuses; tasks.status always holds the category.
const VALID_TASK_STATUSES = TASK_STATUS_CATEGORIES;

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

  // A git_root that isn't an ancestor of the resolved project_path describes a
  // DIFFERENT repo — typically the viewer's currently-open conversation stamped
  // alongside a task-derived path. The daemon prefers git_root when picking a
  // cwd, so an unrelated root that happens to exist on the target machine would
  // launch the session in the wrong repo. Drop it; the project_path routes.
  if (git_root && project_path && project_path !== git_root && !project_path.startsWith(git_root.replace(/\/+$/, "") + "/")) {
    git_root = undefined;
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

// Resolve a status write against the team's configured statuses (Linear-style
// custom statuses; see @codecast/shared/tasks/statuses.ts).
//
// - `status_id` names a team status: it sets the category, and a `status` sent
//   alongside must agree (a mismatch is a client bug, not a preference).
//   The id is stored only when it refines the category default — a task on the
//   default needs no pointer to it.
// - `status_id: ""` clears the refinement (back to the category default).
// - a category-only write that CHANGES the category clears the refinement too:
//   the old id belongs to the old category and would lie about where the task
//   is. Same-category writes (e.g. `cast task start` on a task already
//   refined within in_progress) keep it.
//
// Returns the category to write (if any) and whether/what to write into
// status_id — `set` distinguishes "clear the field" from "leave it alone".
export async function resolveStatusWrite(
  ctx: any,
  teamId: Id<"teams"> | undefined | null,
  currentStatus: string | undefined,
  args: { status?: string; status_id?: string },
): Promise<{ status?: TaskStatus; statusId: { set: boolean; value?: string } }> {
  assertValidTaskStatus(args.status);
  let status = args.status;
  if (args.status_id) {
    const team = teamId ? await ctx.db.get(teamId) : null;
    const statuses = teamTaskStatuses(team?.task_statuses);
    const match = statuses.find((s: { id: string }) => s.id === args.status_id);
    if (!match) throw new Error(`Unknown status '${args.status_id}' for this team`);
    if (status && status !== match.category) {
      throw new Error(`Status '${args.status_id}' is in category '${match.category}', not '${status}'`);
    }
    status = match.category;
    return { status, statusId: { set: true, value: match.id === match.category ? undefined : match.id } };
  }
  if (args.status_id === "" || (status && status !== currentStatus)) {
    return { status, statusId: { set: true, value: undefined } };
  }
  return { status, statusId: { set: false } };
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

// `via` says who performed the enrolling act. Agents run under the owner's
// token, so identity alone cannot tell a person's act from an agent's; every
// caller states it. The rule for CLI mutations: a conversation_id on the
// call means an agent inside a session; none means a person at the terminal.
export async function subscribeUser(
  ctx: any,
  userId: Id<"users">,
  taskId: Id<"tasks">,
  reason: "creator" | "assignee" | "commenter" | "mentioned" | "watching",
  via: SubscriptionVia,
) {
  await ctx.runMutation(internal.notificationRouter.ensureSubscribed, {
    user_id: userId,
    entity_type: "task",
    entity_id: taskId.toString(),
    reason,
    via,
  });
}

// Actor kind for a CLI mutation: see subscribeUser.
function cliVia(args: { conversation_id?: string }): SubscriptionVia {
  return args.conversation_id ? "agent" : "human";
}

// Assigning a task to someone ELSE is a handoff: the assigner's thread leaves
// their inbox and stays out. The mute is the durable marker — it denies every
// membership leg until re-engagement clears it (being assigned back, being
// mentioned, or a human act of one's own; see ensureSubscribed) — and the
// thread_reads drop clears the card now. Callers gate on a HUMAN act: an
// agent assigning under its owner's token must not silently unfollow the
// owner. Assigning to an agent label (no user id) hands the stream to nobody,
// so the assigner keeps their follow.
async function handoffTaskThread(
  ctx: any,
  taskId: Id<"tasks">,
  actorId: Id<"users">,
  assigneeUserId: Id<"users"> | null | undefined,
) {
  if (!assigneeUserId || String(assigneeUserId) === String(actorId)) return;
  await ctx.runMutation(internal.notificationRouter.setSubscriptionMuted, {
    user_id: actorId,
    entity_type: "task",
    entity_id: taskId.toString(),
    muted: true,
  });
  await dropThreadRead(ctx, actorId, "task", String(taskId));
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
    // Subtasks never count toward plan progress — the parent is the plan's
    // unit of work. New subtasks are kept out of task_ids at create time; this
    // guard also excludes any that landed there before that rule existed, so
    // one agent decomposition can never inflate a plan bar or auto-close it.
    if (t && !t.parent_id && isSameWorkspace(t, workspaceForResource(plan))) {
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

/**
 * Keep plan.task_ids honest when a task's subtask-ness changes (reparent or
 * detach). A subtask is never in task_ids (the parent is the plan's unit of
 * work); a top-level task with a plan always is. Called after the parent_id
 * patch, with the FINAL parent state. Recalcs plan progress so the bar and the
 * auto-done flag never drift off a stale total.
 */
async function reconcilePlanMembership(
  ctx: any,
  taskId: Id<"tasks">,
  planId: Id<"plans"> | undefined,
  nowSubtask: boolean,
) {
  if (!planId) return;
  const plan: any = await ctx.db.get(planId);
  if (!plan) return;
  const ids: any[] = plan.task_ids || [];
  const has = ids.some((id: any) => String(id) === String(taskId));
  const nextIds = nowSubtask
    ? ids.filter((id: any) => String(id) !== String(taskId))
    : (has ? ids : [...ids, taskId]);

  // Recompute progress directly over the final membership: recalcPlanProgress
  // early-returns for a task that just LEFT task_ids, so it can't be reused for
  // a removal. Subtasks are excluded (the parent is the plan's unit of work),
  // matching recalcPlanProgress / plans.recalcProgress.
  let total = 0, done = 0, in_progress = 0, open = 0;
  const scope = workspaceForResource(plan);
  for (const tid of nextIds) {
    const t: any = await ctx.db.get(tid);
    if (!t || t.status === "dropped" || t.parent_id || !isSameWorkspace(t, scope)) continue;
    total++;
    if (t.status === "done") done++;
    else if (t.status === "in_progress" || t.status === "in_review") in_progress++;
    else if (t.status === "open" || t.status === "backlog") open++;
  }
  const updates: any = { task_ids: nextIds, progress: { total, done, in_progress, open }, updated_at: Date.now() };
  if (total > 0 && done === total && plan.status !== "done") updates.status = "done";
  await ctx.db.patch(planId, updates);
}

// ---------------------------------------------------------------------------
// Subtasks (tasks.parent_id)
//
// The column and the by_parent_id index shipped long ago but nothing ever
// resolved or validated a parent: `create` wrote `args.parent_id as any`, so a
// caller passing a short id wrote a string into an Id("tasks") field and the
// insert failed its validator. These helpers are the single entry point for
// setting a parent, from every surface (CLI create/update, web create/update).
//
// Three rules, all enforced here:
//   1. The parent must be a task the caller can access.
//   2. Parent and child live in the SAME workspace — a nesting edge is a
//      relationship, and relationships never join two authorization domains
//      (the same rule addDep applies to blocked_by/blocks).
//   3. No cycles. The chain is walked upward from the proposed parent; if the
//      child appears in it, the move is refused.
// ---------------------------------------------------------------------------

// Ancestor walks are bounded so a pre-existing cycle (or a pathological chain)
// can never spin a mutation until the isolate is killed.
export const MAX_TASK_ANCESTOR_WALK = 64;

/** A task's ancestors, nearest first. Stops at the root, a cycle, or the cap. */
export async function taskAncestorIds(ctx: any, task: { parent_id?: Id<"tasks"> }): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: Id<"tasks"> | undefined = task.parent_id;
  for (let i = 0; cursor && i < MAX_TASK_ANCESTOR_WALK; i++) {
    const key = String(cursor);
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(key);
    const parent: any = await ctx.db.get(cursor);
    if (!parent) break;
    cursor = parent.parent_id;
  }
  return chain;
}

/**
 * Resolve a parent reference (short id like "ct-42278", or a raw task id) into
 * a parent document, enforcing access, workspace containment and acyclicity.
 * `child` is the task being reparented — omitted at create time, when there is
 * no row yet and therefore no cycle to close.
 */
export async function resolveParentTask(
  ctx: any,
  userId: Id<"users">,
  ref: string,
  opts: { workspace: any; child?: { _id: Id<"tasks">; short_id: string } },
): Promise<any> {
  const parent = await ctx.db
    .query("tasks")
    .withIndex("by_short_id", (q: any) => q.eq("short_id", ref))
    .first()
    ?? await (async () => {
      const id = ctx.db.normalizeId("tasks", ref);
      return id ? await ctx.db.get(id) : null;
    })();
  if (!parent || !(await canAccessTask(ctx, userId, parent))) notFound("Parent task not found");
  requireSameWorkspace(parent, opts.workspace, "parent task");

  const ancestors = await taskAncestorIds(ctx, parent);
  if (opts.child) {
    if (String(parent._id) === String(opts.child._id)) {
      throw new Error("A task cannot be its own parent");
    }
    if (ancestors.includes(String(opts.child._id))) {
      throw new Error(`Cycle: ${parent.short_id} is already below ${opts.child.short_id}`);
    }
  }

  // Depth is a product cap, not just a render clamp: the views emphasise the
  // top levels, so writes deeper than the UI can express are refused with
  // advice instead of silently flattening on screen. Re-parenting a task that
  // has its own subtree must fit the whole subtree under the cap.
  const childHeight = opts.child ? await taskSubtreeHeight(ctx, opts.child._id) : 0;
  const newDepth = ancestors.length + 1 + childHeight;
  if (newDepth > MAX_TASK_DEPTH) {
    throw new Error(
      `Too deep: ${parent.short_id} sits ${ancestors.length} level(s) down and the move needs ${newDepth} (max ${MAX_TASK_DEPTH}). ` +
      `Nest under a higher-level task, or promote this work to a plan.`,
    );
  }
  return parent;
}

/**
 * Height of a task's subtree: 0 for a leaf, 1 with children, 2 with
 * grandchildren. Only the depth cap needs this, and the cap is tiny
 * (MAX_TASK_DEPTH), so we stop descending once height already exceeds it —
 * that both bounds the walk and avoids the pathological-fan-out miscount where
 * a node budget could exit mid-level and under-report height (letting a move
 * slip past the cap). Returns Infinity if a level can't be fully expanded
 * within the budget, so resolveParentTask refuses rather than guesses.
 */
async function taskSubtreeHeight(ctx: any, taskId: Id<"tasks">, maxNodes = 2000): Promise<number> {
  let height = 0;
  let frontier: Id<"tasks">[] = [taskId];
  let visited = 0;
  while (frontier.length > 0) {
    const next: Id<"tasks">[] = [];
    for (const id of frontier) {
      if (visited >= maxNodes) return Infinity; // budget exhausted mid-level → unknown, refuse
      const children = await ctx.db
        .query("tasks")
        .withIndex("by_parent_id", (q: any) => q.eq("parent_id", id))
        .collect();
      visited += children.length;
      for (const c of children) next.push(c._id);
    }
    if (next.length === 0) break;
    height += 1;
    if (height > MAX_TASK_DEPTH) return height; // already too deep; no need to descend further
    frontier = next;
  }
  return height;
}

// ---------------------------------------------------------------------------
// Close-guard + start rollup: the two status rules every write surface shares.
// ---------------------------------------------------------------------------

/** Direct children still open (active and unfinished). */
async function openDirectSubtasks(ctx: any, taskId: Id<"tasks">): Promise<any[]> {
  const children = await ctx.db
    .query("tasks")
    .withIndex("by_parent_id", (q: any) => q.eq("parent_id", taskId))
    .collect();
  return children.filter((c: any) => isActiveTask(c) && c.status !== "done" && c.status !== "dropped");
}

/**
 * The close-guard (never auto-close): moving a parent to done/dropped with
 * open subtasks is refused unless the caller resolves it — "cascade" closes
 * the open subtree with the parent, "only_parent" closes just the parent and
 * leaves the children where they are. Lives in the mutation path so the CLI
 * (`cast task done --cascade | --only-parent`) and every web surface hit the
 * same rule; the web dialog is just one client of this refusal.
 * Returns the ids to cascade-close alongside the parent.
 */
export async function guardParentClose(
  ctx: any,
  task: any,
  newStatus: string | undefined,
  resolution: string | undefined,
): Promise<Id<"tasks">[]> {
  if (newStatus !== "done" && newStatus !== "dropped") return [];
  const open = await openDirectSubtasks(ctx, task._id);
  if (open.length === 0 || resolution === "only_parent") return [];
  if (resolution === "cascade") {
    const out: Id<"tasks">[] = [];
    const queue = [...open];
    let guard = 0;
    while (queue.length > 0 && guard++ < 500) {
      const cur: any = queue.shift();
      out.push(cur._id);
      queue.push(...(await openDirectSubtasks(ctx, cur._id)));
    }
    return out;
  }
  const ids = open.map((c: any) => c.short_id).join(", ");
  throw new Error(
    `${task.short_id} has ${open.length} open subtask${open.length === 1 ? "" : "s"} (${ids}). ` +
    `Close them first, or pass --cascade to close them too, or --only-parent to close just this task.`,
  );
}

/**
 * Cascade-close the subtree ids guardParentClose returned. `parent` scopes the
 * writes: only same-workspace descendants are touched (a pre-guard row could
 * carry a cross-workspace edge — `create` once wrote parent_id raw — and a
 * user must not close another workspace's task through --cascade). Each closed
 * child also releases any session bound to it, matching the single-task path.
 */
async function cascadeClose(ctx: any, ids: Id<"tasks">[], newStatus: string, userId: Id<"users">, parent: any) {
  const now = Date.now();
  const scope = workspaceForResource(parent);
  for (const id of ids) {
    const t: any = await ctx.db.get(id);
    if (!t || !isSameWorkspace(t, scope)) continue;
    // status_id cleared: the cascade moves the subtree to a terminal category,
    // so any custom-status refinement from the old category is stale.
    await ctx.db.patch(id, { status: newStatus, status_id: undefined, closed_at: now, updated_at: now });
    // Release a session bound to this child so it isn't stuck on a closed task.
    for (const convId of t.conversation_ids ?? []) {
      const conv: any = await ctx.db.get(convId);
      if (conv && conv.active_task_id && String(conv.active_task_id) === String(id)) {
        await ctx.db.patch(convId, { active_task_id: undefined });
      }
    }
    await ctx.db.insert("task_history", {
      task_id: id,
      user_id: userId,
      actor_type: "system" as const,
      action: "updated",
      field: "status",
      old_value: t.status,
      new_value: newStatus,
      created_at: now,
    });
  }
}

/**
 * One-way honesty rollup: the first subtask entering in_progress/in_review
 * flips an open/backlog ancestor chain to in_progress, so a parent never sits
 * "open" while work visibly advances under it. Never runs the other way and
 * never closes anything.
 */
async function rollUpParentStart(ctx: any, task: any, newStatus: string | undefined) {
  if (newStatus !== "in_progress" && newStatus !== "in_review") return;
  const now = Date.now();
  let cursor: Id<"tasks"> | undefined = task.parent_id;
  for (let hops = 0; cursor && hops < MAX_TASK_ANCESTOR_WALK; hops++) {
    const parent: any = await ctx.db.get(cursor);
    if (!parent) break;
    if (parent.status !== "open" && parent.status !== "backlog") break;
    await ctx.db.patch(parent._id, {
      status: "in_progress",
      // The old refinement belonged to the open/backlog category; stale now.
      status_id: undefined,
      updated_at: now,
      last_attempted_at: now,
      attempt_count: (parent.attempt_count || 0) + 1,
    });
    await ctx.db.insert("task_history", {
      task_id: parent._id,
      user_id: task.user_id,
      actor_type: "system" as const,
      action: "updated",
      field: "status",
      old_value: parent.status,
      new_value: "in_progress",
      created_at: now,
    });
    // A top-level parent may sit on a plan; keep the plan bar honest.
    if (parent.plan_id && !parent.parent_id) {
      await recalcPlanProgress(ctx, parent.plan_id, parent._id, "in_progress");
    }
    cursor = parent.parent_id;
  }
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
    // Agent-created tasks are internal by default; promoted:true puts the task
    // on the human's default board (same field the triage promote flow sets).
    promoted: v.optional(v.boolean()),
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
      // Unresolvable session ref = create the task without the link, never
      // reject the create (see resolveSessionConversation).
      const conv = await resolveSessionConversation(ctx, auth.userId, args.conversation_id);
      if (conv) {
        conversation_ids = [conv._id];
        created_from_conversation = conv._id;
        // Only team-visible conversations hand their team to the task — a
        // private session's team_id is routing, and copying it here would make
        // the task readable by the whole team (see teamVisibleConvTeam).
        convTeamId = teamVisibleConvTeam(conv);
      }
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

    // Subtask: `--parent ct-123`. Resolved (not written raw) so the stored
    // value is a real task id in this workspace — see resolveParentTask.
    // Decomposition stays inside the parent's container: a subtask created
    // without an explicit plan/project inherits the parent's.
    let parent_id: Id<"tasks"> | undefined;
    if (args.parent_id) {
      const parent = await resolveParentTask(ctx, auth.userId, args.parent_id, { workspace: db.workspace });
      parent_id = parent._id;
      if (!plan_id && parent.plan_id) plan_id = parent.plan_id;
      if (!project_id && parent.project_id) project_id = parent.project_id;
    }

    const resolvedAssignee = await resolveAssigneeStr(ctx, args.assignee, auth.userId);

    const id = await db.insert("tasks", {
      project_id,
      parent_id,
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
      promoted: args.promoted || undefined,
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

    for (const dep of args.blocked_by || []) {
      await patchDepMirror(ctx, auth.userId, { short_id, workspace: db.workspace }, dep, "blocks", "add");
    }

    // Subtasks carry plan_id for context but never join plan.task_ids — the
    // parent is the plan's unit of progress, so a decomposition can't inflate
    // the plan bar or flip its auto-done.
    if (plan_id && !parent_id) {
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

    // Creator enrollment is human only when a person decided the task: human
    // or meeting origin, or an explicit promotion to the human board. An
    // agent's own work task enrolls its owner as an agent act.
    const createdHuman = isHumanOrigin({ source: args.source || "human" }) || !!args.promoted;
    await subscribeUser(ctx, auth.userId, id, "creator", createdHuman ? "human" : "agent");
    // A subtask created directly in progress flips its parent chain, same as a
    // later start would — the parent must never sit "open" under running work.
    if (parent_id) {
      await rollUpParentStart(ctx, { parent_id, user_id: auth.userId }, args.status);
    }
    if (resolvedAssignee) {
      const createdTask = await ctx.db.get(id) as any;
      const assigneeId = await resolveAssigneeToUserId(ctx, resolvedAssignee, createdTask?.team_id);
      if (assigneeId) {
        await subscribeUser(ctx, assigneeId, id, "assignee", cliVia(args));
        if (cliVia(args) === "human") await handoffTaskThread(ctx, id, auth.userId, assigneeId);
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
      const conv = await resolveSessionConversation(ctx, auth.userId, args.conversation_id);
      if (conv) {
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
                // Skip subtasks that predate the task_ids exclusion rule.
                if (t && !t.parent_id) planLines.push(`  - ${t.short_id}: ${t.title} [${t.status}]`);
              }
            }
            activePlanSnippet = planLines.join("\n");
          }
        }
      }
    }

    const lines: string[] = [];
    if (activeTasks.length > 0) {
      // The capped lists show TOP-LEVEL tasks only — one agent's decomposition
      // must never evict every other task from every agent's injected context.
      // A parent summarises its subtasks as done/total; the full tree renders
      // only for this session's own bound task below.
      const childrenByParent = new Map<string, any[]>();
      for (const t of tasks as any[]) {
        if (!t.parent_id) continue;
        const key = String(t.parent_id);
        const bucket = childrenByParent.get(key);
        if (bucket) bucket.push(t);
        else childrenByParent.set(key, [t]);
      }
      const progressNote = (t: any) => {
        const children = childrenByParent.get(String(t._id));
        if (!children || children.length === 0) return "";
        const p = subtaskProgressOf(children);
        return p.total > 0 ? ` — ${p.done}/${p.total} subtasks done` : "";
      };
      const inProgress = activeTasks.filter((t: any) => t.status === "in_progress" && !t.parent_id);
      const open = activeTasks.filter((t: any) => t.status === "open" && !t.parent_id);

      if (inProgress.length > 0) {
        lines.push("In Progress:");
        for (const t of inProgress.slice(0, 10)) {
          const owner = userMap.get(t.user_id.toString()) || "";
          lines.push(`- ${t.short_id}: ${t.title}${owner ? ` (${owner})` : ""}${t.labels?.length ? ` [${t.labels.join(", ")}]` : ""}${progressNote(t)}`);
        }
      }

      if (open.length > 0) {
        lines.push("Open:");
        for (const t of open.slice(0, 10)) {
          const owner = userMap.get(t.user_id.toString()) || "";
          lines.push(`- ${t.short_id}: ${t.title}${owner ? ` (${owner})` : ""}${t.priority === "high" || t.priority === "urgent" ? ` [${t.priority}]` : ""}${progressNote(t)}`);
        }
      }

      // This session's bound task gets its full subtask tree — the one place
      // the whole decomposition belongs in agent context.
      if (args.conversation_id) {
        const conv = await resolveSessionConversation(ctx, auth.userId, args.conversation_id);
        const boundId = conv?.active_task_id ? String(conv.active_task_id) : null;
        const bound = boundId ? (tasks as any[]).find((t) => String(t._id) === boundId) : null;
        if (bound) {
          const renderTree = (parentKey: string, indent: string, depth: number) => {
            if (depth > 2) return;
            for (const c of childrenByParent.get(parentKey) ?? []) {
              if (c.status === "done" || c.status === "dropped") continue;
              lines.push(`${indent}- ${c.short_id}: ${c.title} [${c.status}]`);
              renderTree(String(c._id), indent + "  ", depth + 1);
            }
          };
          const boundKey = String(bound._id);
          const p = subtaskProgressOf(childrenByParent.get(boundKey) ?? []);
          // Always name the session's own task — the capped lists filter out
          // subtasks, so a session that claimed a leaf subtask would otherwise
          // never see the row it is working. Show its parent breadcrumb too.
          if (bound.parent_id) {
            const bp: any = await ctx.db.get(bound.parent_id);
            lines.push(`Your task ${bound.short_id}: ${bound.title} [${bound.status}]${bp ? ` — subtask of ${bp.short_id} ${bp.title}` : ""}`);
          } else if (p.total > 0) {
            lines.push(`Your task ${bound.short_id} — ${p.done}/${p.total} subtasks done, open ones:`);
          }
          if (p.total > 0) renderTree(boundKey, "  ", 1);
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
      // Count the same rows the snippet prints — top-level active tasks — so
      // the number beside the snippet matches the list it summarises.
      task_count: activeTasks.filter((t: any) => !t.parent_id).length,
      plan_count: sessionPlans.length,
    };
  },
});

// Display names for a set of assignee values. `agent:*` assignees are already
// names; user ids resolve to name → github handle. Unknown values fall through
// so callers can print the raw value rather than nothing.
async function assigneeNamesFor(ctx: any, assignees: (string | undefined)[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const id of new Set(assignees.filter(Boolean) as string[])) {
    if (id.startsWith("agent:")) {
      names[id] = id;
      continue;
    }
    const user = /^[a-z0-9]{32}$/.test(id) ? await ctx.db.get(id as any).catch(() => null) as any : null;
    if (user?.name) names[id] = user.name;
    else if (user?.github_username) names[id] = user.github_username;
  }
  return names;
}

// The sessions linked to a task, named the way every other CLI surface names
// a session (short id + title), oldest first, limited to what the caller can
// see. Two sources, unioned: the task's own `conversation_ids` (sessions that
// claimed it) and the `conversation_id` on each comment (sessions that only
// reported on it — a task filed from the web and worked by agents has an
// empty `conversation_ids` and a comment trail full of sessions). `cast task
// show/context` print these so an agent that wants a task's working session
// reads it off the task instead of regexing `jx…` ids out of comment text.
export async function linkedSessionsFor(
  ctx: any,
  userId: Id<"users">,
  task: any,
  comments: { conversation_id?: Id<"conversations"> | null; created_at: number }[],
  limit: number,
): Promise<{ short_id: string; title: string | null; conversation_id: Id<"conversations"> }[]> {
  const ordered = [
    ...(task.conversation_ids || []),
    ...[...comments]
      .sort((a, b) => a.created_at - b.created_at)
      .map((cm) => cm.conversation_id)
      .filter((id): id is Id<"conversations"> => !!id),
  ];
  const convIds = [...new Set(ordered.map(String))].slice(-limit);
  const out: { short_id: string; title: string | null; conversation_id: Id<"conversations"> }[] = [];
  for (const convId of convIds) {
    const conversation = await ctx.db.get(convId as Id<"conversations">);
    if (
      !conversation
      || !workspacesMatch(workspaceForConversation(conversation), workspaceForResource(task))
      || !(await canAccessConversation(ctx, userId, conversation))
    ) continue;
    out.push({
      short_id: conversation.short_id ?? conversation._id.toString().slice(0, 7),
      title: conversation.title ?? null,
      conversation_id: conversation._id,
    });
  }
  return out;
}

export const list = query({
  args: {
    api_token: v.string(),
    project_id: v.optional(v.string()),
    status: v.optional(v.string()),
    execution_status: v.optional(v.string()),
    ready: v.optional(v.boolean()),
    // With ready: also surface open subtasks of actively-worked parents.
    include_subtasks: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    team: v.optional(v.boolean()),
    include_derived: v.optional(v.boolean()),
    include_done: v.optional(v.boolean()),
    project_path: v.optional(v.string()),
    query: v.optional(v.string()),
    assignee: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    // Case-insensitive match against the task's labels (CLI --label).
    label: v.optional(v.string()),
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

    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      const planTaskIds = new Set((plan?.task_ids || []).map((id: any) => String(id)));
      tasks = tasks.filter((t: any) => planTaskIds.has(String(t._id)));
    }

    if (args.query) {
      const q = args.query.toLowerCase();
      tasks = tasks.filter((t: any) =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q) ||
        (t.short_id || "").toLowerCase().includes(q),
      );
    }

    if (args.label) {
      const wanted = args.label.toLowerCase();
      tasks = tasks.filter((t: any) =>
        (t.labels || []).some((l: string) => l.toLowerCase() === wanted),
      );
    }

    // Ready = open + no blockers. Subtasks of a parent that is actively being
    // worked are NOT ready by default: that decomposition belongs to the
    // session driving the parent, and a second agent claiming one mid-flight
    // splits the work. Orphaned subtasks (parent open/closed/absent) stay
    // ready — that is the rescue path for abandoned trees. `include_subtasks`
    // (CLI --subtasks) lifts the rule. The parent status is resolved by db.get,
    // NOT from the filtered page: a query/assignee/project filter could have
    // dropped the parent, and inferring "orphan" from its absence would leak an
    // in-flight subtask back into ready.
    let readyParentShortIds: Map<string, string> | undefined;
    if (args.ready) {
      const parentStatus = new Map<string, string | null>();
      readyParentShortIds = new Map<string, string>();
      for (const t of tasks) {
        if (t.parent_id && !parentStatus.has(String(t.parent_id))) {
          const p: any = await ctx.db.get(t.parent_id);
          parentStatus.set(String(t.parent_id), p ? p.status : null);
          if (p) readyParentShortIds.set(String(t.parent_id), p.short_id);
        }
      }
      tasks = tasks.filter((t: any) => {
        if (t.status !== "open") return false;
        if (t.parent_id && !args.include_subtasks) {
          const ps = parentStatus.get(String(t.parent_id));
          if (ps === "in_progress" || ps === "in_review") return false;
        }
        if (!t.blocked_by || t.blocked_by.length === 0) return true;
        // Check if all blockers are done
        return t.blocked_by.every((bid: string) => {
          const blocker = tasks.find((bt: any) => bt.short_id === bid);
          return blocker && (blocker.status === "done" || blocker.status === "dropped");
        });
      });
    }

    tasks.sort((a: any, b: any) => (b.updated_at || b._creationTime || 0) - (a.updated_at || a._creationTime || 0));
    const limit = args.limit || 300;
    const result = tasks.slice(0, limit);

    const assigneeNames = await assigneeNamesFor(ctx, result.map((t: any) => t.assignee));
    return result.map((t: any) => ({
      ...t,
      assignee_name: t.assignee ? (assigneeNames[t.assignee] || t.assignee) : undefined,
      parent_short_id: t.parent_id ? readyParentShortIds?.get(String(t.parent_id)) : undefined,
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

    // Nesting context, so `cast task show` answers both "what larger work is
    // this part of" and "what did I break this into". Children come off the
    // by_parent_id index; both sides are already same-workspace by
    // construction (resolveParentTask), so no extra access check is needed.
    const parent = task.parent_id ? await ctx.db.get(task.parent_id) : null;
    const allChildren = await ctx.db
      .query("tasks")
      .withIndex("by_parent_id", (q) => q.eq("parent_id", task!._id))
      .collect();
    // Same active predicate as every other surface (chip, context, close-guard)
    // so the count `cast task show` prints matches them all.
    const children = allChildren.filter((c: any) => isActiveTask(c));

    const assigneeNames = await assigneeNamesFor(ctx, [task.assignee]);
    const plan = task.plan_id ? await ctx.db.get(task.plan_id) : null;
    return {
      ...task,
      assignee_name: task.assignee ? (assigneeNames[task.assignee] || task.assignee) : undefined,
      plan: plan && (await canAccessPlan(ctx, auth.userId, plan))
        ? { short_id: plan.short_id, title: plan.title, status: plan.status }
        : null,
      sessions: await linkedSessionsFor(ctx, auth.userId, task, comments, 10),
      comments,
      parent: parent ? { short_id: parent.short_id, title: parent.title, status: parent.status } : null,
      subtask_progress: subtaskProgressOf(children as any[]),
      subtasks: children.map((child) => ({
        short_id: child.short_id,
        title: child.title,
        status: child.status,
        priority: child.priority,
      })),
    };
  },
});

export const update = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    status: v.optional(v.string()),
    // Team status id refining the category; "" clears back to the default.
    status_id: v.optional(v.string()),
    priority: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    promoted: v.optional(v.boolean()),
    project_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    // Short id of the parent task; empty string detaches back to the top level.
    parent: v.optional(v.string()),
    // Close-guard resolution when closing a parent with open subtasks:
    // "cascade" closes the open subtree too, "only_parent" closes just this task.
    subtask_resolution: v.optional(v.union(v.literal("cascade"), v.literal("only_parent"))),
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

    // The category every status side effect below keys on. args.status alone
    // is not enough: a status_id-only write still moves the category.
    const statusWrite = await resolveStatusWrite(ctx, task.team_id, task.status, args);
    const nextStatus = statusWrite.status;

    const now = Date.now();
    const updates: any = { updated_at: now };
    if (statusWrite.statusId.set) updates.status_id = statusWrite.statusId.value;
    if (nextStatus) updates.status = nextStatus;
    if (args.priority) updates.priority = args.priority;
    if (args.title) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.assignee !== undefined) updates.assignee = await resolveAssigneeStr(ctx, args.assignee, auth.userId) || args.assignee;
    if (args.labels) updates.labels = args.labels;
    if (args.promoted !== undefined) updates.promoted = args.promoted;
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
    // Reparent (or `--parent ""` to detach and return the task to the top level).
    if (args.parent !== undefined) {
      if (!args.parent) {
        updates.parent_id = undefined;
      } else {
        const parent = await resolveParentTask(ctx, auth.userId, args.parent, {
          workspace: targetWorkspace,
          child: task,
        });
        updates.parent_id = parent._id;
      }
    }
    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (!plan || !(await canAccessPlan(ctx, auth.userId, plan))) notFound("Plan not found");
      requireSameWorkspace(plan, targetWorkspace, "plan");
      updates.plan_id = plan._id;
      // Subtasks carry plan_id for context but never join plan.task_ids — the
      // parent is the plan's unit of progress. Branch on key PRESENCE, not
      // value: `updates.parent_id === undefined` is also how detach is
      // expressed, so a value test would mistake a detach for "unchanged".
      const willBeSubtask = "parent_id" in updates ? !!updates.parent_id : !!task.parent_id;
      const taskIds = plan.task_ids || [];
      if (!willBeSubtask && !taskIds.some((id: any) => id === task._id)) {
        taskIds.push(task._id);
        await ctx.db.patch(plan._id, { task_ids: taskIds, updated_at: now });
      }
    }
    // Snapshot the pre-write edges: the mirror patches below run after the
    // main patch, which may mutate `task` in place.
    const prevDeps = { blocked_by: task.blocked_by || [], blocks: task.blocks || [] };
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

    if (nextStatus === "done" || nextStatus === "dropped") {
      updates.closed_at = now;
    }

    // Link conversation if provided. Unresolvable session ref = apply the
    // update without the link, never reject the update itself (see
    // resolveSessionConversation).
    let linkedConvId: Id<"conversations"> | undefined;
    const conv = args.conversation_id
      ? await resolveSessionConversation(ctx, auth.userId, args.conversation_id)
      : null;
    if (conv) {
      // A conversation in another workspace may still drive the write (an agent
      // working a cross-workspace task); only the conversation↔task linkage is
      // skipped, since relationships may not join authorization domains.
      const convMatchesWorkspace = workspacesMatch(workspaceForConversation(conv), targetWorkspace);
      if (convMatchesWorkspace) {
        linkedConvId = conv._id;
        const existing = task.conversation_ids || [];
        if (!existing.some((id) => id === conv._id)) {
          updates.conversation_ids = [...existing, conv._id];
          // Compatibility dual-write: the entity-conversation association row alongside
          // the legacy conversation_ids field. Best-effort — this update may
          // simultaneously move the task's workspace, which the strict
          // containment check reads from the pre-patch row.
          await linkConversationToEntityBestEffort(ctx, auth.userId, {
            entityType: "task",
            entityId: String(task._id),
            conversationId: conv._id,
            relationship: "work",
          });
        }
      }
      // Only bind conversation to task on explicit start (cast task start)
      if (convMatchesWorkspace && nextStatus === "in_progress" && (!conv.active_task_id || conv.active_task_id === task._id)) {
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
      if ((nextStatus === "done" || nextStatus === "dropped") && conv.active_task_id === task._id) {
        await ctx.db.patch(conv._id, { active_task_id: undefined });
      }
    }

    if (nextStatus === "in_progress") {
      updates.attempt_count = (task.attempt_count || 0) + 1;
      updates.last_attempted_at = now;
      if (!task.started_at) updates.started_at = now;
    }

    if (nextStatus === "done" && task.started_at) {
      updates.actual_minutes = Math.round((now - task.started_at) / 60000);
    }

    // Close-guard: refuses done/dropped on a parent with open subtasks unless
    // resolved; returns the subtree to cascade-close. Runs before any write.
    const cascadeIds = await guardParentClose(ctx, task, nextStatus, args.subtask_resolution);

    // Did the parent actually change? (Reparent/detach need history + plan reconcile.)
    const parentChanged = "parent_id" in updates && String(updates.parent_id ?? "") !== String(task.parent_id ?? "");

    // Record history for changed fields
    const trackFields: [string, any, any][] = [];
    if (nextStatus && nextStatus !== task.status) trackFields.push(["status", task.status, nextStatus]);
    if (args.priority && args.priority !== task.priority) trackFields.push(["priority", task.priority, args.priority]);
    if (args.title && args.title !== task.title) trackFields.push(["title", task.title, args.title]);
    if (args.assignee !== undefined && updates.assignee !== task.assignee) trackFields.push(["assignee", task.assignee || "", updates.assignee || ""]);
    if (parentChanged) trackFields.push(["parent", task.parent_id ?? "", updates.parent_id ?? ""]);

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
    // blocked_by/blocks are raw overwrites; reflect the delta onto each
    // referenced task's other side so the stored mirror stays coherent.
    for (const [field, mirrorField] of [["blocked_by", "blocks"], ["blocks", "blocked_by"]] as const) {
      const nextDeps = args[field];
      if (!nextDeps) continue;
      const self = { short_id: task.short_id, workspace: targetWorkspace };
      for (const dep of nextDeps) {
        if (!prevDeps[field].includes(dep)) await patchDepMirror(ctx, auth.userId, self, dep, mirrorField, "add");
      }
      for (const dep of prevDeps[field]) {
        if (!nextDeps.includes(dep)) await patchDepMirror(ctx, auth.userId, self, dep, mirrorField, "remove");
      }
    }
    if (cascadeIds.length > 0) await cascadeClose(ctx, cascadeIds, nextStatus!, auth.userId, task);
    // Rollup walks the EFFECTIVE parent (the new one on a reparent+start), not
    // the pre-patch parent, so the task's actual parent flips to in_progress.
    await rollUpParentStart(ctx, { ...task, parent_id: "parent_id" in updates ? updates.parent_id : task.parent_id }, nextStatus);

    // Reparent/detach changed the task's subtask-ness: reconcile plan.task_ids
    // and progress on the plan it now belongs to (its own or its new parent's).
    if (parentChanged) {
      const finalPlan = (updates.plan_id ?? task.plan_id) as Id<"plans"> | undefined;
      await reconcilePlanMembership(ctx, task._id, finalPlan, !!updates.parent_id);
    }

    if (nextStatus && nextStatus !== task.status) {
      if (task.plan_id) {
        await recalcPlanProgress(ctx, task.plan_id, task._id, nextStatus);
      }
      await notifySubscribers(ctx, "task_status_changed", auth.userId, task as any, `changed ${task.short_id} to ${nextStatus}`, linkedConvId);
    }
    if (args.assignee !== undefined && updates.assignee !== task.assignee) {
      const assigneeId = await resolveAssigneeToUserId(ctx, updates.assignee || "", task.team_id);
      // Same rule as webUpdate: assigning yourself is not an event to announce.
      if (assigneeId && assigneeId.toString() !== auth.userId.toString()) {
        await subscribeUser(ctx, assigneeId, task._id, "assignee", cliVia(args));
        if (cliVia(args) === "human") await handoffTaskThread(ctx, task._id, auth.userId, assigneeId);
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

// Insert a comment AND bump the task row in the same mutation. task_comments
// is not a change-feed-tracked table, so a bare insert is invisible to sync —
// no client cache learns about it until the task's detail query happens to run.
// Bumping updated_at stamps the change log; the feed then re-fetches the row
// through webGetByIds, which carries comments, so every client's cached
// activity stays fresh without opening the task.
//
// The comment also files the task in the Threads inbox of everyone following
// it (subscribers, creator, assignee). `actorId` is the PERSON who wrote it:
// their copy reads as read and the row carries author_user_id. An agent or
// system row has no actor, so the owner sees it unread — that is the point.
// Every task_comments insert with a task row goes through here.
async function insertTaskComment(
  ctx: any,
  taskId: Id<"tasks">,
  fields: {
    author: string;
    text: string;
    comment_type: string;
    conversation_id?: Id<"conversations">;
    image_storage_ids?: string[];
  },
  actorId?: Id<"users">,
) {
  const now = Date.now();
  const id = await ctx.db.insert("task_comments", {
    task_id: taskId,
    ...fields,
    author_user_id: actorId,
    comment_type: fields.comment_type as any,
    created_at: now,
  });
  // last_comment_at is the replica's refetch trigger for cached comments
  // (sync-log-cargo E7): the log ships task rows only, and a clock-only bump
  // cannot be told apart from any other write once cargo coalesces.
  await ctx.db.patch(taskId, { updated_at: now, last_comment_at: now });
  const task = await ctx.db.get(taskId);
  if (task) {
    await touchThread(ctx, {
      kind: "task",
      rootKey: String(taskId),
      teamId: task.team_id,
      refs: { task_id: taskId },
      participants: await taskThreadParticipants(ctx, task),
      actorId,
      activityAt: now,
    });
  }
  return id;
}

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
      // A stale or unresolvable session ref drops the back-link, exactly like
      // the cross-workspace case below — the comment text must always land
      // (see resolveSessionConversation).
      const conv = await resolveSessionConversation(ctx, auth.userId, args.conversation_id);
      // Cross-workspace commenters still get their text recorded; only the
      // conversation back-link is dropped (relationships stay within one domain).
      if (conv && workspacesMatch(workspaceForConversation(conv), workspaceForResource(task))) {
        conversation_id = conv._id;
      }
    }

    // A post from inside a session is an agent's: no actor, so the owner's
    // thread lights up. A person running the CLI by hand is the actor.
    const id = await insertTaskComment(ctx, task._id, {
      author: args.author || user?.name || "unknown",
      text: args.text,
      conversation_id,
      comment_type: args.comment_type || "note",
    }, args.conversation_id ? undefined : auth.userId);

    await subscribeUser(ctx, auth.userId, task._id, "commenter", cliVia(args));
    await notifySubscribers(ctx, "task_commented", auth.userId, task as any, `commented on ${task.short_id}: ${args.text.slice(0, 100)}`, conversation_id);

    return { id };
  },
});

// create and update accept blocked_by/blocks as raw arrays; each accepted
// edge must also land on the referenced task's other side or the stored
// mirror drifts (addDep/removeDep already keep it for single edges). Same
// short-id resolution addDep uses, but an unresolvable, inaccessible or
// cross-workspace reference skips the mirror instead of rejecting a write
// the caller already made.
async function patchDepMirror(
  ctx: any,
  userId: Id<"users">,
  self: { short_id: string; workspace: AuthorizedWorkspace },
  otherShortId: string,
  mirrorField: "blocks" | "blocked_by",
  op: "add" | "remove",
) {
  const other = await ctx.db
    .query("tasks")
    .withIndex("by_short_id", (q: any) => q.eq("short_id", otherShortId))
    .first();
  if (!other || !(await canAccessTask(ctx, userId, other))) return;
  if (op === "add" && !isSameWorkspace(other, self.workspace)) return;
  const mirror: string[] = other[mirrorField] || [];
  if (op === "add" ? mirror.includes(self.short_id) : !mirror.includes(self.short_id)) return;
  const next = op === "add"
    ? [...mirror, self.short_id]
    : mirror.filter((id: string) => id !== self.short_id);
  await ctx.db.patch(other._id, { [mirrorField]: next, updated_at: Date.now() });
}

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

export const removeDep = mutation({
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

    // Removes the edge from this task, plus the mirror edge on the other task
    // when it still exists — the other side may be gone, since edges to
    // dropped/deleted blockers are exactly what removal is for.
    const removeEdge = async (otherId: string, field: "blocks" | "blocked_by") => {
      const current: string[] = task[field] || [];
      if (!current.includes(otherId)) {
        throw new Error(`${args.short_id} has no ${field === "blocks" ? "blocks" : "blocked-by"} dependency on ${otherId}`);
      }
      await ctx.db.patch(task._id, { [field]: current.filter((id) => id !== otherId), updated_at: Date.now() });
      const other = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", otherId))
        .first();
      if (!other || !(await canAccessTask(ctx, auth.userId, other))) return;
      const mirrorField = field === "blocks" ? "blocked_by" : "blocks";
      const mirror: string[] = other[mirrorField] || [];
      if (mirror.includes(args.short_id)) {
        await ctx.db.patch(other._id, { [mirrorField]: mirror.filter((id) => id !== args.short_id), updated_at: Date.now() });
      }
    };

    if (args.blocks) await removeEdge(args.blocks, "blocks");
    if (args.blocked_by) await removeEdge(args.blocked_by, "blocked_by");

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

    // Linked sessions (short id + title), each with its insight summary when
    // one exists. `sessionSummaries` stays as the flat list of summaries for
    // callers that predate `sessions`.
    const sessions: { short_id: string; title: string | null; summary: string | null }[] = [];
    for (const s of await linkedSessionsFor(ctx, auth.userId, task, comments, 5)) {
      const insight = await ctx.db
        .query("session_insights")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", s.conversation_id))
        .first();
      sessions.push({ short_id: s.short_id, title: s.title, summary: insight?.summary ?? null });
    }
    const sessionSummaries = sessions.map((s) => s.summary).filter((x): x is string => !!x);

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

    // Parent + subtask tree: the surface a resumed/compacted agent regrounds
    // from, so it must see the tree it (or a sibling) already built rather
    // than re-decomposing. Two levels — direct children and grandchildren —
    // matching the depth cap. Assignee names included so a second agent can
    // tell which open subtasks are already claimed.
    let parent: { short_id: string; title: string; status: string } | null = null;
    if (task.parent_id) {
      const p: any = await ctx.db.get(task.parent_id);
      if (p && isSameWorkspace(p, workspaceForResource(task))) {
        parent = { short_id: p.short_id, title: p.title, status: p.status };
      }
    }
    const nameOf = async (uid: any): Promise<string | undefined> => {
      if (!uid) return undefined;
      const u: any = await ctx.db.get(uid).catch(() => null);
      return u?.name || u?.github_username || undefined;
    };
    const describeChildren = async (parentId: Id<"tasks">, depth: number): Promise<any[]> => {
      const children = await ctx.db
        .query("tasks")
        .withIndex("by_parent_id", (q: any) => q.eq("parent_id", parentId))
        .collect();
      const out: any[] = [];
      for (const c of children) {
        if (!isActiveTask(c)) continue;
        out.push({
          short_id: c.short_id,
          title: c.title,
          status: c.status,
          priority: c.priority,
          assignee_name: await nameOf(c.assignee && /^[a-z0-9]{32}$/.test(c.assignee) ? c.assignee : null),
          subtasks: depth > 0 ? await describeChildren(c._id, depth - 1) : [],
        });
      }
      return out;
    };
    const subtasks = await describeChildren(task._id, 1);
    const subtaskProgress = subtasks.length > 0
      ? subtaskProgressOf(await ctx.db
          .query("tasks")
          .withIndex("by_parent_id", (q: any) => q.eq("parent_id", task._id))
          .collect())
      : null;

    return {
      task,
      parent,
      subtasks,
      subtaskProgress,
      comments,
      sessions,
      sessionSummaries,
      assignee_name: task.assignee ? ((await assigneeNamesFor(ctx, [task.assignee]))[task.assignee] || task.assignee) : undefined,
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
        // STRICTLY this team's tasks: a teamless task lives in its owner's
        // personal workspace only, even when assigned to the viewer — the old
        // "rescue orphans assigned to me" union here is exactly how personal
        // tasks leaked into team views. Teamless assigned tasks stay reachable
        // in the personal view, whose assignee union below covers them. The
        // assignee scan here rescues only SAME-TEAM tasks assigned to me that
        // fell outside the team scan's MAX_INITIAL cap.
        const [teamTasks, assignedTasks] = await Promise.all([
          collectByTeam(args.team_id),
          collectByAssignee(String(userId)),
        ]);
        // The routing index returns every task tagged to the team, including
        // ones whose ACCESS key is user:<owner> (private inside a team). The
        // bootstrap floor must agree with byIds and the sync log's projection,
        // so filter through the one access rule (sync fast path on stored keys).
        for (const t of teamTasks) {
          if (await visibleInTeamList(ctx, userId, "tasks", t, args.team_id)) pushUnique(t);
        }
        for (const t of assignedTasks) {
          if (String(t.team_id) === String(args.team_id)) pushUnique(t);
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
        for (let i = 0; i < teamLists.length; i++) {
          for (const t of teamLists[i]) {
            if (await visibleInTeamList(ctx, userId, "tasks", t, memberships[i].team_id)) pushUnique(t);
          }
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
      // Same subtask rule as the CLI list: open subtasks of an actively-worked
      // parent are that session's decomposition, not up-for-grabs work. Parent
      // status resolved by db.get, not from the filtered page (see list()).
      const parentStatus = new Map<string, string | null>();
      for (const t of tasks) {
        if (t.parent_id && !parentStatus.has(String(t.parent_id))) {
          const p: any = await ctx.db.get(t.parent_id);
          parentStatus.set(String(t.parent_id), p ? p.status : null);
        }
      }
      tasks = tasks.filter((t) => {
        if (t.status !== "open") return false;
        if (t.parent_id) {
          const ps = parentStatus.get(String(t.parent_id));
          if (ps === "in_progress" || ps === "in_review") return false;
        }
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
// Inaccessible / gone ids are omitted; callers prune ids the response omits
// (authorized absence). Consumers: the sync-log applier (syncLog.ts / web
// useSyncChangeFeed.ts) and, for deployed old bundles, changeFeed.ts.
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
    // Carry comments so the change-feed catch-up keeps each client's cached
    // activity fresh (the store preserves the field across list deltas, which
    // never send it). Bounded: ≤300 ids, one indexed lookup each. History is
    // heavier (needs user enrichment) and still rides only webGetTaskDetail.
    // session_info must ride along: this merges into the same tasks[id].comments
    // the enriched detail query fills, and a raw row here clobbers it.
    for (const task of result) {
      task.comments = await attachCommentSessionInfo(ctx, await ctx.db
        .query("task_comments")
        .withIndex("by_task_id", (q: any) => q.eq("task_id", task._id))
        .collect());
    }
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
    // Strict workspace boundary: the personal crawl walks by_user_updated, which
    // also holds the user's team-tagged tasks — those belong to their team
    // workspaces and must not ship in a personal-scoped response.
    if (args.workspace === "personal") rows = rows.filter((t: any) => !t.team_id);
    // Team crawl: same access rule as webList (private-inside-a-team rows never
    // reach a teammate's floor).
    if (args.workspace === "team" && args.team_id) {
      const kept: any[] = [];
      for (const t of rows) if (await visibleInTeamList(ctx, userId, "tasks", t, args.team_id)) kept.push(t);
      rows = kept;
    }
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
// Split from the query wrapper (like performListActiveSessions) so the body is
// callable from the debugTmp timing probes without auth.
export const webActiveSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return {};
    return performWebActiveSessions(ctx, userId);
  },
});

export async function performWebActiveSessions(ctx: { db: any }, userId: Id<"users">) {
    const managedSessions = await listLiveManagedSessions(ctx, userId);

    // started_by = the session owner's display name, last_message_at =
    // conv.updated_at (bumped on every message). Together the badge reads
    // "who · when" ("ashot · now"), consistent with the dormant origin badge.
    // Owner names are cached since this overlay is scoped to the viewer's own
    // daemons — typically one or two distinct users. The cache holds promises
    // so the concurrent per-session lookups below coalesce into one fetch.
    const nameCache = new Map<string, Promise<string | undefined>>();
    const ownerName = (uid: any): Promise<string | undefined> => {
      const key = uid.toString();
      const cached = nameCache.get(key);
      if (cached) return cached;
      const p: Promise<string | undefined> = ctx.db.get(uid as Id<"users">)
        .then((u: any) => (u ? (u.name || u.email || undefined) : undefined))
        .catch(() => undefined);
      nameCache.set(key, p);
      return p;
    };

    // Per-session reads run concurrently (like webTaskOrigins): with dozens of
    // live sessions, a sequential get/access-check chain is hundreds of serial
    // round-trips and times out under backend load ("too many system operations").
    const entries = await Promise.all(managedSessions.map(async (s) => {
      if (!s.conversation_id) return null;
      const conv = await ctx.db.get(s.conversation_id);
      if (!conv || !(await canAccessConversation(ctx, userId, conv)) || !conv.active_task_id) return null;
      const task = await ctx.db.get(conv.active_task_id);
      if (
        !task
        || !workspacesMatch(workspaceForConversation(conv), workspaceForResource(task))
        || !(await canAccessTask(ctx, userId, task))
      ) return null;
      return [conv.active_task_id.toString(), {
        _id: conv._id.toString(),
        session_id: conv.session_id,
        title: conv.title || undefined,
        agent_status: s.agent_status || undefined,
        agent_type: conv.agent_type || undefined,
        started_by: await ownerName(conv.user_id),
        // Bucketed to the minute: this overlay is always mounted on the task
        // board and updated_at moves on every streamed flush, so the raw value
        // re-pushed the whole map seconds apart. The badge renders it as a
        // relative age (relTimeShort in LivenessDot), which is coarser than a
        // minute. Invalidation is unchanged.
        last_message_at: bucketTs(conv.updated_at),
      }] as const;
    }));
    const map: Record<string, { _id: string; session_id: string; title?: string; agent_status?: string; agent_type?: string; started_by?: string; last_message_at?: number }> = {};
    for (const e of entries) if (e) map[e[0]] = e[1];
    return map;
}

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

    const comments = await attachCommentSessionInfo(ctx, await ctx.db
      .query("task_comments")
      .withIndex("by_task_id", (q) => q.eq("task_id", task!._id))
      .collect());

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
    // Team status id refining the category; "" clears back to the default.
    status_id: v.optional(v.string()),
    priority: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    project_id: v.optional(v.string()),
    project_path: v.optional(v.string()),
    execution_status: v.optional(v.string()),
    triage_status: v.optional(v.string()),
    // Short id of the parent task; empty string detaches back to the top level.
    parent: v.optional(v.string()),
    // Close-guard resolution when closing a parent with open subtasks.
    subtask_resolution: v.optional(v.union(v.literal("cascade"), v.literal("only_parent"))),
    // Manual list rank (fractional midpoints; see schema).
    sort_order: v.optional(v.number()),
    // Short id of the canonical task; empty string clears the link.
    duplicate_of: v.optional(v.string()),
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

    // The category every status side effect below keys on. args.status alone
    // is not enough: a status_id-only write still moves the category.
    const statusWrite = await resolveStatusWrite(ctx, task.team_id, task.status, args);
    const nextStatus = statusWrite.status;

    const now = Date.now();
    const updates: any = { updated_at: now };
    if (statusWrite.statusId.set) updates.status_id = statusWrite.statusId.value;
    // Reparent through the single entry point (access, workspace, cycle,
    // depth). Same semantics as the CLI path: "" detaches.
    if (args.parent !== undefined) {
      if (!args.parent) {
        updates.parent_id = undefined;
      } else {
        const taskWorkspace = task.team_id
          ? { type: "team" as const, teamId: task.team_id }
          : { type: "personal" as const, userId: task.user_id };
        const parent = await resolveParentTask(ctx, userId, args.parent, {
          workspace: taskWorkspace,
          child: task,
        });
        updates.parent_id = parent._id;
      }
    }
    if (nextStatus) updates.status = nextStatus;
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
    if (args.sort_order !== undefined) updates.sort_order = args.sort_order;
    if (args.duplicate_of !== undefined) {
      if (!args.duplicate_of) {
        updates.duplicate_of = undefined;
      } else {
        // The canonical task must exist, be visible to this user, and not be
        // the task itself — a dangling or self link renders as a dead chip.
        const canonical = await ctx.db
          .query("tasks")
          .withIndex("by_short_id", (q) => q.eq("short_id", args.duplicate_of!))
          .first();
        if (!canonical || !(await canAccessTask(ctx, userId, canonical))) notFound("Canonical task not found");
        if (canonical._id === task._id) throw new Error("A task can't duplicate itself");
        updates.duplicate_of = args.duplicate_of;
      }
    }
    if (args.triage_status) {
      updates.triage_status = args.triage_status;
      if (args.triage_status === "active") updates.promoted = true;
    }

    if (nextStatus === "done" || nextStatus === "dropped") {
      updates.closed_at = now;
    }
    if (nextStatus === "in_progress") {
      updates.attempt_count = (task.attempt_count || 0) + 1;
      updates.last_attempted_at = now;
    }

    // Close-guard: refuses done/dropped on a parent with open subtasks unless
    // resolved; returns the subtree to cascade-close. Runs before any write.
    const cascadeIds = await guardParentClose(ctx, task, nextStatus, args.subtask_resolution);

    const resolvedAssignee = updates.assignee || args.assignee;
    // Record history for changed fields
    const trackFields: [string, any, any][] = [];
    if (nextStatus && nextStatus !== task.status) trackFields.push(["status", task.status, nextStatus]);
    if (args.priority && args.priority !== task.priority) trackFields.push(["priority", task.priority, args.priority]);
    if (args.title && args.title !== task.title) trackFields.push(["title", task.title, args.title]);
    if (args.assignee !== undefined && resolvedAssignee !== task.assignee) trackFields.push(["assignee", task.assignee || "", resolvedAssignee || ""]);
    if (args.execution_status !== undefined && args.execution_status !== (task.execution_status || "")) trackFields.push(["execution_status", task.execution_status || "", args.execution_status || ""]);
    const parentChanged = "parent_id" in updates && String(updates.parent_id ?? "") !== String(task.parent_id ?? "");
    if (parentChanged) trackFields.push(["parent", task.parent_id ?? "", updates.parent_id ?? ""]);

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
    if (cascadeIds.length > 0) await cascadeClose(ctx, cascadeIds, nextStatus!, userId, task);
    await rollUpParentStart(ctx, { ...task, parent_id: "parent_id" in updates ? updates.parent_id : task.parent_id }, nextStatus);
    if (parentChanged) {
      await reconcilePlanMembership(ctx, task._id, task.plan_id as Id<"plans"> | undefined, !!updates.parent_id);
    }

    if (nextStatus && nextStatus !== task.status) {
      if (task.plan_id) {
        await recalcPlanProgress(ctx, task.plan_id, task._id, nextStatus);
      }
      await notifySubscribers(ctx, "task_status_changed", userId, task as any, `changed ${task.short_id} to ${nextStatus}`);
    }
    if (args.assignee !== undefined && resolvedAssignee !== task.assignee) {
      const assigneeUserId = resolvedAssignee === userId?.toString()
        ? userId
        : await resolveAssigneeToUserId(ctx, resolvedAssignee || "", task.team_id);
      if (assigneeUserId && assigneeUserId.toString() !== userId.toString()) {
        await subscribeUser(ctx, assigneeUserId, task._id, "assignee", "human");
        await handoffTaskThread(ctx, task._id, userId, assigneeUserId);
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

    await insertTaskComment(ctx, task._id, {
      author: user?.name || "unknown",
      text: args.text,
      comment_type: args.comment_type || "note",
      image_storage_ids: args.image_storage_ids,
    }, userId);

    await subscribeUser(ctx, userId, task._id, "commenter", "human");
    await notifySubscribers(ctx, "task_commented", userId, task as any, `commented on ${task.short_id}: ${args.text.slice(0, 100)}`);

    return { success: true };
  },
});

export const assignToAgent = mutation({
  args: {
    short_id: v.string(),
    agent_type: v.union(v.literal("claude_code"), v.literal("codex"), v.literal("cursor"), v.literal("gemini"), v.literal("opencode"), v.literal("pi"), v.literal("grok")),
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
    // Team status id refining the category (kanban "add to column").
    status_id: v.optional(v.string()),
    priority: v.optional(v.string()),
    project_id: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    plan_id: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    assignee: v.optional(v.string()),
    project_path: v.optional(v.string()),
    // Short id (or id) of the parent task — the web quick-add / create-modal
    // subtask path. Resolved through resolveParentTask like every surface.
    parent: v.optional(v.string()),
    // Optimistic-create idempotency key (see schema.tasks.client_key).
    client_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    // Idempotency: a retried or replayed create carries the same client_key,
    // so return the row it already made instead of inserting a duplicate.
    if (args.client_key) {
      const existing = await ctx.db
        .query("tasks")
        .withIndex("by_client_key", (q) => q.eq("user_id", userId).eq("client_key", args.client_key))
        .first();
      if (existing) return { id: existing._id, short_id: existing.short_id };
    }

    // A task created onto a plan lives in the plan's workspace: when the
    // caller names a plan but no explicit workspace, inherit the plan's
    // (canAccessPlan already proves membership for a team plan). An explicit
    // workspace still has to match the plan — requireSameWorkspace below.
    let plan: any = null;
    if (args.plan_id) {
      plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      if (!plan || !(await canAccessPlan(ctx, userId, plan))) notFound("Plan not found");
    }
    const inheritFromPlan = plan && !args.workspace && !args.team_id;

    // A subtask lives in its parent's workspace: with no explicit workspace or
    // plan, the parent row decides. resolveParentTask below re-validates the
    // final workspace, so a mismatched explicit workspace still fails.
    let parentPeek: any = null;
    if (args.parent) {
      parentPeek = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.parent!))
        .first()
        ?? await (async () => {
          const id = ctx.db.normalizeId("tasks", args.parent!);
          return id ? await ctx.db.get(id) : null;
        })();
    }
    const inheritFromParent = parentPeek && !inheritFromPlan && !args.workspace && !args.team_id;

    // Otherwise the workspace comes from the client's explicit picker or the
    // directory mapping — never from the user's active team. An unmapped
    // project_path with no explicit workspace lands personal ("Only Me"),
    // matching sessions.
    const db = await createDataContext(ctx, inheritFromPlan
      ? (plan.team_id
          ? { userId, workspace: "team", team_id: plan.team_id }
          : { userId, workspace: "personal" })
      : inheritFromParent
        ? (parentPeek.team_id
            ? { userId, workspace: "team", team_id: parentPeek.team_id }
            : { userId, workspace: "personal" })
        : { userId, workspace: args.workspace, team_id: args.team_id, project_path: args.project_path });

    // Now the real resolution: access, same-workspace, cycle, depth.
    let parentDoc: any = null;
    if (args.parent) {
      parentDoc = await resolveParentTask(ctx, userId, args.parent, { workspace: db.workspace });
    }

    let project_id: Id<"projects"> | undefined;
    if (args.project_id) {
      const pid = ctx.db.normalizeId("projects", args.project_id);
      if (!pid) notFound("Project not found");
      const project = await requireAccessibleProject(ctx, userId, pid);
      requireSameWorkspace(project, db.workspace, "project");
      project_id = pid;
    }

    let plan_id: Id<"plans"> | undefined;
    if (plan) {
      requireSameWorkspace(plan, db.workspace, "plan");
      plan_id = plan._id;
    }
    // Decomposition stays inside the parent's container: no explicit
    // plan/project means the parent's.
    if (parentDoc) {
      if (!plan_id && parentDoc.plan_id) plan_id = parentDoc.plan_id;
      if (!project_id && parentDoc.project_id) project_id = parentDoc.project_id;
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

    // Category + custom-status resolution against the resolved workspace's
    // team. Also validates args.status (this path used to skip the assert and
    // let a bad value surface as a raw schema error at insert).
    const statusWrite = await resolveStatusWrite(
      ctx,
      db.workspace.type === "team" ? db.workspace.teamId : undefined,
      undefined,
      args,
    );

    const now = Date.now();
    const id = await db.insert("tasks", {
      project_id,
      plan_id,
      parent_id: parentDoc?._id,
      client_key: args.client_key,
      short_id,
      title: args.title,
      description: args.description,
      task_type: (args.task_type || "task") as any,
      status: (statusWrite.status || "open") as any,
      status_id: statusWrite.statusId.set ? statusWrite.statusId.value : undefined,
      priority: (args.priority || "medium") as any,
      labels: args.labels,
      assignee: resolvedAssignee,
      source: "human",
      attempt_count: 0,
      retry_count: 0,
      max_retries: 3,
    } as any);

    // A subtask created directly in progress flips its parent chain.
    if (parentDoc) {
      await rollUpParentStart(ctx, { parent_id: parentDoc._id, user_id: userId }, statusWrite.status);
    }

    // Subtasks carry plan_id for context but never join plan.task_ids — the
    // parent is the plan's unit of progress.
    if (plan_id && !parentDoc) {
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

    tasks.sort((a: any, b: any) => (b.updated_at || b._creationTime || 0) - (a.updated_at || a._creationTime || 0));
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
      await insertTaskComment(ctx, task._id, {
        author: user?.name || "system",
        text: `Retry count (${newRetryCount}) exceeded max retries (${maxRetries}). Task automatically blocked.`,
        comment_type: "blocker",
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
      await insertTaskComment(ctx, task._id, {
        author: user?.name || "unknown",
        text: args.execution_comment,
        comment_type: "progress",
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
      // A category change orphans any custom-status refinement (its id belongs
      // to the old category); same rule as resolveStatusWrite.
      if (args.status !== task.status) updates.status_id = undefined;
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
          await subscribeUser(ctx, assigneeId, task._id, "assignee", "human");
          await handoffTaskThread(ctx, task._id, auth.userId, assigneeId);
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
    await insertTaskComment(ctx, task._id, {
      author: user?.name || "system",
      text: `Scheduled for retry (attempt ${newAttemptCount})`,
      comment_type: "progress",
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
