import { v, type ObjectType, type Validator } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { patchTask } from "./lib/taskWrite";
import { resolveActor, roleOfConversation } from "./lib/actor";
import { allRolesInBoundary, liveRoleByHandle, roleByHandleForRead } from "./lib/orgAccess";
import { taskWork } from "./lib/orgOwnership";
import { ownerOf } from "@codecast/shared/contracts/orgLead";
import { matchHandle, teamRoster } from "./lib/mentionResolve";
import { chainAssignees, roleAssigneeInfo, type AssigneeInfo } from "@codecast/shared/contracts/orgAssignee";
import { enqueueStartSession } from "./devices";
import { resolveCallRef } from "./transcripts";
import { outcomeOfDeclaration, subagentEnded } from "./subagentFleet";
import { formatTaskCommentMessage, fromConvexAgentType, inlineForeignText, toConvexAgentType } from "@codecast/shared/contracts";
import { blockersHoldingBack, docRelatesToTask, isStaleTask, readinessOf, topologicalOrder } from "@codecast/shared/tasks";
import { assertDependencyEdges, mirrorNext, offFrontierReason, orderFrontier, readinessLookups, readyTasks, requireTaskByRef, stampGraphStatus, storedGraphRefs, taskByRef, writeEdges } from "./lib/taskGraph";
import { addWaitsAtCreate, cliCaller, pendingReleases, tellReleased } from "./taskWaits";
import { commentReaches, executionHintArgs, executionHintPatch, isEphemeralTask } from "./lib/taskExecution";
import { bySystem, byUser, recordTaskChange, trackedFieldChanges, type TaskChangeBy, type TaskFieldChange } from "./lib/taskHistory";
import { afterDuplicateCleared, afterStatusEdges, foundDuringForCreate, foundDuringUpdate, openBlockersWithChecks, redirectDependents, requireLiveReplacement, taskLinksOf, unlinkDeletedTask } from "./taskLinks";
import {
  MAX_TASK_DEPTH,
  TASK_STATUS_CATEGORIES,
  TERMINAL_TASK_CATEGORIES,
  buildTaskSpawnPrompt,
  findTeamTaskStatus,
  isActiveTask,
  isTaskBeingWorked,
  isTaskStatusCategory,
  isTerminalTaskStatus,
  isHumanOrigin,
  resolveTaskStatus,
  subtaskProgressOf,
  taskStatusChoices,
  teamTaskStatuses,
} from "@codecast/shared/tasks";
import type { TeamTaskStatus } from "@codecast/shared/tasks";
import { briefGoalRefs, LINE_CATEGORIES, LINE_READINESS, LINE_RISKS } from "@codecast/shared/contracts/goalsBrief";
import { causeBrief } from "./goals";
import { Doc, Id } from "./_generated/dataModel";
import type { SubscriptionVia } from "./notificationRouter";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext, createWorkContext, scopeByProject, explicitWorkspace } from "./data";
import { nextShortId } from "./counters";
import { internal } from "./_generated/api";
import { isViableInboxParent } from "./inboxFilters";
import { listLiveManagedSessions } from "./lib/liveSessions";
import { requireInitiative } from "./lib/initiativeRef";
import { projectTasks } from "./lib/projectWork";
import { taskCommentsWithSessionInfo, type CommentSessionCache } from "./lib/commentSessionInfo";
import { pickInheritedGitMeta, type GitMetaSource } from "./projectPaths";
import { bucketTs } from "./presenceState";
import { canSendProductMessage, enqueuePendingMessage, tellRole } from "./pendingMessages";
import { addConversationToWorkItem, linkConversationToEntityBestEffort, linkedEntityIdsForConversation } from "./conversationLinks";
import { agentCommentLevelOf, dropThreadRead, taskCommentAuthorKind, taskCommentIsNews, taskThreadParticipants, touchThread, type TaskCommentAuthorKind } from "./threadReads";
import { extractMentionHandles } from "@codecast/shared/chat";
import { resolveTeamForPath } from "./privacy";
import { watchUntilFor } from "./lib/lineWatch";
import { isLineRun } from "@codecast/shared/contracts/changeCard";
import { cancelCore } from "./workflow_runs";
import { webBaseUrl } from "./slack";
// Owner-or-team access check for a task. Moved to lib/access.ts (Wave-1
// auth/access seam). Imported for local use here and re-exported so existing
// callers keep working unchanged.
import {
  type AuthorizedWorkspace,
  accessStampFromDoc,
  authorizedFor,
  canAccessTask,
  canAccessConversation,
  heldKeysFor,
  parseWorkspaceKey,
  resolveWorkspaceKey,
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
import { findConversationBySessionReference } from "./conversationSessionLookup";
import { forbidden, notFound } from "./lib/auth";
import { boundSessionsOf, claimTaskOwnership, isSessionWorking, type TaskOwnerRef } from "./lib/taskOwner";
import { changeGuideInputValidator } from "./lib/changeGuideValidator";
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
 * be started by any daemon (the "start agent run did nothing" bug). `seed` is the
 * caller's path: it refines the choice inside the task's team and never overrides it.
 */
export async function resolveTaskGitContext(
  ctx: any,
  userId: Id<"users">,
  task: any,
  mappings: any[],
  seed?: { project_path?: string; git_root?: string },
): Promise<{ project_path?: string; git_root?: string; git_remote_url?: string }> {
  let git_root = seed?.git_root;
  let git_remote_url: string | undefined;

  // What the task pins wins: its own path, then its project's. A seed is only
  // trusted past that when it already sits inside the task's team, because the
  // web sends the viewer's open repo as the seed when the task pins nothing —
  // and that repo may belong to another team entirely (a Union task launched
  // three sessions into ~/src/codecast this way). Otherwise the team's mapped
  // directory routes, and a foreign seed is the last resort that keeps a task
  // whose team has no mapping startable at all.
  const project = task.project_id ? await ctx.db.get(task.project_id).catch(() => null) : null;
  const teamKey = task.team_id?.toString();
  const seedInTaskTeam = !!teamKey
    && resolveTeamForPath(mappings, seed?.project_path, undefined).teamId?.toString() === teamKey;
  const project_path: string | undefined =
    task.project_path
    || project?.project_path
    || (seedInTaskTeam ? seed?.project_path : undefined)
    || (teamKey ? mappings.find((m: any) => m.team_id?.toString() === teamKey)?.path_prefix : undefined)
    || seed?.project_path;
  if (!git_root && project_path !== seed?.project_path) git_root = project_path;

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

async function loadTeamTaskStatuses(ctx: any, teamId: Id<"teams"> | undefined | null): Promise<TeamTaskStatus[]> {
  const team = teamId ? await ctx.db.get(teamId) : null;
  return teamTaskStatuses(team?.task_statuses);
}

// Resolve a status write against the team's configured statuses (Linear-style
// custom statuses; see @codecast/shared/tasks/statuses.ts).
//
// - `status` names a category, or a team status by id or name ("today"). A
//   team status in `status` is the same write as sending it as `status_id`,
//   which is how the CLI (`-s today`) reaches the team's own statuses.
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
  let status = args.status;
  let statusId = args.status_id;
  const namesTeamStatus = status !== undefined && !isTaskStatusCategory(status);
  if (namesTeamStatus || statusId) {
    const statuses = await loadTeamTaskStatuses(ctx, teamId);
    if (namesTeamStatus) {
      const named = findTeamTaskStatus(statuses, status!);
      if (!named) {
        throw new Error(`Invalid task status '${status}'. Valid: ${taskStatusChoices(statuses).join(", ")}`);
      }
      if (statusId && statusId !== named.id) {
        throw new Error(`Status '${status}' does not match status_id '${statusId}'`);
      }
      status = undefined;
      statusId = named.id;
    }
    const match = statuses.find((s) => s.id === statusId);
    if (!match) throw new Error(`Unknown status '${statusId}' for this team`);
    if (status && status !== match.category) {
      throw new Error(`Status '${statusId}' is in category '${match.category}', not '${status}'`);
    }
    return { status: match.category, statusId: { set: true, value: match.id === match.category ? undefined : match.id } };
  }
  assertValidTaskStatus(status);
  if (statusId === "" || (status && status !== currentStatus)) {
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
  teamId?: Id<"teams">,
  // "@handle" names one thing exactly; a substring would hand "@ads" to
  // whoever has "ads" in their email.
  opts: { exactOnly?: boolean } = {},
): Promise<Id<"users"> | null> {
  if (!teamId) return null;
  const lower = query.toLowerCase();
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
    .collect();
  // A bot on the roster is a role's seat or the workspace anchor, never a
  // person to assign: a role named "Growth" mints a bot user named "Growth",
  // and matching it here would hand "@growth" to a fake person and never to
  // the role (which is looked up after the people, in resolveAssigneeStr).
  const members = (await Promise.all(memberships.map((m: any) => ctx.db.get(m.user_id)))).filter((u: any) => u && !u.is_bot);
  const exact = members.find((u: any) =>
    u.github_username?.toLowerCase() === lower ||
    u.name?.toLowerCase() === lower ||
    u.email?.toLowerCase() === lower ||
    u.alternate_emails?.some((e: string) => e.toLowerCase() === lower)
  );
  if (exact) return exact._id;
  if (opts.exactOnly) return null;
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

// ── A role as assignee (docs/architecture/org-roles-run-work.md R5) ─────────
//
// `tasks.assignee` holds a user's id or a role's id. A role owns a task only
// inside its own boundary: a team's role takes that team's tasks, a personal
// role its owner's. The by_assignee indexes key on the string either way.

type AssigneeBoundary = {
  team_id?: Id<"teams">;
  scope_user_id?: Id<"users">;
  /** The team a task is ROUTED to when its access boundary is personal (a
   *  task kept private inside a team): where a handle is looked up, on the
   *  roster and among the roles, so "@growth" names the team's role and is
   *  refused for the right reason. Never what a role may take. */
  routed_team_id?: Id<"teams">;
};

const boundaryOfWorkspace = (w: { type: "team"; teamId: Id<"teams"> } | { type: "personal"; userId: Id<"users"> }): AssigneeBoundary =>
  w.type === "team" ? { team_id: w.teamId } : { scope_user_id: w.userId };

/** The boundary a task's assignee must be inside, read from the task's ACCESS
 *  key (its workspace) and never from team_id, which is routing (CLAUDE.md):
 *  a task routed to a team but readable by its owner only is a personal task
 *  to a role, so a team role cannot take it and carry its title into a wake
 *  row and a standing session the whole team reads. */
export async function boundaryOfTask(ctx: { db: any }, task: { user_id: Id<"users">; workspace?: string }): Promise<AssigneeBoundary> {
  const stored = parseWorkspaceKey(await resolveWorkspaceKey(ctx, task));
  return boundaryOfWorkspace(stored ?? { type: "personal", userId: task.user_id });
}

/** boundaryOfTask plus where a handle is looked up: the task's routing team. */
async function assigneeScopeOf(ctx: { db: any }, task: { user_id: Id<"users">; team_id?: Id<"teams">; workspace?: string }): Promise<AssigneeBoundary> {
  return { ...(await boundaryOfTask(ctx, task)), routed_team_id: task.team_id };
}

/** The role an assignee value names, or null when it names anything else. */
export async function roleAssigneeOf(ctx: { db: any }, assignee: string | undefined | null): Promise<any | null> {
  if (!assignee) return null;
  const id = ctx.db.normalizeId("org_roles", assignee);
  return id ? await ctx.db.get(id) : null;
}

/** The role whose seat a bot user is: a role's standing session renders as a
 *  bot user named after the role (anchors.provisionStandingAgent), and a
 *  picker or a stale row may hand that user's id in as the assignee. The task
 *  belongs to the role, never to the bot. Null for a person or a bot with no
 *  role. */
async function roleOfBotUser(ctx: { db: any }, userId: string): Promise<any | null> {
  const id = ctx.db.normalizeId("users", userId);
  const user = id ? await ctx.db.get(id) : null;
  if (!user?.is_bot) return null;
  const anchor = await ctx.db.query("anchors").withIndex("by_bot_user", (q: any) => q.eq("bot_user_id", user._id)).first();
  return anchor?.org_role_id ? await ctx.db.get(anchor.org_role_id) : null;
}

/** Why this role cannot take a task in this boundary, in words for the person
 *  who tried; null when it can. */
function roleAssigneeRefusal(role: any, boundary: AssigneeBoundary): string | null {
  if (role.status === "retired") return `@${role.handle} is retired, so it cannot take tasks. Pick a live role or a person.`;
  if (boundary.team_id) {
    return String(role.team_id ?? "") === String(boundary.team_id) ? null : `@${role.handle} belongs to another workspace, so it cannot take this task.`;
  }
  if (role.team_id) {
    // A team role, and a task only its owner can read (personal, or routed to
    // the team but kept private): the role's wake row and standing session
    // are the team's to read, so the task would leak through them.
    return `This task is readable by its owner only, so a team role cannot take it: @${role.handle} would carry it into a session the team reads. Share the task with the team first, or hand it to a person.`;
  }
  return String(role.scope_user_id ?? "") === String(boundary.scope_user_id ?? "") ? null : `@${role.handle} belongs to another workspace, so it cannot take this task.`;
}

type ResolveAssigneeOpts = {
  /** A read (a list filter) names what a task holds, so a retired role and a
   *  role outside the boundary resolve as they are; only a write refuses. */
  read?: boolean;
};

/**
 * One resolver for every assignee value the CLI, the web and the sync paths
 * write or filter on. A handle ("@growth") is a claim that someone answers
 * to it, resolved the way chat does (lib/mentionResolve): a teammate's login
 * or email wins, then the live role with that handle in the task's
 * boundary. A role outranks the bot user its seat renders as, and a bot is
 * never a person: the role's id is stored, so the role is woken, `--chain`
 * finds the task and the board shows one Growth, not two. A handle nobody
 * answers to is refused rather than stored as a bare string no roster could
 * resolve. A bare word is a person by login or name, else a role by handle,
 * else the word itself (a name typed by hand, kept as it was).
 */
export async function resolveAssigneeStr(
  ctx: any,
  assignee: string | undefined,
  userId: Id<"users">,
  boundary?: AssigneeBoundary,
  opts: ResolveAssigneeOpts = {},
): Promise<string | undefined> {
  if (!assignee) return undefined;
  if (assignee === "me") return userId.toString();
  if (assignee.startsWith("agent:")) return assignee;
  const settle = (role: any): string => {
    const refusal = !opts.read && boundary ? roleAssigneeRefusal(role, boundary) : null;
    if (refusal) throw new Error(refusal);
    return role._id.toString();
  };
  // Where a handle is looked up: the boundary's team, or the team a private
  // task is routed to; a personal boundary looks among the person's own roles.
  const lookupTeam = boundary?.team_id ?? boundary?.routed_team_id;
  const lookupSeat = lookupTeam ? { team_id: lookupTeam } : boundary;
  const roleByHandle = (handle: string) =>
    !lookupSeat ? null : opts.read ? roleByHandleForRead(ctx, lookupSeat, handle) : liveRoleByHandle(ctx, lookupSeat, handle);
  if (/^[a-z0-9]{32}$/.test(assignee)) {
    const role = (await roleAssigneeOf(ctx, assignee)) ?? (await roleOfBotUser(ctx, assignee));
    return role ? settle(role) : assignee;
  }
  if (assignee.startsWith("@")) {
    const handle = assignee.slice(1).trim();
    const match = lookupTeam ? matchHandle(await teamRoster(ctx, lookupTeam), handle) : null;
    if (match && !match.is_bot) return match._id.toString();
    const role = await roleByHandle(handle);
    if (role) return settle(role);
    const anyone = await resolveAssigneeToUserId(ctx, handle, lookupTeam);
    if (!anyone) throw new Error(`Nobody answers to @${handle} in this workspace: no teammate and no live role has that handle. Run cast role ls to see the roles here.`);
    return anyone.toString();
  }
  const lower = assignee.toLowerCase();
  const found = await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", lower)).first();
  if (found) return found._id.toString();
  // A team member's name or email persists a real user id (consistent with a
  // login match) rather than a bare string the roster cannot resolve. The
  // boundary says which team: a write never guesses one from the caller's
  // active team pointer (CLAUDE.md, reads may default, writes must be explicit).
  const memberId = await findTeamMemberId(ctx, assignee, lookupTeam);
  if (memberId) return memberId.toString();
  const role = await roleByHandle(assignee);
  return role ? settle(role) : assignee;
}

// A status change rings nobody by default: the board and the Threads inbox
// carry it. A reader who opts in (notification_preferences.task_status_changes)
// hears only the moves that end a task, done or dropped, and only on tasks
// they take part in (the same participants a comment reaches), like Linear's
// "status changes" setting.
const STATUS_NEWS: ReadonlySet<string> = new Set(["done", "dropped"]);

export async function notifyTaskStatus(
  ctx: any,
  actorUserId: Id<"users">,
  task: { _id: Id<"tasks">; short_id: string; user_id: Id<"users">; assignee?: string; source?: string; creation_source?: string },
  status: string,
  conversationId?: Id<"conversations">,
) {
  if (!STATUS_NEWS.has(status)) return;
  const recipients: Id<"users">[] = [];
  for (const userId of await taskThreadParticipants(ctx, task as any)) {
    const user = await ctx.db.get(userId);
    if (user?.notification_preferences?.task_status_changes === true) recipients.push(userId);
  }
  if (recipients.length === 0) return;
  await ctx.runMutation(internal.notificationRouter.emit, {
    event_type: "task_status_changed",
    actor_user_id: actorUserId,
    entity_type: "task",
    entity_id: task._id.toString(),
    message: `changed ${task.short_id} to ${status}`,
    conversation_id: conversationId,
    recipient_ids: recipients,
  });
}

/** The task's bound run, when it is a line run still going. */
async function liveLineRun(ctx: any, task: any): Promise<any | null> {
  const run = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
  return run && (run.status === "pending" || run.status === "running" || run.status === "paused") && isLineRun(run.node_statuses) ? run : null;
}

/** The line's own stations that close their cause (line.cast): their close is the run's, not a person's. */
const LINE_CLOSING_STATIONS: ReadonlySet<string> = new Set(["drop", "dissolve"]);

/** What a status move does after its patch, for every writer: the plan's
 *  progress, the status notice, the sessions the close releases, the tasks
 *  waiting on it (afterStatusEdges),
 *  and (LE16) a person's close of a cause
 *  stopping its live line run, so the person's decision wins. A move that
 *  changes nothing does none of it. A move with a conversation is a
 *  session's, never a person's. */
export async function afterStatusMove(
  ctx: any,
  task: any,
  next: string | undefined,
  actorUserId: Id<"users">,
  conversationId?: Id<"conversations">,
): Promise<void> {
  if (!next || next === task.status) return;
  if (task.plan_id) await recalcPlanProgress(ctx, task.plan_id, task._id, next);
  await notifyTaskStatus(ctx, actorUserId, task, next, conversationId);
  // A close ends EVERY binding, not just the closing session's: a person or
  // another session closing the task must not leave a third session held on
  // a closed task, which has nothing left to advance and no unblock path
  // that can wake it (every one stops at a terminal status). It lives here
  // because this is the funnel every writer shares — the CLI's update, the
  // board's updateTaskAs, moveTaskStatus (the batch, a signal's watch, the
  // line's runs) — and `conversationId` is passed because the closing
  // session may not be linked to the task.
  if (isTerminalTaskStatus(next)) await releaseBoundSessions(ctx, task, conversationId);
  await afterStatusEdges(ctx, task, next, { actorUserId, conversationId });
  if (!conversationId && isTerminalTaskStatus(next)) {
    const run = await liveLineRun(ctx, task);
    if (run && !LINE_CLOSING_STATIONS.has(run.current_node_id)) await cancelCore(ctx, run, Date.now(), `Stopped: the cause was ${next === "dropped" ? "dropped" : "closed"} by a person`);
  }
}

/**
 * One status move by a writer that is not a person at a form: the line's
 * runs, its watch, and the batch update. It writes the stamps a status
 * carries (closed_at on a close, cleared with resolved_at on a reopen, the
 * attempt on a start, the minutes on a done), the history row, and then
 * afterStatusMove, so the move lands in the task's history and notifies the
 * way a person's change does. `extra` rides the same patch. Returns whether
 * the status moved.
 */
export async function moveTaskStatus(
  ctx: any,
  task: any,
  next: (typeof TASK_STATUS_CATEGORIES)[number],
  // `closedAt`: when the work actually closed, for a writer that records it
  // after the fact (the line's run end and its repair stamp the ship's time).
  o: { actorUserId: Id<"users">; actorType?: "user" | "agent" | "system"; now?: number; closedAt?: number; conversationId?: Id<"conversations">; extra?: Record<string, any> },
): Promise<boolean> {
  const now = o.now ?? Date.now();
  const moved = next !== task.status;
  const updates: Record<string, any> = { ...(o.extra ?? {}), updated_at: now };
  if (moved) {
    // A category change orphans a custom-status refinement (resolveStatusWrite).
    Object.assign(updates, { status: next, status_id: undefined });
    if (isTerminalTaskStatus(next)) updates.closed_at = o.closedAt ?? now;
    else if (isTerminalTaskStatus(task.status)) Object.assign(updates, { closed_at: undefined, resolved_at: undefined });
    if (next === "in_progress") {
      updates.attempt_count = (task.attempt_count || 0) + 1;
      updates.last_attempted_at = now;
      if (!task.started_at) updates.started_at = now;
    }
    if (next === "done" && task.started_at) updates.actual_minutes = Math.round((now - task.started_at) / 60000);
    await recordTaskChange(ctx, task._id, { user_id: o.actorUserId, actor_type: o.actorType ?? "system", conversation_id: o.conversationId }, [["status", task.status, next]], now);
  }
  // The fake test db patches the row in place: afterStatusMove reads the old status.
  const before = { ...task };
  await patchTask(ctx, task, updates);
  await afterStatusMove(ctx, before, next, o.actorUserId, o.conversationId);
  return moved;
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

// A task has a new assignee: tell them. ONE path for every writer (create,
// update, the board, bulk assign), so a person and a role are each told the
// same way wherever the assignment came from.
//
// A person is subscribed, the assigner's follow is handed over when a human
// did it, and they are notified; assigning yourself is not an event. A role
// (org-roles-run-work.md R5) is woken with the task as the cause, a fold row
// on its wake rail. The rail's loop rules decide who counts as somebody else:
// a role's own session or hand taking a task never wakes it, a person or the
// role above it does. The assigner keeps their follow, since a person who
// hands work to a role wants to hear how it went.
async function announceAssignment(
  ctx: any,
  o: { task: { _id: Id<"tasks">; short_id: string; title: string; team_id?: Id<"teams"> }; assignee: string | undefined; actorUserId: Id<"users">; actorName?: string; via: SubscriptionVia; fromConversationId?: Id<"conversations"> },
): Promise<void> {
  if (!o.assignee) return;
  const role = await roleAssigneeOf(ctx, o.assignee);
  if (role) {
    const by = o.actorName || (await ctx.db.get(o.actorUserId))?.name || "Someone";
    await tellRole(ctx, role._id, {
      content: `${by} assigned you ${o.task.short_id} "${(o.task.title ?? "").slice(0, 80)}"`,
      client_id: `assigned:${o.task._id}:${role._id}`,
      from_user_id: o.actorUserId,
      from_conversation_id: o.fromConversationId,
    });
    return;
  }
  const assigneeId = await resolveAssigneeToUserId(ctx, o.assignee, o.task.team_id);
  if (!assigneeId || String(assigneeId) === String(o.actorUserId)) return;
  await subscribeUser(ctx, assigneeId, o.task._id, "assignee", o.via);
  if (o.via === "human") await handoffTaskThread(ctx, o.task._id, o.actorUserId, assigneeId);
  // Ephemeral bookkeeping rings nobody (TG9), and must not touch a fold row either.
  if (await isEphemeralTask(ctx, "task", String(o.task._id))) return;
  if (await foldMachineAssignment(ctx, assigneeId, o)) return;
  await ctx.runMutation(internal.notificationRouter.emit, {
    event_type: "task_assigned",
    actor_user_id: o.actorUserId,
    entity_type: "task",
    entity_id: o.task._id.toString(),
    message: `assigned you to ${o.task.short_id}: ${o.task.title}`,
    direct_recipient_id: assigneeId,
  });
}

// An agent or a bot account assigning work does it in bursts (a board sweep
// handed one person 45 tasks in a minute). While the last such row from the
// same actor is still unread and recent, a new assignment folds into it: one
// row that counts, pointing at the newest task, and no second push.
const ASSIGNMENT_FOLD_WINDOW_MS = 30 * 60 * 1000;

async function foldMachineAssignment(
  ctx: any,
  assigneeId: Id<"users">,
  o: { task: { _id: Id<"tasks">; short_id: string; title: string }; actorUserId: Id<"users">; via: SubscriptionVia },
): Promise<boolean> {
  if (o.via !== "agent" && !(await ctx.db.get(o.actorUserId))?.is_bot) return false;
  const now = Date.now();
  const recent = await ctx.db
    .query("notifications")
    .withIndex("by_recipient_created", (q: any) => q.eq("recipient_user_id", assigneeId).gt("created_at", now - ASSIGNMENT_FOLD_WINDOW_MS))
    .order("desc")
    .take(50);
  const open = recent.find((n: any) => n.type === "task_assigned" && !n.read && String(n.actor_user_id) === String(o.actorUserId));
  if (!open) return false;
  const count = (open.fold_count ?? 1) + 1;
  await ctx.db.patch(open._id, {
    fold_count: count,
    entity_id: o.task._id.toString(),
    message: `assigned you ${count} tasks, latest ${o.task.short_id}: ${o.task.title}`,
    created_at: now,
  });
  return true;
}

/**
 * At retire, a role's open tasks go to the role that owns their work now, by
 * the one ownership rule (org-staffing.md S26: the area falls back to the
 * wider role), else up the chain to whoever it reported to
 * (org-roles-run-work.md R5): the work is still the company's, and whoever
 * takes it answers for it now, told the way any assignment is. Closed tasks
 * keep the retired role's name; the chain still reads them under the same
 * person (contracts/orgAssignee). Called by orgRoles.performRetireRole.
 */
export async function handOpenTasksUpChain(ctx: any, role: any, actorUserId: Id<"users">): Promise<number> {
  const up = role.reports_to;
  const chain = up?.kind === "user" ? String(up.user_id) : up?.kind === "role" ? String(up.role_id) : String(role.host_user_id);
  const remaining = (await allRolesInBoundary(ctx, role)).filter((r) => String(r._id) !== String(role._id));
  const held: any[] = await ctx.db
    .query("tasks")
    .withIndex("by_assignee_updated", (q: any) => q.eq("assignee", String(role._id)))
    .collect();
  const now = Date.now();
  let moved = 0;
  for (const task of held) {
    if (task.status === "done" || task.status === "dropped") continue;
    const owner = ownerOf(await taskWork(ctx, task), remaining);
    await handTask(ctx, task, owner.kind === "owner" ? String(owner.role._id) : chain, actorUserId, `${role.name} (retired)`, now);
    moved++;
  }
  return moved;
}

/** One task changes hands between the roles and people of the org: a history
 *  row, the patch, and the assignment told the way any assignment is. A
 *  retire's hand back and a takeover's hand over (orgInit.takeOverSessions)
 *  both go through here. */
export async function handTask(ctx: any, task: any, to: string, actorUserId: Id<"users">, actorName: string, now = Date.now()): Promise<void> {
  await recordTaskChange(ctx, task._id, byUser(actorUserId), [["assignee", task.assignee, to]], now);
  await patchTask(ctx, task, { assignee: to, updated_at: now });
  await announceAssignment(ctx, { task, assignee: to, actorUserId, actorName, via: "human" });
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
export async function reconcilePlanMembership(
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
export async function openDirectSubtasks(ctx: any, taskId: Id<"tasks">): Promise<any[]> {
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

export const REVIEW_VERDICTS = ["approve", "changes", "reject"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Is `conv` the conversation `ancestorId`, or a fork of it (at any depth
 *  that a real fork chain reaches)? A fork carries the filing session's whole
 *  history under a new conversation id, so its start of a task that session
 *  filed is the same session's bookkeeping, not a takeover. */
async function isForkLineOf(ctx: any, conv: any, ancestorId: string): Promise<boolean> {
  let cur: any = conv;
  for (let depth = 0; cur && depth < 16; depth++) {
    if (String(cur._id) === String(ancestorId)) return true;
    cur = cur.forked_from ? await ctx.db.get(cur.forked_from) : null;
  }
  return false;
}

/** The role a session works for: the one it reports to, or the one whose standing session it is. */
export const roleOf = (conv: any): string | undefined =>
  conv?.org_role_id ? String(conv.org_role_id) : conv?.standing_role_id ? String(conv.standing_role_id) : undefined;

// The role that takes a task when `conv` starts it: the role the session
// reports to, or the role whose standing session it is. Null when the session
// works for no role, when the task already names a person (a user, or a name
// nobody resolved: either way a human meant someone), or when the role cannot
// own a task here (retired, another workspace). Another role's task does move:
// the work is now being done under this one, and the chain view still rolls
// it up to the same person when one reports to the other.
//
// Taking over, not creating: every task with an assignee shows on the
// person's default board (`isOnHumanBoard`), which is right for work a role
// takes over and wrong for a session's own bookkeeping. So a task this same
// session filed stays unassigned and internal as it is today, and a subtask
// stays nested under its parent with no assignee of its own; the parent says
// who answers for the work.
async function roleTakingTask(ctx: any, task: any, conv: any, boundary: AssigneeBoundary): Promise<any | null> {
  const roleId = roleOf(conv);
  if (!roleId) return null;
  if (task.parent_id) return null;
  if (task.created_from_conversation && (await isForkLineOf(ctx, conv, task.created_from_conversation))) return null;
  const current: string | undefined = task.assignee || undefined;
  if (current && !current.startsWith("agent:") && !(await roleAssigneeOf(ctx, current))) return null;
  const role = await roleAssigneeOf(ctx, roleId);
  return role && !roleAssigneeRefusal(role, boundary) ? role : null;
}


/**
 * The hold (docs/architecture/the-line.md L5). A pending, blocking decision
 * bound to the task whose station equals the task's current status keeps
 * the task there. Returns that decision when the write would move the task
 * (a new category, or a new team status inside the category), else null.
 * The two status mutations apply the rule before any write: a session actor
 * is refused, a person moves past it and a note comment names the decision.
 * Server internal patches (a run's node start and end, pauseAtGate) do not
 * pass through here and are not held. Nothing is written for a hold: the
 * task page derives "held at" from the open decisions by_task.
 */
export async function holdingDecisionFor(
  ctx: any,
  task: any,
  nextStatus: string | undefined,
  nextStatusId?: { set: boolean; value?: string },
): Promise<any | null> {
  const categoryMoves = !!nextStatus && nextStatus !== task.status;
  const refinementMoves = !!nextStatusId?.set && (nextStatusId.value ?? undefined) !== (task.status_id ?? undefined);
  if (!categoryMoves && !refinementMoves) return null;
  const station = task.status_id ?? task.status;
  const pending: any[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_task", (q: any) => q.eq("task_id", task._id).eq("status", "pending"))
    .collect();
  return pending.find((d) => d.blocking && d.station === station) ?? null;
}

// The refusal a session actor gets (L5); the text names the release path.
export function heldError(hold: any): Error {
  const ref = hold.short_id ?? hold._id;
  return new Error(`Held at ${hold.station} by ${ref}: answer it first (cast decide answer ${ref} <n>)`);
}

// The note a person leaves when moving a held task past its open decision (L5).
async function noteMovedPastHold(ctx: any, task: any, hold: any, nextStatus: string, author: string, actorId?: Id<"users">) {
  const ref = hold.short_id ?? hold._id;
  await insertTaskComment(
    ctx,
    task._id,
    { author, text: `Moved past ${ref} (held at ${hold.station}) to ${nextStatus}; the decision stays open.`, comment_type: "note" },
    actorId,
  );
}

/** Release every session bound to a task that just closed, so none is left
 *  on a closed task: the task's linked sessions and `conversationId` (the
 *  closing session, which may not be linked). The binding ended, so a session
 *  held only for it returns to its starter (S35). */
export async function releaseBoundSessions(ctx: any, task: any, conversationId?: Id<"conversations">): Promise<void> {
  const ids = new Set([...(task.conversation_ids ?? []), ...(conversationId ? [conversationId] : [])].map(String));
  for (const convId of ids) {
    const conv: any = await ctx.db.get(convId as Id<"conversations">);
    if (!conv || String(conv.active_task_id ?? "") !== String(task._id)) continue;
    await ctx.db.patch(conv._id, { active_task_id: undefined });
    await ctx.scheduler.runAfter(0, internal.sessionOwnership.reconcileHold, { conversation_id: conv._id });
  }
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
  const closing = new Set([String(parent._id), ...ids.map(String)]);
  for (const id of ids) {
    const t: any = await ctx.db.get(id);
    if (!t || !isSameWorkspace(t, scope)) continue;
    // status_id cleared: the cascade moves the subtree to a terminal category,
    // so any custom-status refinement from the old category is stale.
    await patchTask(ctx, t, { status: newStatus, status_id: undefined, closed_at: now, updated_at: now });
    await releaseBoundSessions(ctx, t);
    await recordTaskChange(ctx, id, { user_id: userId, actor_type: "system" }, [["status", t.status, newStatus]], now);
    // The parent's own release (afterStatusMove) runs after this one.
    await afterStatusEdges(ctx, t, newStatus, { actorUserId: userId, closingLater: parent, closing });
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
    await patchTask(ctx, parent, {
      status: "in_progress",
      // The old refinement belonged to the open/backlog category; stale now.
      status_id: undefined,
      updated_at: now,
      last_attempted_at: now,
      attempt_count: (parent.attempt_count || 0) + 1,
    });
    await recordTaskChange(ctx, parent._id, { user_id: task.user_id, actor_type: "system" }, [["status", parent.status, "in_progress"]], now);
    // A top-level parent may sit on a plan; keep the plan bar honest.
    if (parent.plan_id && !parent.parent_id) {
      await recalcPlanProgress(ctx, parent.plan_id, parent._id, "in_progress");
    }
    cursor = parent.parent_id;
  }
}

// ── Outbound issue sync (docs/architecture/issue-sync.md S5) ──
// Field writes push through lib/taskWrite.patchTask (every synced-field write
// on a task goes through it, never a raw patch). Comments and new tasks
// schedule here: the inbound path (issueSync.applyRemote) never schedules a
// push, which is what keeps provider and codecast from echoing at each other
// (S4.1).

async function schedulePushComment(ctx: any, task: any, commentId: Id<"task_comments">) {
  if (!task?.external) return;
  await ctx.scheduler.runAfter(0, internal.issueSync.pushComment, { comment_id: commentId });
}

/** A task born in a project whose source mirrors new tasks gets a provider twin. */
async function schedulePushNewTask(ctx: any, projectId: Id<"projects"> | undefined, taskId: Id<"tasks">) {
  if (!projectId) return;
  const source = await ctx.db
    .query("issue_sync_sources")
    .withIndex("by_project", (q: any) => q.eq("project_id", projectId))
    .first();
  if (source?.status === "active" && source.push_new_tasks) {
    await ctx.scheduler.runAfter(0, internal.issueSync.pushNewTask, { task_id: taskId });
  }
}

/** `cast task keep` turns bookkeeping into real work: it gets the provider
 *  twin its ephemeral birth skipped (task-graph.md TG9). */
async function schedulePushKeptTask(ctx: any, task: any, updates: Record<string, any>) {
  if (!task.ephemeral || !("ephemeral" in updates) || updates.ephemeral) return;
  await schedulePushNewTask(ctx, "project_id" in updates ? updates.project_id : task.project_id, task._id);
}

/**
 * Who answers for a task a session files for people to see (a person's ask, a
 * meeting's decision, or `--human`) without naming an assignee: the role that
 * session works for (its standing seat, or the role it reports to), else the
 * person running it. A role this workspace cannot hold falls back to the
 * person. A session's own bookkeeping stays unowned, because an assignee puts
 * a task on the person's board (isOnHumanBoard).
 */
async function defaultSessionOwner(
  ctx: any,
  conv: any,
  forPeople: boolean,
  userId: Id<"users">,
  boundary: AssigneeBoundary,
): Promise<string | undefined> {
  if (!conv || !forPeople) return undefined;
  const role = await roleOfConversation(ctx, conv);
  return role && !roleAssigneeRefusal(role, boundary) ? String(role._id) : String(userId);
}

/** A `from_call` write: the call a task was pulled from, named as prose names
 *  it (`cl-42` or a full id) and readable by the writer. Undefined writes
 *  nothing; "" clears the link. */
async function resolveFromCall(ctx: any, userId: Id<"users">, ref: string | undefined): Promise<Id<"transcripts"> | null | undefined> {
  if (ref === undefined) return undefined;
  if (!ref.trim()) return null;
  const call = await resolveCallRef(ctx, userId, ref);
  if (!call) notFound(`Call not found: ${ref}`);
  return call._id;
}

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    // `cast task create --from-call cl-42`: the call this task came out of.
    from_call: v.optional(v.string()),
    client_key: v.optional(v.string()),
    // `cast task create --team <name>|personal`: an explicit workspace wins
    // over the session's team and the directory rule (writes are explicit).
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
    description: v.optional(v.string()),
    task_type: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    project_id: v.optional(v.string()),
    parent_id: v.optional(v.string()),
    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    blocked_by: v.optional(v.array(v.string())),
    // TG2/TG3: blocker refs that are not tasks (#42, sd-4, 2h), added in this
    // mutation (addWaitsAtCreate); repository resolves a bare #42.
    waits: v.optional(v.array(v.string())),
    repository: v.optional(v.string()),
    time_zone: v.optional(v.string()),
    // TG5: the task this was found while working on; "none" skips the default
    // (the task the creating session is bound to).
    found_during: v.optional(v.string()),
    source: v.optional(v.string()),
    confidence: v.optional(v.number()),
    // Agent-created tasks are internal by default; promoted:true puts the task
    // on the human's default board (same field the triage promote flow sets).
    promoted: v.optional(v.boolean()),
    conversation_id: v.optional(v.string()),
    insight_id: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    max_retries: v.optional(v.number()),
    // model, effort and ephemeral (TG8, TG9).
    ...executionHintArgs,
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
    // Blockers are stored canonical, and a wait-shaped one becomes a wait.
    args = { ...args, ...storedGraphRefs(ctx, args, { waits: true }) };

    // The session the task came from links it and, when team visible, hands
    // it its team (createWorkContext).
    const { db, conversation: originConv } = await createWorkContext(ctx, {
      userId: auth.userId,
      project_path: args.project_path,
      workspace: args.workspace,
      team_id: args.team_id,
      conversation_id: args.conversation_id,
    });
    const conversation_ids: Id<"conversations">[] | undefined = originConv ? [originConv._id] : undefined;
    const created_from_conversation: Id<"conversations"> | undefined = originConv?._id;
    // Same status rule as webCreate: a team status by name ("today") lands as
    // its category plus status_id.
    const statusWrite = await resolveStatusWrite(
      ctx,
      db.workspace.type === "team" ? db.workspace.teamId : undefined,
      undefined,
      args,
    );
    const now = Date.now();
    const unkeyedShortId = args.client_key ? undefined : await nextShortId(ctx.db, "ct");

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

    const from_call = (await resolveFromCall(ctx, auth.userId, args.from_call)) ?? undefined;
    const found_during = await foundDuringForCreate(ctx, auth.userId, { explicit: args.found_during, conversation: originConv, workspace: db.workspace, parent_id, plan_id });

    // Creator enrollment is human only when a person decided the task: human
    // or meeting origin, or an explicit promotion to the human board. An
    // agent's own work task enrolls its owner as an agent act.
    const createdHuman = isHumanOrigin({ source: args.source || "human" }) || !!args.promoted;
    const boundary = boundaryOfWorkspace(db.workspace);
    const resolvedAssignee = args.assignee
      ? await resolveAssigneeStr(ctx, args.assignee, auth.userId, boundary)
      : await defaultSessionOwner(ctx, originConv, createdHuman && !parent_id, auth.userId, boundary);

    if (args.client_key) {
      const existing = await ctx.db
        .query("tasks")
        .withIndex("by_client_key", (q) => q.eq("user_id", auth.userId).eq("client_key", args.client_key!))
        .first();
      if (existing) {
        if (!(await canAccessTask(ctx, auth.userId, existing))) notFound("Task not found");
        requireSameWorkspace(existing, db.workspace, "task");
        if (existing.project_id !== project_id || existing.plan_id !== plan_id || existing.parent_id !== parent_id || existing.created_from_conversation !== created_from_conversation) {
          throw new Error("Task client key belongs to a different context");
        }
        return { id: existing._id, short_id: existing.short_id };
      }
    }
    const short_id = unkeyedShortId ?? await nextShortId(ctx.db, "ct");
    // Blockers in another workspace are refused (readiness could never clear
    // them), and a task can be named before it exists (a blocked_by ref to the
    // next id), so even a new task's blockers may already wait on it (TG4).
    await assertDependencyEdges(ctx, { short_id, blocked_by: args.blocked_by }, db.workspace, { blocked_by: args.blocked_by });

    const id = await db.insert("tasks", {
      project_id,
      parent_id,
      plan_id,
      short_id,
      title: args.title,
      client_key: args.client_key,
      description: args.description,
      task_type: (args.task_type || "task") as any,
      status: (statusWrite.status || "open") as any,
      status_id: statusWrite.statusId.set ? statusWrite.statusId.value : undefined,
      priority: (args.priority || "medium") as any,
      assignee: resolvedAssignee,
      labels: args.labels,
      blocked_by: args.blocked_by,
      blocks: [],
      conversation_ids,
      created_from_conversation,
      created_from_insight: args.insight_id as any,
      from_call,
      found_during,
      source: (args.source || "human") as any,
      triage_status: args.source === "insight" ? "suggested" : "active",
      confidence: args.confidence,
      promoted: args.promoted || undefined,
      attempt_count: 0,
      retry_count: 0,
      max_retries: args.max_retries ?? 3,
      ...executionHintPatch(args),
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

    // Each task blocker as it landed, so the caller can echo the edge and say
    // when a blocker is already done or dropped and so holds nothing (depAddedLine,
    // the same line `cast task dep` prints). A ref naming no readable task keeps
    // the write and reports no status.
    const blockers: Array<{ ref: string; status?: string }> = [];
    for (const dep of args.blocked_by || []) {
      const other = await patchDepMirror(ctx, auth.userId, { short_id, workspace: db.workspace }, dep, "blocks", "add");
      blockers.push({ ref: other?.short_id ?? dep, ...(other ? { status: other.status } : {}) });
    }
    // The graph fields this create wrote are its first history rows (TG11), so
    // a blocker named at create reads in the timeline the way `cast task dep`
    // writes it; the waits of the same create record themselves in writeWaits.
    const born: TaskFieldChange[] = [
      ...(args.blocked_by?.length ? [["blocked_by", "", args.blocked_by] as TaskFieldChange] : []),
      ...(found_during ? [["found_during", "", found_during] as TaskFieldChange] : []),
    ];
    if (born.length) await recordTaskChange(ctx, id, { user_id: auth.userId, actor_type: originConv ? "agent" : "user", conversation_id: created_from_conversation }, born, now);
    const waits = await addWaitsAtCreate(ctx, auth.userId, short_id, args);

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

    await subscribeUser(ctx, auth.userId, id, "creator", createdHuman ? "human" : "agent");
    // A subtask created directly in progress flips its parent chain, same as a
    // later start would — the parent must never sit "open" under running work.
    if (parent_id) {
      await rollUpParentStart(ctx, { parent_id, user_id: auth.userId }, statusWrite.status);
    }
    // A defaulted owner filed the task itself: nobody assigned it to them.
    if (resolvedAssignee && args.assignee) {
      const createdTask = await ctx.db.get(id) as any;
      await announceAssignment(ctx, { task: createdTask, assignee: resolvedAssignee, actorUserId: auth.userId, via: cliVia(args), fromConversationId: created_from_conversation });
    }

    await schedulePushNewTask(ctx, project_id, id);

    // session_bound: the creating session holds a task, so the CLI keeps its
    // pulse there rather than move it to what it filed along the way (TG10).
    // found_during, so the CLI can name the link a bound session made (TG5).
    return { id, short_id, ...(waits ? { waits } : {}), ...(blockers.length ? { blockers } : {}), ...(originConv?.active_task_id ? { session_bound: true } : {}), ...(found_during ? { found_during } : {}) };
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
            planLines.push(`Active Plan: ${inlineForeignText(plan.title)} (${plan.short_id}) [${plan.status}]`);
            if (plan.goal) planLines.push(`Goal: ${inlineForeignText(plan.goal)}`);
            if (plan.progress) {
              const p = plan.progress;
              planLines.push(`Progress: ${p.done}/${p.total} done, ${p.in_progress} in progress, ${p.open} open`);
            }
            if (plan.task_ids) {
              for (const tid of plan.task_ids.slice(0, 10)) {
                const t = await ctx.db.get(tid);
                // Skip subtasks that predate the task_ids exclusion rule.
                if (t && !t.parent_id) planLines.push(`  - ${t.short_id}: ${inlineForeignText(t.title)} [${t.status}]`);
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
          lines.push(`- ${t.short_id}: ${inlineForeignText(t.title)}${owner ? ` (${inlineForeignText(owner)})` : ""}${t.labels?.length ? ` [${inlineForeignText(t.labels.join(", "))}]` : ""}${progressNote(t)}`);
        }
      }

      if (open.length > 0) {
        lines.push("Open:");
        for (const t of open.slice(0, 10)) {
          const owner = userMap.get(t.user_id.toString()) || "";
          lines.push(`- ${t.short_id}: ${inlineForeignText(t.title)}${owner ? ` (${inlineForeignText(owner)})` : ""}${t.priority === "high" || t.priority === "urgent" ? ` [${t.priority}]` : ""}${progressNote(t)}`);
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
              lines.push(`${indent}- ${c.short_id}: ${inlineForeignText(c.title)} [${c.status}]`);
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
            lines.push(`Your task ${bound.short_id}: ${inlineForeignText(bound.title)} [${bound.status}]${bp ? ` — subtask of ${bp.short_id} ${inlineForeignText(bp.title)}` : ""}`);
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
        lines.push(`- ${inlineForeignText(p.title)} (${p.doc_type})`);
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

// Who a set of assignee values names, in the contract's shape
// (@codecast/shared/contracts/orgAssignee): a role with its face and handle,
// a person with their name and login. `agent:*` assignees are already names.
// Unknown values are left out so callers can print the raw value rather than
// nothing.
async function assigneeInfoFor(ctx: any, assignees: (string | undefined)[]): Promise<Record<string, AssigneeInfo>> {
  const out: Record<string, AssigneeInfo> = {};
  for (const id of new Set(assignees.filter(Boolean) as string[])) {
    if (id.startsWith("agent:")) {
      out[id] = { name: id };
      continue;
    }
    const role = await roleAssigneeOf(ctx, id);
    if (role) {
      out[id] = roleAssigneeInfo(role);
      continue;
    }
    const user = /^[a-z0-9]{32}$/.test(id) ? await ctx.db.get(id as any).catch(() => null) as any : null;
    if (user?.name || user?.github_username) out[id] = { name: user.name || user.github_username, github_username: user.github_username, image: user.image || user.github_avatar_url };
  }
  return out;
}

/** The CLI names a role the way a person types it: "@growth". */
const assigneeNameOf = (info: AssigneeInfo | undefined): string | undefined =>
  !info ? undefined : info.kind === "role" ? `@${info.handle}` : info.name;

// Display names for a set of assignee values; see assigneeInfoFor.
export async function assigneeNamesFor(ctx: any, assignees: (string | undefined)[]): Promise<Record<string, string>> {
  const info = await assigneeInfoFor(ctx, assignees);
  return Object.fromEntries(Object.entries(info).map(([id, i]) => [id, assigneeNameOf(i)!]));
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
    // `cast task ls --initiative in-N`: the tasks of the initiative's projects.
    initiative: v.optional(v.string()),
    status: v.optional(v.string()),
    execution_status: v.optional(v.string()),
    ready: v.optional(v.boolean()),
    // With ready: also surface open subtasks of actively-worked parents.
    include_subtasks: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    team: v.optional(v.boolean()),
    // An explicit workspace (`cast task ls --team <name>|personal`): a named
    // team, or the personal workspace as a positive value, whatever the
    // active team pointer or the directory mapping says.
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
    include_derived: v.optional(v.boolean()),
    include_done: v.optional(v.boolean()),
    project_path: v.optional(v.string()),
    query: v.optional(v.string()),
    assignee: v.optional(v.string()),
    // A person ("me", a name, a handle): their tasks plus the tasks of every
    // role that reports up to them (`cast task ls --chain me`). The chain is
    // read from the roles' reports_to at query time, never stored on a task
    // (org-roles-run-work.md R5).
    chain: v.optional(v.string()),
    plan_id: v.optional(v.string()),
    // Case-insensitive match against the task's labels (CLI --label).
    label: v.optional(v.string()),
    // Ephemeral bookkeeping (TG9) is left out unless asked for; the ready
    // frontier keeps the caller's own: the asking session's (conversation_id,
    // as `cast task ready` sends it), else the person's.
    include_ephemeral: v.optional(v.boolean()),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    if (args.chain && args.assignee) throw new Error("Use --assignee or --chain, not both: --chain already covers the person and every role under them.");

    let teamIdForScope: Id<"teams"> | undefined;
    if (args.team) {
      const user = await ctx.db.get(auth.userId);
      teamIdForScope = user?.active_team_id || user?.team_id;
    }
    const db = await createDataContext(ctx, {
      userId: auth.userId,
      project_path: args.project_path,
      ...explicitWorkspace(args, args.team && teamIdForScope ? { workspace: "team" as const, team_id: teamIdForScope } : {}),
    });

    // The assignee values to read: one for --assignee, the person and every
    // role under them for --chain.
    const boundary = boundaryOfWorkspace(db.workspace);
    let assignees: string[] = [];
    // A read names what a task holds: a retired role's tasks can still be
    // listed by its handle or id, where a write would refuse the role.
    if (args.assignee) {
      const one = await resolveAssigneeStr(ctx, args.assignee, auth.userId, boundary, { read: true });
      if (one) assignees = [one];
    } else if (args.chain) {
      const head = await resolveAssigneeToUserId(ctx, (await resolveAssigneeStr(ctx, args.chain, auth.userId, boundary, { read: true })) ?? "", boundary.team_id);
      if (!head) throw new Error(`No person matches "${args.chain}". --chain takes a person: me, a name or a GitHub handle.`);
      assignees = chainAssignees(head, await allRolesInBoundary(ctx, boundary));
    }

    let tasks: any[];
    // The assignee and project_id indexes are global — they return rows the
    // caller may not be able to see, so those two branches get an explicit
    // owner-or-team-member filter below. The other branches are already
    // user/workspace-scoped.
    let needsAccessFilter = false;
    if (assignees.length > 0) {
      // When filtering by assignee, query the assignee index directly so
      // tasks assigned to the user but missing team_id aren't dropped by
      // the workspace-scoped query.
      tasks = (await Promise.all(assignees.map((assignee) => ctx.db
        .query("tasks")
        .withIndex("by_assignee_updated", (q: any) => q.eq("assignee", assignee))
        .collect()))).flat();
      needsAccessFilter = true;
    } else if (args.project_id || args.initiative) {
      // A task reaches an initiative through its project. With both flags the
      // project must be one the initiative names. projectTasks decides access
      // from each row's workspace stamp, the way `cast initiative show`
      // counts, so a task routed to a team but readable by its owner only is
      // not listed to the team.
      const inInitiative = args.initiative ? (await requireInitiative(ctx, auth.userId as Id<"users">, args.initiative)).project_ids.map(String) : null;
      const projectIds: string[] = args.project_id ? (!inInitiative || inInitiative.includes(args.project_id) ? [args.project_id] : []) : inInitiative!;
      tasks = (await Promise.all(projectIds.map((projectId) => projectTasks(ctx, auth.userId as Id<"users">, projectId as any)))).flat();
    } else {
      // The status filters below run in the database first where they can, so
      // rows they would drop never reach JS memory: finished work is most of a
      // team's table. A team status name ("today") is resolved per row below.
      let scoped = db.query("tasks");
      if (isTaskStatusCategory(args.status)) {
        scoped = scoped.filter((q: any) => q.eq(q.field("status"), args.status));
      } else if (!args.status && !args.include_done) {
        scoped = scoped.filter((q: any) => q.and(...TERMINAL_TASK_CATEGORIES.map((s) => q.neq(q.field("status"), s))));
      }
      tasks = await scoped.collect();
    }

    if (needsAccessFilter) {
      // Access is the row's workspace stamp, never the team it is routed to
      // (CLAUDE.md): a teammate's task routed to the team but readable by its
      // owner only is not listed to whoever asks for the role's tasks. The
      // keys the caller holds are read once; a row with a stored key is judged
      // in memory by the access layer's own evaluator, and a row minted before
      // the key backfill takes the lazy path.
      const held = await heldKeysFor(ctx, auth.userId);
      const keep = await Promise.all(tasks.map((t: any) =>
        t.workspace ? authorizedFor(accessStampFromDoc("tasks", t), String(auth.userId), held) : canAccessTask(ctx, auth.userId, t)));
      tasks = tasks.filter((_: any, i: number) => keep[i]);
    }

    // Each task resolves against its own team's statuses, loaded once per team.
    const teamStatuses = new Map<string, Promise<TeamTaskStatus[]>>();
    const statusesOf = (t: any) => {
      const key = String(t.team_id ?? "");
      if (!teamStatuses.has(key)) teamStatuses.set(key, loadTeamTaskStatuses(ctx, t.team_id));
      return teamStatuses.get(key)!;
    };

    if (args.status) {
      // A category matches every task in it; a team status ("today") matches
      // the tasks that render as that status.
      const ref = args.status;
      const keep = await Promise.all(tasks.map(async (t: any) => {
        if (isTaskStatusCategory(ref)) return t.status === ref;
        const statuses = await statusesOf(t);
        return findTeamTaskStatus(statuses, ref)?.id === resolveTaskStatus(t, statuses).id;
      }));
      tasks = tasks.filter((_: any, i: number) => keep[i]);
    } else if (!args.include_done) {
      tasks = tasks.filter((t: any) => !TERMINAL_TASK_CATEGORIES.includes(t.status));
    }

    if (!args.include_derived) {
      tasks = tasks.filter((t: any) => !t.triage_status || t.triage_status === "active");
    }
    if (!args.include_ephemeral && !args.ready) tasks = tasks.filter((t: any) => !t.ephemeral);

    if (args.execution_status) {
      tasks = tasks.filter((t: any) => t.execution_status === args.execution_status);
    }

    if (args.plan_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_id!))
        .first();
      // A named read key the caller cannot read is refused, not answered with
      // an empty page: access, so canAccessPlan and not the workspace this
      // read resolved to — a plan of the caller's other workspace still names
      // its own tasks, and the intersection below scopes the answer.
      if (!plan || !(await canAccessPlan(ctx, auth.userId, plan))) notFound("Plan not found");
      const planTaskIds = new Set((plan.task_ids || []).map((id: any) => String(id)));
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

    // Ready is graph.ts's rule (task-graph.md TG1). Blockers and parents the
    // filtered page dropped are read from the database: a finished blocker is
    // exactly what the default page leaves out. `include_subtasks` (CLI
    // --subtasks) counts subtasks of a parent being worked.
    const asker = args.conversation_id ? await resolveSessionConversation(ctx, auth.userId, args.conversation_id) : null;
    const readiness = { viewer: String(auth.userId), viewerSession: asker ? String(asker._id) : null, includeSubtasks: args.include_subtasks };
    let lookupsFor: Awaited<ReturnType<typeof readinessLookups>> | undefined;
    if (args.ready) ({ ready: tasks, lookupsFor } = await readyTasks(ctx, tasks, readiness));

    // The frontier reads in the order work should be taken (TG7); every other
    // list reads newest first.
    const now = Date.now();
    if (args.ready) tasks = await orderFrontier(ctx, tasks, now);
    else tasks.sort((a: any, b: any) => (b.updated_at || b._creationTime || 0) - (a.updated_at || a._creationTime || 0));
    const limit = args.limit || 300;
    const result = tasks.slice(0, limit);

    const assigneeInfo = await assigneeInfoFor(ctx, result.map((t: any) => t.assignee));
    const statusNames = await Promise.all(result.map(async (t: any) => resolveTaskStatus(t, await statusesOf(t)).name));
    // Every row carries its verdict and open blockers, so the CLI's "blocked"
    // tag and counts render from the rule, never from a raw blocked_by.
    const lookupsOf = lookupsFor ?? await readinessLookups(ctx, result);
    return result.map((t: any, i: number) => {
      const { statusOf, parentStatusOf } = lookupsOf(t);
      return {
        ...t,
        status_name: statusNames[i],
        assignee_name: t.assignee ? (assigneeNameOf(assigneeInfo[t.assignee]) || t.assignee) : undefined,
        // The contract's shape (orgAssignee.ts), so the CLI tells a role from a
        // person by `kind`, never by the look of a label.
        assignee_info: t.assignee ? (assigneeInfo[t.assignee] ?? null) : null,
        parent_short_id: (t.parent_id ? statusOf(String(t.parent_id)) : undefined)?.short_id ?? undefined,
        // A ready page holds only rows readyTasks already judged ready.
        ready: args.ready ? true : readinessOf(t, { statusOf, parentStatusOf, ...readiness }).ready,
        // Structured (TG1): the reader labels them, a time wait in its own
        // zone. A closed task holds nothing, which blockersHoldingBack itself
        // decides, so no reader marks it blocked.
        open_blockers: blockersHoldingBack(t, statusOf),
        // Untouched 30+ days: the frontier folds it into a count (TG7).
        ...(args.ready ? { stale: isStaleTask(t, now) } : {}),
      };
    });
  },
});

export const get = query({
  args: {
    api_token: v.string(),
    short_id: v.optional(v.string()),
    id: v.optional(v.string()),
    /** The asking session: whether it HOLDS the task comes back as `held`. A
     *  caller's own pulse file cannot answer it — nothing clears the pulse when
     *  another session takes the task over — and only the holder is woken when
     *  a blocker clears (TG2), so the CLI's parking line asks here. */
    conversation_id: v.optional(v.string()),
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

    const comments = await taskCommentsWithSessionInfo(ctx, task!._id, auth.userId);

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

    // The audit trail: who made the task and every recorded change since. The
    // web page shows the same rows in its Activity timeline.
    const history = await ctx.db
      .query("task_history")
      .withIndex("by_task_id", (q) => q.eq("task_id", task!._id))
      .collect();
    const assigneeNames = await assigneeNamesFor(ctx, [
      task.assignee,
      task.user_id,
      ...history.flatMap((h) => [h.user_id, ...(h.field === "assignee" ? [h.old_value, h.new_value] : [])]),
    ]);
    const plan = task.plan_id ? await ctx.db.get(task.plan_id) : null;
    return {
      ...task,
      creator_name: assigneeNames[task.user_id],
      history: history.map((h) => ({
        created_at: h.created_at,
        actor: h.user_id ? assigneeNames[h.user_id] : h.actor_type,
        action: h.action,
        field: h.field,
        old_value: h.field === "assignee" && h.old_value ? (assigneeNames[h.old_value] ?? h.old_value) : h.old_value,
        new_value: h.field === "assignee" && h.new_value ? (assigneeNames[h.new_value] ?? h.new_value) : h.new_value,
        session: h.conversation_id ? h.conversation_id.toString().slice(0, 7) : undefined,
      })),
      status_name: resolveTaskStatus(task, await loadTeamTaskStatuses(ctx, task.team_id)).name,
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
      links: await taskLinksOf(ctx, auth.userId, task),
      not_ready: await offFrontierReason(ctx, task),
      ...(args.conversation_id ? { held: await heldBySession(ctx, auth.userId, task, args.conversation_id) } : {}),
    };
  },
});

/** Does `sessionRef` hold this task — the binding on the conversation, the
 *  same fact `taskResume` answers as `held` and `lost: "claimed"`. Only the
 *  caller's own session counts: a teammate's shared row says nothing about
 *  whether the asking session holds the task. */
async function heldBySession(ctx: QueryCtx, userId: Id<"users">, task: Doc<"tasks">, sessionRef: string): Promise<boolean> {
  const conv = await findConversationBySessionReference(ctx, sessionRef, userId);
  return !!conv && String(conv.active_task_id ?? "") === String(task._id);
}

// "" clears a ground field; any other value is checked by the validator.
const orClear = <T extends string>(values: readonly T[]) => v.optional(v.union(v.literal(""), ...values.map((x) => v.literal(x))) as unknown as Validator<T | "">);
const groundArgs = {
  goal_ref: v.optional(v.string()),
  category: orClear(LINE_CATEGORIES),
  risk: orClear(LINE_RISKS),
  readiness: orClear(LINE_READINESS),
  readiness_note: v.optional(v.string()),
};
const GROUND_FIELDS = ["goal_ref", "category", "risk", "readiness", "readiness_note"] as const;
function groundPatch(args: Partial<Record<(typeof GROUND_FIELDS)[number], string>>): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = {};
  for (const field of GROUND_FIELDS) {
    const value = args[field];
    if (value !== undefined) patch[field] = value.trim() || undefined;
  }
  return patch;
}

export const update = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    // `cast task update --call cl-42`: the call this task came out of; "" clears.
    from_call: v.optional(v.string()),
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
    // `cast task start --take`: move the task's one owning session here even
    // while the current owner is still working (lib/taskOwner.ts).
    take: v.optional(v.boolean()),
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
    // `cast task handoff --guide`: the author's walkthrough, stamped here.
    change_guide: v.optional(changeGuideInputValidator),
    estimated_minutes: v.optional(v.number()),
    // The review station's verdict (the-line.md L3), recorded with the status
    // move in this one write. by_conversation_id is the caller's session.
    review_verdict: v.optional(v.union(v.literal("approve"), v.literal("changes"), v.literal("reject"))),
    review_note: v.optional(v.string()),
    // The ground node's fields (the-line-end-to-end.md LE5). An empty string
    // clears one; goal_ref "none" is a value (the cause threatens no goal).
    ...groundArgs,
    // The watch after ship (LE12): days from now until a quiet cause closes
    // as resolved; 0 ends the watch.
    watch_days: v.optional(v.number()),
    // model, effort and ephemeral (TG8, TG9); ephemeral:false is `cast task keep`.
    ...executionHintArgs,
    // TG5: the link create fills from the filing session's bound task,
    // correctable here; "" or "none" clears it.
    found_during: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) throw new Error("Task not found");
    // Edges are stored canonical; a wait goes through cast task dep.
    args = { ...args, ...storedGraphRefs(ctx, args) };

    // The category every status side effect below keys on. args.status alone
    // is not enough: a status_id-only write still moves the category.
    const statusWrite = await resolveStatusWrite(ctx, task.team_id, task.status, args);
    // A review approve inside a live line run is one station, not the end:
    // the run decides when the cause is done (LE16), so it stays in review.
    if (args.review_verdict === "approve" && statusWrite.status === "done" && (await liveLineRun(ctx, task))) {
      statusWrite.status = "in_review";
    }
    const nextStatus = statusWrite.status;

    const now = Date.now();
    const updates: any = { updated_at: now };
    if (statusWrite.statusId.set) updates.status_id = statusWrite.statusId.value;
    if (nextStatus) updates.status = nextStatus;
    if (args.priority) updates.priority = args.priority;
    if (args.title) {
      updates.title = args.title;
      // The generated short name follows the title; the cron refills it.
      updates.short_title = undefined;
    }
    if (args.description !== undefined) updates.description = args.description;
    if (args.labels) updates.labels = args.labels;
    if (args.promoted !== undefined) updates.promoted = args.promoted;
    const fromCall = await resolveFromCall(ctx, auth.userId, args.from_call);
    if (fromCall !== undefined) updates.from_call = fromCall ?? undefined;
    // The access key every link this write stores must join: the one the write
    // LEAVES the task in, not the one it found. On a row with no stored
    // `workspace` a team move changes the key (workspaceForResource falls back
    // to team_id), and a link validated against the old key would cross
    // workspaces the moment the move lands — the thing TG4 forbids, which
    // readiness then holds as `unknown` forever. The move also carries the
    // task's EXISTING edges across, so it schedules cutCrossedEdges below, as
    // the other two paths that move a key do (recomputeWorkspaceForConversation
    // and teamScopeSweep).
    const depWorkspace = workspaceForResource({ ...task, team_id: args.team_id ?? task.team_id });
    // A found_during the server filled itself can be wrong (the filing session
    // was bound to an unrelated task), so it is writable, through the one rule
    // the web's repoint also goes through (`foundDuringUpdate`).
    if (args.found_during !== undefined) {
      updates.found_during = await foundDuringUpdate(ctx, auth.userId, task, args.found_during, depWorkspace);
    }
    const targetWorkspace = args.team_id
      ? { type: "team" as const, teamId: args.team_id }
      : task.team_id
        ? { type: "team" as const, teamId: task.team_id }
        : { type: "personal" as const, userId: task.user_id };
    // Who may take the task is decided by its ACCESS key (boundaryOfTask),
    // not by the team it is routed to; a move to another team names that team.
    const assigneeBoundary = args.team_id ? boundaryOfWorkspace(targetWorkspace) : await assigneeScopeOf(ctx, task);
    if (args.assignee !== undefined) updates.assignee = await resolveAssigneeStr(ctx, args.assignee, auth.userId, assigneeBoundary) || args.assignee;
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
        // A parent shares the child's ACCESS key as this write leaves it (a
        // team move changes it only on a row with no stored key), never the
        // team it is routed to: readiness reads a parent only there.
        const parent = await resolveParentTask(ctx, auth.userId, args.parent, {
          workspace: depWorkspace,
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
    if (args.change_guide) updates.change_guide = { ...args.change_guide, written_at: now };
    if (args.estimated_minutes !== undefined) updates.estimated_minutes = args.estimated_minutes;
    // A cause's goal is one its own goals brief offers (LE5): its project's,
    // or a metric of an initiative carrying it. A ref from another project's
    // brief ties the cause to a goal its people do not hold.
    if (args.goal_ref?.trim() && task.source === "signal" && task.workspace) {
      const offered = briefGoalRefs(await causeBrief(ctx, task));
      if (!offered.has(args.goal_ref.trim())) {
        throw new Error(`goal_ref "${args.goal_ref.trim()}" is not one of ${task.short_id}'s goals; its goals brief offers: ${[...offered].join(", ")} (cast goals --brief --task ${task.short_id})`);
      }
    }
    Object.assign(updates, groundPatch(args), executionHintPatch(args));
    if (args.watch_days !== undefined) updates.watch_until = watchUntilFor(args.watch_days, now);

    if (nextStatus === "done" || nextStatus === "dropped") {
      updates.closed_at = now;
    }

    // Link conversation if provided. Unresolvable session ref = apply the
    // update without the link, never reject the update itself (see
    // resolveSessionConversation).
    let linkedConvId: Id<"conversations"> | undefined;
    let startedForRole: any | null = null;
    let releasedOwners: TaskOwnerRef[] = [];
    const conv = args.conversation_id
      ? await resolveSessionConversation(ctx, auth.userId, args.conversation_id)
      : null;
    if (args.review_verdict) {
      updates.review_verdict = {
        verdict: args.review_verdict,
        ...(conv ? { by_conversation_id: conv._id } : {}),
        at: now,
        ...(args.review_note ? { note: args.review_note } : {}),
      };
    }
    // The hold (the-line.md L5): a session is refused; a person moves past it
    // and the note below names the decision.
    const hold = await holdingDecisionFor(ctx, task, nextStatus, statusWrite.statusId);
    if (hold && conv) throw heldError(hold);
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
      // An explicit start (cast task start). A `changes` verdict also moves
      // to in_progress but must not bind the reviewer to the work it judges.
      const explicitStart = convMatchesWorkspace && nextStatus === "in_progress" && !args.review_verdict;
      // A session that takes a task assigns it to the role it works for
      // (org-roles-run-work.md R5), so the board shows who owns the work. A
      // task that already names a person stays theirs: the session is
      // helping them, not taking it from them. Decided apart from the binding
      // below: a hand whose first task sits in review still holds it as
      // active_task_id, and its next start must reach the role all the same.
      if (explicitStart && args.assignee === undefined) {
        const taker = await roleTakingTask(ctx, task, conv, assigneeBoundary);
        if (taker) { updates.assignee = String(taker._id); startedForRole = taker; }
      }
      // Only bind conversation to task on explicit start. The start makes this
      // session the task's one owner and moves its own focus here, so a
      // session bound to another task rebinds rather than silently staying.
      if (explicitStart) {
        releasedOwners = (await claimTaskOwnership(ctx, conv, task, { take: args.take === true, now })).released;
        // The binding may file the session under the lead that owns the work (S35).
        await ctx.scheduler.runAfter(0, internal.sessionOwnership.reconcileHold, { conversation_id: conv._id });
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
      // A worker closing or handing off its task ends its turn at its fleet
      // slot (subagentFleet.ts): done merges its worktree back, blocked keeps it.
      if (conv.parent_conversation_id) {
        const outcome = outcomeOfDeclaration(args.execution_status === "done_with_concerns" ? "done" : args.execution_status ?? (nextStatus === "done" ? "done" : undefined));
        if (outcome) await subagentEnded(ctx, conv, outcome);
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

    // Record history for changed fields (lib/taskHistory, shared with webUpdate),
    // plus the blocked_by overwrite only this path writes.
    const trackFields: TaskFieldChange[] = [
      ...trackedFieldChanges(task, {
        status: nextStatus,
        priority: args.priority,
        title: args.title,
        ...("assignee" in updates ? { assignee: { to: updates.assignee } } : {}),
        ...(parentChanged ? { parent: { to: updates.parent_id } } : {}),
        review_verdict: args.review_verdict,
        labels: args.labels,
      }),
      ...(args.blocked_by ? [["blocked_by", prevDeps.blocked_by, args.blocked_by] as TaskFieldChange] : []),
      ...("found_during" in updates ? [["found_during", task.found_during, updates.found_during] as TaskFieldChange] : []),
    ];

    // A new edge on either side must stay in the workspace and not close a
    // loop (TG4). Edges join tasks by their access key (depWorkspace above),
    // as addDep and readiness judge them, never by the team the task is
    // routed to.
    await assertDependencyEdges(ctx, { short_id: task.short_id, _id: String(task._id), blocked_by: args.blocked_by ?? prevDeps.blocked_by }, depWorkspace, {
      blocked_by: args.blocked_by?.filter((d) => !prevDeps.blocked_by.includes(d)),
      blocks: args.blocks?.filter((d) => !prevDeps.blocks.includes(d)),
    });
    // Dropping an edge here can release a task, as removeDep does (TG2).
    const releases = await pendingReleases(ctx, task, args);

    // Who did it (lib/actor): a role's standing session writes as the role's
    // bot user; a hand keeps its host.
    const actor = await resolveActor(ctx, auth.userId, conv);
    const changedBy: TaskChangeBy = { user_id: actor.user_id, actor_type: actor.kind === "role" ? "agent" : "user", conversation_id: linkedConvId };
    await recordTaskChange(ctx, task._id, changedBy, trackFields, now);

    await patchTask(ctx, task, updates);
    // The write moved the task's access key (a team move on a row with no
    // stored `workspace`), so the edges and the parent link it carried over
    // may now cross workspaces, which readiness cannot read across: cut them
    // and tell each dependent, the same job the other key-move paths schedule.
    if (!isSameWorkspace(task, depWorkspace)) {
      await ctx.scheduler.runAfter(0, internal.taskLinks.cutCrossedEdges, { task_ids: [task._id] });
    }
    await schedulePushKeptTask(ctx, task, updates);
    if (hold) await noteMovedPastHold(ctx, task, hold, nextStatus ?? task.status, actor.name || "unknown", auth.userId);
    if (conv && releasedOwners.length) {
      const from = releasedOwners.map((o) => o.short_id).join(", ");
      await insertTaskComment(ctx, task._id, { author: actor.name || "unknown", text: `Session ${conv.short_id ?? conv._id} took over as owner from ${from}.`, comment_type: "note", conversation_id: conv._id }, auth.userId);
    }
    // blocked_by/blocks are raw overwrites; reflect the delta onto each
    // referenced task's other side so the stored mirror stays coherent. Refs
    // compare by the task they name: an older plan row names one by `_id`,
    // this write by short id, and removing the old form would drop the mirror
    // the new form keeps.
    const byTask = async (refs: string[]) =>
      new Map(await Promise.all(refs.map(async (r): Promise<[string, string]> => [r, (await taskByRef(ctx, r))?.short_id ?? r])));
    for (const [field, mirrorField] of [["blocked_by", "blocks"], ["blocks", "blocked_by"]] as const) {
      if (!args[field]) continue;
      const [prev, next] = await Promise.all([byTask(prevDeps[field]), byTask(args[field])]);
      const [prevTasks, nextTasks] = [new Set(prev.values()), new Set(next.values())];
      const self = { short_id: task.short_id, _id: String(task._id), workspace: depWorkspace };
      for (const [dep, id] of next) {
        if (!prevTasks.has(id)) await patchDepMirror(ctx, auth.userId, self, dep, mirrorField, "add", changedBy);
      }
      for (const [dep, id] of prev) {
        if (!nextTasks.has(id)) await patchDepMirror(ctx, auth.userId, self, dep, mirrorField, "remove", changedBy);
      }
    }
    await tellReleased(ctx, releases, changedBy);
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

    await afterStatusMove(ctx, task, nextStatus, auth.userId, linkedConvId);
    if (args.assignee !== undefined && updates.assignee !== task.assignee) {
      await announceAssignment(ctx, { task, assignee: updates.assignee, actorUserId: auth.userId, actorName: actor.name, via: cliVia(args), fromConversationId: conv?._id });
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
    return {
      success: true,
      plan_id: planShortId,
      // Set when this start handed the task to the caller's role, so the CLI
      // can say so.
      assigned_role: startedForRole && updates.assignee !== task.assignee ? { handle: startedForRole.handle, name: startedForRole.name } : undefined,
      // Sessions this start released as the task's owner, so the CLI can say
      // which one lost the binding and whether it was still working.
      released_owners: releasedOwners.length ? releasedOwners.map(({ short_id, title, live }) => ({ short_id, title, live })) : undefined,
      // A start of a task still waiting on something says what (TG1), so a
      // session that picked it by name, not from `ready`, learns it. Judged
      // against the edges this write STORED: `task` is the row as read before
      // patchTask, and the same update may have overwritten blocked_by, so
      // reading `task` alone would omit a blocker the caller just added.
      // A checks wait carries its PR's checks_state: these entries are printed
      // as bare words, and the parking advice under them is built from the same
      // list, so red CI has to read as red here (openBlockersWithChecks, TG10).
      open_blockers: nextStatus === "in_progress" ? await openBlockersWithChecks(ctx, auth.userId, { ...task, ...updates } as Doc<"tasks">) : undefined,
      // Whether the work was ALREADY in flight when this start ran (`task` is
      // the pre-patch row), so a re-start or re-bind of a task this session has
      // been working is told "if the work cannot go on until it clears" rather
      // than to go dormant now — the half of the parking pair `cast task
      // context` already gives the same task in the same state.
      resumed: nextStatus === "in_progress" ? isTaskBeingWorked(task.status) : undefined,
    };
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
//
// `notify` also rings the bell (and the phone) for the same people the row
// moves for, so the Threads inbox and the notification never disagree about
// what is news. `tokenOwner` is who the write ran under: an agent posts under
// its owner's token, and its own comments never ring its owner.
/**
 * Relay a person's comment into the session that owns the task (lib/taskOwner)
 * while that session is working, framed as a <task-comment> so the agent knows
 * whose words they are and that a reply belongs on the task. A quiet owner is
 * left alone: waking a cold session rebuilds its whole context for one line,
 * and the comment waits on the task where it reads it next. Returns the
 * conversation it reached, or null.
 */
async function deliverCommentToOwner(
  ctx: any,
  task: any,
  c: { commentId: Id<"task_comments">; actorId: Id<"users">; from: string; text: string; imageIds?: string[] },
): Promise<Id<"conversations"> | null> {
  if (!task.short_id || !c.text.trim()) return null;
  const [owner] = await boundSessionsOf(ctx, task);
  if (!owner) return null;
  if (!(await isSessionWorking(ctx, owner, Date.now()))) return null;
  if (!(await canSendProductMessage(ctx, c.actorId, owner))) return null;
  await enqueuePendingMessage(ctx, owner, c.actorId, {
    content: formatTaskCommentMessage({ task: task.short_id, title: task.title ?? "", from: c.from, body: c.text.trim() }),
    client_id: `task-comment:${c.commentId}`,
    ...(c.imageIds?.length ? { image_storage_ids: c.imageIds as Id<"_storage">[] } : {}),
    human: true,
  });
  return owner._id;
}

export async function insertTaskComment(
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
  notify?: { tokenOwner: Id<"users">; conversationId?: Id<"conversations"> },
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
    // An @mention is attention AT a person, whoever typed it: the named
    // people follow the thread from here on (membership's "mentioned" leg),
    // so they must be subscribed before the participants are resolved.
    const mentioned = await mentionedInTaskComment(ctx, task, fields.text);
    for (const userId of mentioned) await subscribeUser(ctx, userId, taskId, "mentioned", actorId ? "human" : "agent");
    const mentionedSet = new Set(mentioned.map(String));
    // The row moves only for the participants this comment is news for
    // (threadReads.taskCommentIsNews): a person's comment for everyone else,
    // an agent's only when it needs a person, or per the reader's own level.
    // The named people are participants of this comment outright, whether
    // or not the subscription write above has landed in this transaction.
    // A bot account's comment (an anchor, another team's triage agent) is an
    // agent's, the same classification the read side applies (threads.ts).
    const news: Id<"users">[] = [];
    const participants = await taskThreadParticipants(ctx, task);
    for (const id of mentioned) if (!participants.some((p) => String(p) === String(id))) participants.push(id);
    const actor = actorId ? await ctx.db.get(actorId) : null;
    for (const userId of participants) {
      const author: TaskCommentAuthorKind = taskCommentAuthorKind({ author_user_id: actorId }, actor, userId);
      const level = agentCommentLevelOf(await ctx.db.get(userId));
      if (taskCommentIsNews(fields, author, level, mentionedSet.has(String(userId)))) news.push(userId);
    }
    // Ephemeral bookkeeping stays out of the Threads inbox (TG9) unless the
    // comment calls on someone.
    const recipients = commentReaches(task, fields.comment_type, news, mentionedSet);
    if (!task.ephemeral || recipients.length) await touchThread(ctx, {
      kind: "task",
      rootKey: String(taskId),
      teamId: task.team_id,
      refs: { task_id: taskId },
      participants: recipients,
      actorId,
      activityAt: now,
    });
    // A person's words, not posted from a session: they reach the session
    // doing the task while it works, so commenting on the task talks to the
    // work. A bot account's comment is an agent's and never relays.
    if (actorId && !fields.conversation_id && !actor?.is_bot) {
      const deliveredTo = await deliverCommentToOwner(ctx, task, { commentId: id, actorId, from: fields.author, text: fields.text, imageIds: fields.image_storage_ids });
      if (deliveredTo) await ctx.db.patch(id, { delivered_to_conversation_id: deliveredTo });
    }
    if (notify) {
      await ctx.runMutation(internal.notificationRouter.emit, {
        event_type: "task_commented",
        actor_user_id: actorId ?? notify.tokenOwner,
        entity_type: "task",
        entity_id: String(taskId),
        message: `commented on ${task.short_id}: ${fields.text.slice(0, 100)}`,
        conversation_id: notify.conversationId,
        recipient_ids: recipients.filter((r) => String(r) !== String(notify.tokenOwner)),
      });
    }
  }
  return id;
}

/** The team members a task comment names with @handle (the chat grammar,
 *  resolved against the task's team roster, so a display name can never
 *  intercept a mention). A personal task has no roster and no mentions. */
async function mentionedInTaskComment(
  ctx: any,
  task: { team_id?: Id<"teams"> },
  text: string,
): Promise<Id<"users">[]> {
  const handles = extractMentionHandles(text);
  if (handles.length === 0 || !task.team_id) return [];
  const roster = await teamRoster(ctx, task.team_id);
  const out: Id<"users">[] = [];
  const seen = new Set<string>();
  for (const handle of handles) {
    const user = matchHandle(roster, handle);
    if (!user || user.is_bot || seen.has(String(user._id))) continue;
    seen.add(String(user._id));
    out.push(user._id);
  }
  return out;
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

    const conv = args.conversation_id
      ? await resolveSessionConversation(ctx, auth.userId, args.conversation_id)
      : null;
    const conversation_id = conv?._id;
    const notificationConversationId = conv && workspacesMatch(workspaceForConversation(conv), workspaceForResource(task))
      ? conv._id : undefined;

    // A post from inside a session is an agent's: no actor, so the owner's
    // thread lights up. A person running the CLI by hand is the actor. The
    // name is the server resolved identity (lib/actor): a role's standing
    // session signs as the role, everyone else as the token's owner. The
    // author argument is accepted for older CLIs and never read.
    const actor = await resolveActor(ctx, auth.userId, conv);
    const id = await insertTaskComment(ctx, task._id, {
      author: actor.name || "unknown",
      text: args.text,
      conversation_id,
      comment_type: args.comment_type || "note",
    }, args.conversation_id ? undefined : auth.userId, { tokenOwner: auth.userId, conversationId: notificationConversationId });

    await subscribeUser(ctx, auth.userId, task._id, "commenter", cliVia(args));
    await schedulePushComment(ctx, task, id);

    return { id };
  },
});

// create and update accept blocked_by/blocks as raw arrays, and plans
// insert whole graphs (createFromTemplate, fork); each accepted edge must
// also land on the referenced task's other side or the stored mirror drifts
// (addDep/removeDep already keep it for single edges). Same
// short-id resolution addDep uses, but an unresolvable, inaccessible or
// cross-workspace reference skips the mirror instead of rejecting a write
// the caller already made. The mirror may name `self` by its `_id` (a plan's
// older rows): that form is the same edge, so it is never added twice and
// is removed with the short id.
//
// Returns the referenced task whenever this caller may read it — the mirror
// already being right, or skipped across workspaces, counts — so a caller can
// report what its own edge landed on (its status: a done or dropped blocker
// holds nothing). Null when the ref names nothing this caller can see.
export async function patchDepMirror(
  ctx: any,
  userId: Id<"users">,
  self: { short_id: string; _id?: string; workspace: AuthorizedWorkspace },
  otherRef: string,
  mirrorField: "blocks" | "blocked_by",
  op: "add" | "remove",
  // Who made the edit: a blocked_by mirror is the other task's own history (TG11).
  by?: TaskChangeBy,
): Promise<Doc<"tasks"> | null> {
  const other = await taskByRef(ctx, otherRef);
  if (!other || !(await canAccessTask(ctx, userId, other))) return null;
  if (op === "add" && !isSameWorkspace(other, self.workspace)) return other;
  // Either form is one entry, which is mirrorNext's rule (TG4); writeEdges
  // writes nothing when the mirror already stands as this edit leaves it.
  const next = mirrorNext(other[mirrorField] ?? [], op === "add" ? { add: [self] } : { remove: [self] });
  await writeEdges(ctx, other, mirrorField, next, by ?? bySystem);
  return other;
}

export const addDep = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    blocks: v.optional(v.string()),
    blocked_by: v.optional(v.string()),
    // The session making the change: an agent's own edit wakes it for nothing (TG2).
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, by } = await cliCaller(ctx, args);
    return await addDepCore(ctx, userId, args, by);
  },
});

/** One dependency edge of `short_id`: the task it blocks, or the task it is blocked by. */
export type DepEdge = { short_id: string; blocks?: string; blocked_by?: string };

/** Add one edge, mirrored on both rows and refused when it would close a loop
 *  (TG4). `cast task dep` and the web's add-blocker palette (dispatch addBlocker). */
export async function addDepCore(ctx: MutationCtx, userId: Id<"users">, args: DepEdge, by: TaskChangeBy = byUser(userId)) {
  const task = await requireTaskByRef(ctx, userId, args.short_id);
  const workspace = workspaceForResource(task);

  // `field` of this task gains the other task; its mirror gains this one.
  const addEdge = async (ref: string, field: "blocks" | "blocked_by") => {
    const otherRow = await requireTaskByRef(ctx, userId, ref);
    const other = otherRow.short_id;
    const current = task[field] ?? [];
    const blockedBy = field === "blocked_by" ? [...current, other] : task.blocked_by;
    await assertDependencyEdges(ctx, { short_id: task.short_id, _id: String(task._id), blocked_by: blockedBy }, workspace, { [field]: [other] });
    // An older plan row may already name it by `_id`: the same edge.
    if (!current.includes(other) && !current.includes(String(otherRow._id))) await writeEdges(ctx, task, field, [...current, other], by);
    await patchDepMirror(ctx, userId, { short_id: task.short_id, _id: String(task._id), workspace }, other, field === "blocks" ? "blocked_by" : "blocks", "add", by);
    return otherRow;
  };

  if (args.blocks) await addEdge(args.blocks, "blocks");
  // A finished blocker holds nothing, which the CLI says rather than "blocked".
  // On the `blocks` side the blocker is this task, so its own status is the one
  // the caller needs: the same fact, read by the same words, for an edge given
  // from either end (depAddedLine).
  const blocker = args.blocked_by ? await addEdge(args.blocked_by, "blocked_by") : null;
  return { success: true, ...(args.blocks ? { task_status: task.status } : {}), ...(blocker ? { blocker_status: blocker.status } : {}) };
}

export const removeDep = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    blocks: v.optional(v.string()),
    blocked_by: v.optional(v.string()),
    // The session making the change: an agent's own edit wakes it for nothing (TG2).
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, by } = await cliCaller(ctx, args);
    return await removeDepCore(ctx, userId, args, by);
  },
});

/** Remove one edge and its mirror. Removing the last open blocker unblocks the
 *  dependent the way a closing blocker does (TG2), so a session parked on it
 *  is woken. `cast task dep --remove` and the web's Blocked by row.
 *
 *  `missing: "ignore"` makes an edge that is already gone a no-op instead of
 *  an error, for a caller whose write may be replayed: the web's durable
 *  outbox re-drives an entry whose ack was lost, and a removal that did commit
 *  would otherwise fail on every boot. A caller that reports to a person or an
 *  agent keeps the default, so `cast task dep --remove-blocked-by` still exits
 *  non-zero on an edge that was never there (applyBlockers reads that exit). */
export async function removeDepCore(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: DepEdge,
  by: TaskChangeBy = byUser(userId),
  opts: { missing?: "throw" | "ignore" } = {},
) {
  const task = await requireTaskByRef(ctx, userId, args.short_id);

  // Removes the edge from this task, plus the mirror edge on the other task
  // when it still exists — the other side may be gone, since edges to
  // dropped/deleted blockers are exactly what removal is for.
  const removeEdge = async (ref: string, field: "blocks" | "blocked_by") => {
    const current: string[] = task[field] || [];
    const other = await taskByRef(ctx, ref);
    // Older plan rows name a blocker by its `_id`, which `cast task show`
    // prints by short id. Both forms are one edge, and every form goes.
    const forms = new Set([ref, ...(other ? [other.short_id, String(other._id)] : [])]);
    const otherId = current.find((id) => forms.has(id));
    if (!otherId) {
      if (opts.missing === "ignore") return;
      // The usual cause is the edge named the other way round: say so, with the remove that fits.
      const [waiter, blocker] = field === "blocked_by" ? [other, task] : [task, other];
      const backwards = !!other && (await canAccessTask(ctx, userId, other))
        && (waiter!.blocked_by ?? []).some((r) => r === blocker!.short_id || r === String(blocker!._id));
      const hint = backwards ? `; ${waiter!.short_id} waits on ${blocker!.short_id} instead (cast task dep ${waiter!.short_id} --remove-blocked-by ${blocker!.short_id})` : "";
      throw new Error(`${task.short_id} has no ${field === "blocks" ? "blocks" : "blocked-by"} dependency on ${ref}${hint}`);
    }
    const next = current.filter((id) => !forms.has(id));
    // The row whose blocked_by loses the edge may be released (TG2).
    const releases = await pendingReleases(ctx, task, { [field]: next });
    await writeEdges(ctx, task, field, next, by);
    if (other) {
      const self = { short_id: task.short_id, _id: String(task._id), workspace: workspaceForResource(task) };
      await patchDepMirror(ctx, userId, self, other.short_id, field === "blocks" ? "blocked_by" : "blocks", "remove", by);
    }
    await tellReleased(ctx, releases, by);
  };

  if (args.blocks) await removeEdge(args.blocks, "blocks");
  if (args.blocked_by) await removeEdge(args.blocked_by, "blocked_by");

  return { success: true };
}

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

    const comments = await taskCommentsWithSessionInfo(ctx, task._id, auth.userId);

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
        // A session that began after the task existed came to work on it, so
        // everything it wrote is context. A session that predates the task
        // (the one that filed it, or a long-lived loop) contributes only what
        // it wrote for the task (docRelatesToTask).
        const startedAt = conversation.started_at ?? conversation._creationTime;
        const cameForTask = typeof startedAt === "number" && startedAt >= task.created_at;
        for (const d of docs) {
          if (
            !d.archived_at
            && (cameForTask || docRelatesToTask(d, task))
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
      // TG5: found during, found here, superseded by and related, resolved.
      links: await taskLinksOf(ctx, auth.userId, task),
      // Why it is off `cast task ready` when no blocker says (TG1).
      not_ready: await offFrontierReason(ctx, task),
    };
  },
});

// --- Web-facing queries (use Convex auth, no api_token) ---

// Enrich a page of task rows in place with comments and creator/assignee/plan
// info. The one row builder of the tasks collection: webList (the bootstrap
// floor), webListPaginated (the reconcile crawl) and webGetByIds (the sync
// log's refetch) all call it, so every channel returns one row shape for a
// viewer (tasks.convergence.test.ts). Mutates `result` in
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
    // A role assignee (org-roles-run-work.md R5) is NOT read here. A role row
    // is patched on every message its sessions sync (the daily token counter),
    // so reading one would re-run and re-ship this whole list each time. The
    // client resolves a role's face from the org tree slice instead
    // (lib/liveEntities resolveAssigneeInfo), which is also what makes a
    // rename show everywhere at once. normalizeId reads no row.
    if (ctx.db.normalizeId("org_roles", uid)) return;
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
  //
  // Comments are the one join every channel carries, so the bootstrap floor,
  // the crawl and byIds write one row shape: a row that arrived by a list and
  // a row refetched by byIds (the sync log's refetch on last_comment_at) are
  // the same row. Every caller is one-shot (webList is the E8 bootstrap floor,
  // the crawl and byIds are convex.query calls), so the conversation reads the
  // session_info join makes re-run nothing. One cache serves the whole list.
  const sessionInfo: CommentSessionCache = new Map();
  await Promise.all(result.map(async (t) => {
    t.comments = await taskCommentsWithSessionInfo(ctx, t._id, userId, sessionInfo);
  }));

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
    // The guide carries its hunks and rides the evidence read, never a list.
    delete t.change_guide;
  }
  await stampGraphStatus(ctx, result);
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
      // The same rule as the CLI list (TG1), blockers and parents read from the database.
      tasks = (await readyTasks(ctx, tasks, { viewer: String(userId) })).ready;
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
// access (own or team). Same enriched row shape as webList, comments included
// (reuses enrichTasks), so the client merges via syncTable("tasks"). No status
// filter — a dropped task comes back with status:"dropped" and the client's
// read-time filter hides it.
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

    // Defensive clamp. Each row carries its comments and their sessions'
    // session_info (enrichTasks), so a page reads several documents per task;
    // 300 matches webList's floor and keeps a page of comment-heavy tasks well
    // inside the isolate's read and return caps. The client pages on isDone,
    // so a smaller page only adds round trips to a cold-cache backfill.
    const paginationOpts = {
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, 300),
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
      // The person's own rows first: filled after the teams, two busy teams
      // took every slot and a search could not find their own to-dos.
      const userTasks = await ctx.db
        .query("tasks")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .order("desc")
        .take(MAX_PER_TEAM);
      for (const t of userTasks) pushUnique(t);
      const memberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .collect();
      for (const m of memberships) {
        if (tasks.length >= MAX_TOTAL) break;
        const teamTasks = await ctx.db
          .query("tasks")
          .withIndex("by_team_id", (q: any) => q.eq("team_id", m.team_id))
          .order("desc")
          .take(MAX_PER_TEAM);
        for (const t of teamTasks) pushUnique(t);
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

// The tasks linked to one conversation, read through the reverse indexes
// instead of a scan.
//
// This used to `.collect()` every task the caller owned and filter in JS on
// `conversation_ids.includes(...)`. That is O(all the caller's tasks) in both
// documents read and bytes deserialized — an account with tens of thousands of
// tasks moved megabytes per execution, which is what the 1s user-JS cap and the
// system-operation budget both measure. It timed out in production on both
// counts (Sentry JAVASCRIPT-REACT-5K and -5F).
//
// A conversation's tasks are a handful of rows, and two indexes already point
// that way, so the answer costs a bounded number of reads:
//   - entity_conversations.by_conversation — the association rail every linking
//     path dual-writes (conversationLinks.ts), the only true reverse index;
//   - tasks.by_created_from_conversation — the task a session filed, which
//     predates the rail;
//   - conversations.active_task_id — the task a session is working right now.
// Rows written before the rail existed (2026-08-01) are reachable through the
// last two, and migrations.backfillTaskConversationLinks fills the rest in.
export const TASKS_PER_CONVERSATION_LIMIT = 200;

export const webListByConversation = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    // Gate on the conversation first, the same way conversationLinks'
    // webListForConversation does: the task list of a session the caller cannot
    // open is not theirs to enumerate.
    const conv = await ctx.db.get(args.conversationId);
    if (!conv || !(await canAccessConversation(ctx, userId, conv))) return [];

    const candidates = new Set<string>(
      await linkedEntityIdsForConversation(ctx, args.conversationId, "task"),
    );
    // Bounded, like every other read here — a session that filed a hundred
    // tasks must not turn this back into an unbounded scan.
    const origin = await ctx.db
      .query("tasks")
      .withIndex("by_created_from_conversation", (q) =>
        q.eq("created_from_conversation", args.conversationId))
      .take(TASKS_PER_CONVERSATION_LIMIT);
    for (const t of origin) candidates.add(String(t._id));
    if (conv.active_task_id) candidates.add(String(conv.active_task_id));

    const rows = [];
    for (const raw of [...candidates].slice(0, TASKS_PER_CONVERSATION_LIMIT)) {
      // Rail ids are plain strings, and a stale row may name a deleted or
      // foreign-table id; normalizeId keeps ctx.db.get from throwing on one.
      const id = ctx.db.normalizeId("tasks", raw);
      if (!id) continue;
      const t = await ctx.db.get(id);
      if (!t || !(await canAccessTask(ctx, userId, t))) continue;
      rows.push({ _id: t._id.toString(), short_id: t.short_id, title: t.title, status: t.status, external: t.external });
    }
    return rows;
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

    const comments = await taskCommentsWithSessionInfo(ctx, task!._id, userId);

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

export const isBlockedExecution = (s: string | undefined) => s === "blocked" || s === "needs_context";

// Clearing a block is a retry (the-line.md L9). The line starts only tasks
// with no workflow_run_id, so a run that has ended is let go with the flag;
// otherwise the task sits open and the line never starts it again. A live run
// keeps its binding. The reason and the retry budget reset with it.
export async function releaseBlockFields(ctx: { db: any }, task: any): Promise<Record<string, any>> {
  const fields: Record<string, any> = { execution_concerns: undefined, retry_count: 0 };
  if (task.workflow_run_id) {
    const run = await ctx.db.get(task.workflow_run_id);
    if (!run || run.status === "failed" || run.status === "completed") {
      fields.workflow_run_id = undefined;
      fields.workflow_node_id = undefined;
    }
  }
  return fields;
}

const webUpdateArgs = {
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
  // A person's review verdict from the board (the-line.md L3). A web write
  // has no session behind it, so the verdict counts as outside every role.
  review_verdict: v.optional(v.union(v.literal("approve"), v.literal("changes"), v.literal("reject"))),
  review_note: v.optional(v.string()),
  // The call this task came out of (a call ref); "" clears.
  from_call: v.optional(v.string()),
  // The task this one was found while working on (TG5). The create GUESSES it
  // from the filing session's bound task, and the task page is where a person
  // notices a wrong one, so the board repoints it too; "" or "none" clears.
  found_during: v.optional(v.string()),
  // model, effort and ephemeral (TG8, TG9); "" clears model or effort.
  ...executionHintArgs,
};

export const webUpdate = mutation({
  args: webUpdateArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return await updateTaskAs(ctx, userId, args);
  },
});

/** Update a task as `userId`, the way the web's update does: access, the
 *  status write, history, the close guard and notifications. The hosted
 *  assistant's update_task runs this same path. */
export async function updateTaskAs(ctx: MutationCtx, userId: Id<"users">, args: ObjectType<typeof webUpdateArgs>) {
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
      // The child's ACCESS key, never its routing team: readiness reads a
      // parent only there.
      const parent = await resolveParentTask(ctx, userId, args.parent, {
        workspace: workspaceForResource(task),
        child: task,
      });
      updates.parent_id = parent._id;
    }
  }
  if (nextStatus) updates.status = nextStatus;
  if (args.priority) updates.priority = args.priority;
  if (args.title) {
    updates.title = args.title;
    updates.short_title = undefined;
  }
  if (args.description !== undefined) updates.description = args.description;
  const fromCall = await resolveFromCall(ctx, userId, args.from_call);
  if (fromCall !== undefined) updates.from_call = fromCall ?? undefined;
  if (args.found_during !== undefined) {
    updates.found_during = await foundDuringUpdate(ctx, userId, task, args.found_during);
  }
  if (args.assignee !== undefined) {
    updates.assignee = await resolveAssigneeStr(ctx, args.assignee, userId, await assigneeScopeOf(ctx, task)) || args.assignee;
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
  if (args.execution_status === "" && isBlockedExecution(task.execution_status)) {
    Object.assign(updates, await releaseBlockFields(ctx, task));
  }
  if (args.sort_order !== undefined) updates.sort_order = args.sort_order;
  Object.assign(updates, executionHintPatch(args));
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
      requireSameWorkspace(canonical, workspaceForResource(task), "canonical task");
      updates.duplicate_of = args.duplicate_of;
      // A duplicate is dropped, so what waits on it waits on the canonical
      // (TG5). A done task's dependents were already released by real work.
      // A re-point leaves what the first mark moved on the first canonical,
      // which is still open work; clearing the mark takes back only this one's.
      if (args.duplicate_of !== task.duplicate_of && task.status !== "done") {
        requireLiveReplacement(canonical, "mark it a duplicate of");
        await redirectDependents(ctx, userId, byUser(userId), task, canonical, `${task.short_id} duplicate of ${canonical.short_id}`);
      }
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
  if (args.review_verdict) {
    updates.review_verdict = {
      verdict: args.review_verdict,
      at: now,
      ...(args.review_note ? { note: args.review_note } : {}),
    };
  } else if (nextStatus === "done" && task.status === "in_review") {
    // Dragging a task out of In Review into Done is the person's approve:
    // that column holds work waiting on exactly this judgement.
    updates.review_verdict = { verdict: "approve", at: now, note: "closed from the board" };
  }

  // Close-guard: refuses done/dropped on a parent with open subtasks unless
  // resolved; returns the subtree to cascade-close. Runs before any write.
  const cascadeIds = await guardParentClose(ctx, task, nextStatus, args.subtask_resolution);
  // A person on the board moves past a hold (the-line.md L5); the note
  // after the write names the decision it moved past.
  const hold = await holdingDecisionFor(ctx, task, nextStatus, statusWrite.statusId);

  const resolvedAssignee = updates.assignee || args.assignee;
  const parentChanged = "parent_id" in updates && String(updates.parent_id ?? "") !== String(task.parent_id ?? "");
  // Record history for changed fields (lib/taskHistory, shared with update),
  // plus the execution_status only the board writes.
  const trackFields: TaskFieldChange[] = [
    ...trackedFieldChanges(task, {
      status: nextStatus,
      priority: args.priority,
      title: args.title,
      ...(args.assignee !== undefined ? { assignee: { to: resolvedAssignee } } : {}),
      ...(parentChanged ? { parent: { to: updates.parent_id } } : {}),
      review_verdict: updates.review_verdict?.verdict,
      labels: args.labels,
    }),
    ...(args.execution_status !== undefined
      ? [["execution_status", task.execution_status || "", args.execution_status || ""] as TaskFieldChange]
      : []),
    ...("found_during" in updates ? [["found_during", task.found_during, updates.found_during] as TaskFieldChange] : []),
  ];

  await recordTaskChange(ctx, task._id, byUser(userId), trackFields, now);

  await patchTask(ctx, task, updates);
  await schedulePushKeptTask(ctx, task, updates);
  if (args.duplicate_of === "") await afterDuplicateCleared(ctx, userId, task, nextStatus ?? task.status);
  if (hold) await noteMovedPastHold(ctx, task, hold, nextStatus ?? task.status, (await ctx.db.get(userId))?.name || "unknown", userId);
  if (cascadeIds.length > 0) await cascadeClose(ctx, cascadeIds, nextStatus!, userId, task);
  await rollUpParentStart(ctx, { ...task, parent_id: "parent_id" in updates ? updates.parent_id : task.parent_id }, nextStatus);
  if (parentChanged) {
    await reconcilePlanMembership(ctx, task._id, task.plan_id as Id<"plans"> | undefined, !!updates.parent_id);
  }

  await afterStatusMove(ctx, task, nextStatus, userId);
  if (args.assignee !== undefined && resolvedAssignee !== task.assignee) {
    await announceAssignment(ctx, { task, assignee: resolvedAssignee, actorUserId: userId, via: "human" });
  }

  return { success: true };
}

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

    const commentId = await insertTaskComment(ctx, task._id, {
      author: user?.name || "unknown",
      text: args.text,
      comment_type: args.comment_type || "note",
      image_storage_ids: args.image_storage_ids,
    }, userId, { tokenOwner: userId });

    await subscribeUser(ctx, userId, task._id, "commenter", "human");
    await schedulePushComment(ctx, task, commentId);

    return { success: true };
  },
});

/**
 * May this user launch a session for this task? Its creator, or any member of
 * its team — the same rule dispatch.createSession applies. Without the team
 * clause, "start agent run" on a shared team task is silently rejected as
 * Unauthorized.
 */
export async function canLaunchTaskSession(
  ctx: any,
  userId: Id<"users">,
  task: any,
): Promise<boolean> {
  if (task.user_id.toString() === userId.toString()) return true;
  if (!task.team_id) return false;
  return !!(await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", task.team_id))
    .first());
}

/**
 * Spawn a session that works one task. THE spawn: the board's assign-to-agent
 * action, the CLI's `cast task start --spawn`, and issue sync's automatic
 * delegation (issue-sync.md S7) all land here, so a task-backed session is
 * built one way no matter who asked for it.
 *
 * Callers own the access check (canLaunchTaskSession); this assumes it passed.
 */
export async function spawnSessionForTask(
  ctx: any,
  userId: Id<"users">,
  task: any,
  opts: { agent_type?: string; initial_message?: string } = {},
): Promise<{ conversationId: Id<"conversations">; sessionId: string }> {
  const initial_message = opts.initial_message;
  // Round-trip through the client registry so any spelling a caller supplies
  // (a daemon client id, a convex literal, something stale) normalizes to the
  // closed union the conversations row stores. Unknown falls back to claude.
  const daemonAgentType = fromConvexAgentType(opts.agent_type ?? "claude_code");
  const agent_type = toConvexAgentType(daemonAgentType);

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
  const shortId = conversationId.toString().slice(0, 7);
  await ctx.db.patch(conversationId, { short_id: shortId } as any);

  // Link the new session to the task so it counts as a linked conversation —
  // drives session_count, origin_session, and the "Has session" filter.
  // Mirrors dispatch.createSession, which links the conversation before
  // binding active_task_id. Without this an agent-run task shows a live
  // session pill (from active_task_id) while session_count stays 0, so it
  // wrongly drops out of the "Has session" filter.
  await addConversationToWorkItem(ctx, userId, "task", task, conversationId);
  // The launcher chose this session to do the work: it becomes the task's one
  // owner, and any earlier bound session lets go.
  await claimTaskOwnership(ctx, await ctx.db.get(conversationId), task, { take: true, now });
  await ctx.scheduler.runAfter(0, internal.sessionOwnership.reconcileHold, { conversation_id: conversationId });

  // NB: intentionally do NOT reassign the task to "agent" — the launcher stays
  // the owner. The active run is already conveyed by the task status and the
  // session linked via active_task_id, so clobbering assignee only lost the
  // human owner and dropped the task out of the launcher's "assigned to me" view.

  const content = buildTaskSpawnPrompt(task, initial_message);

  // Single canonical writer: stamps owner_user_id for the daemon's delivery poll and flips
  // has_pending_messages. The task session is the launcher's own, so owner == sender.
  const taskConversation = await ctx.db.get(conversationId);
  await enqueuePendingMessage(ctx, taskConversation, userId, { content });

  await enqueueStartSession(ctx, userId, {
    conversationId,
    agentType: daemonAgentType,
    projectPath: project_path || git_root,
    gitRoot: git_root,
    createdAt: now,
    // The task's execution hints (task-graph.md TG8), fixed at launch; the
    // daemon drops a model or effort its client does not offer.
    ...(task.model ? { model: task.model } : {}),
    ...(task.effort ? { effort: task.effort } : {}),
  });

  // S7: tell the provider issue that a session took it, exactly once per
  // spawn. Written as a normal task comment and pushed outward by the same
  // schedulePushComment every other outbound comment uses, so the link lands
  // in both places and there is no second outbound path to keep true.
  if (task.external) {
    const commentId = await insertTaskComment(ctx, task._id, {
      author: "codecast",
      text: `Codecast session ${shortId} picked this up: ${webBaseUrl()}/conversation/${conversationId}`,
      comment_type: "note",
      conversation_id: conversationId,
    });
    await schedulePushComment(ctx, task, commentId);
  }

  return { conversationId, sessionId };
}

export const assignToAgent = mutation({
  args: {
    short_id: v.string(),
    agent_type: v.union(v.literal("claude_code"), v.literal("codex"), v.literal("cursor"), v.literal("gemini"), v.literal("opencode"), v.literal("pi"), v.literal("grok"), v.literal("muse")),
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
    if (!(await canLaunchTaskSession(ctx, userId, task))) throw new Error("Unauthorized");

    return await spawnSessionForTask(ctx, userId, task, { agent_type, initial_message });
  },
});

/** The CLI's `cast task start <id> --spawn` (S7.2). Same access rule, same
 *  spawn; only the credential differs. */
export const spawnForTask = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    agent_type: v.optional(v.string()),
    initial_message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task) throw new Error("Task not found");
    if (!(await canLaunchTaskSession(ctx, auth.userId, task))) throw new Error("Unauthorized");

    return await spawnSessionForTask(ctx, auth.userId, task, {
      agent_type: args.agent_type,
      initial_message: args.initial_message,
    });
  },
});

/** Issue sync's automatic delegation (S7.3). Idempotent on purpose: a second
 *  delegating event on the same issue must not stack a second session, so a
 *  task that already has one is left alone. */
export const spawnSessionForTaskInternal = internalMutation({
  args: {
    task_id: v.id("tasks"),
    user_id: v.id("users"),
    agent_type: v.optional(v.string()),
    initial_message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    if (!task) return null;
    if ((task.conversation_ids ?? []).length > 0) return null;
    return await spawnSessionForTask(ctx, args.user_id, task, {
      agent_type: args.agent_type,
      initial_message: args.initial_message,
    });
  },
});

const webCreateArgs = {
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
  // The call this task came out of (a call ref): the call page's create.
  from_call: v.optional(v.string()),
  // model, effort and ephemeral (TG8, TG9).
  ...executionHintArgs,
};

export const webCreate = mutation({
  args: webCreateArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return await createTaskAs(ctx, userId, args);
  },
});

/** Create a task as `userId`, the way the web's create does: the hosted
 *  assistant's create_task runs this same path for the person it works for. */
export async function createTaskAs(ctx: MutationCtx, userId: Id<"users">, args: ObjectType<typeof webCreateArgs>) {
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

  const resolvedAssignee = await resolveAssigneeStr(ctx, args.assignee, userId, boundaryOfWorkspace(db.workspace));
  const from_call = (await resolveFromCall(ctx, userId, args.from_call)) ?? undefined;

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
    // Created directly in done/dropped (the modal offers every status):
    // terminal rows always carry closed_at, same as a close would stamp.
    closed_at: isTerminalTaskStatus(statusWrite.status) ? now : undefined,
    priority: (args.priority || "medium") as any,
    labels: args.labels,
    assignee: resolvedAssignee,
    from_call,
    source: "human",
    attempt_count: 0,
    retry_count: 0,
    max_retries: 3,
    ...executionHintPatch(args),
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
  if (resolvedAssignee) {
    await announceAssignment(ctx, { task: (await ctx.db.get(id)) as any, assignee: resolvedAssignee, actorUserId: userId, via: "human" });
  }

  await schedulePushNewTask(ctx, project_id, id);

  return { id, short_id };
}

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

    await recordTaskChange(ctx, task._id, byUser(auth.userId), [["execution_status", task.execution_status, args.execution_status]], now);

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

    for (const short_id of args.short_ids) {
      const task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
        .first();
      if (!task || task.user_id !== auth.userId) {
        results.push({ short_id, success: false });
        continue;
      }

      await moveTaskStatus(ctx, task, args.status as any, { actorUserId: auth.userId, actorType: "user", now });

      results.push({ short_id, success: true });
    }

    return { results, updated: results.filter((r) => r.success).length };
  },
});

/** Enough for any board selection; past it the roster and history reads of
 *  one call would run into the transaction's document limit. */
const MAX_BATCH_ASSIGN = 200;

export const batchAssign = mutation({
  args: {
    api_token: v.string(),
    short_ids: v.array(v.string()),
    assignee: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    if (args.short_ids.length > MAX_BATCH_ASSIGN) {
      throw new Error(`Assign at most ${MAX_BATCH_ASSIGN} tasks in one call (${args.short_ids.length} given). Split the batch.`);
    }
    const now = Date.now();
    const results: { short_id: string; success: boolean }[] = [];

    // The handle resolves once per boundary, not once per task: resolving
    // reads the roster, and the whole batch usually sits in one workspace.
    const resolvedIn = new Map<string, Promise<string>>();
    const resolveFor = async (task: any): Promise<string> => {
      const boundary = await assigneeScopeOf(ctx, task);
      const key = `${boundary.team_id ?? ""}|${boundary.scope_user_id ?? ""}|${boundary.routed_team_id ?? ""}`;
      let pending = resolvedIn.get(key);
      if (!pending) {
        pending = resolveAssigneeStr(ctx, args.assignee, auth.userId, boundary).then((r) => r || args.assignee);
        resolvedIn.set(key, pending);
      }
      return pending;
    };

    for (const short_id of args.short_ids) {
      const task = await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
        .first();
      if (!task || task.user_id !== auth.userId) {
        results.push({ short_id, success: false });
        continue;
      }
      const resolvedAssignee = await resolveFor(task);

      await recordTaskChange(ctx, task._id, byUser(auth.userId), [["assignee", task.assignee, resolvedAssignee]], now);

      await patchTask(ctx, task, { assignee: resolvedAssignee, updated_at: now });

      if (resolvedAssignee !== task.assignee) {
        await announceAssignment(ctx, { task, assignee: resolvedAssignee, actorUserId: auth.userId, via: "human" });
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

    await patchTask(ctx, task, {
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

function getCriticalPath(tasks: TaskNode[]): string[] {
  const taskMap = new Map<string, TaskNode>();
  for (const t of tasks) taskMap.set(t.short_id, t);

  const { sorted, cycles } = topologicalOrder(tasks);
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

    const { sorted, cycles } = topologicalOrder(chainTasks);
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

// Support path: delete a task outright with its edges, comments and history
// (packages/convex/run.sh). The product's own verb is "dropped"; this is for a
// row its owner wants gone from the database. The edges go through
// unlinkDeletedTask first (TG2): a dependent left holding a ref to a row that
// is gone reads it as missing, becomes ready with nobody told, and leaves a
// session parked on the blocker asleep.
export const adminDeleteTask = internalMutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", args.short_id))
      .first();
    if (!task) return { found: false };
    await unlinkDeletedTask(ctx, task);
    for (const table of ["task_comments", "task_history"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_task_id", (q: any) => q.eq("task_id", task._id))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    await ctx.db.delete(task._id);
    return { found: true, title: task.title, user_id: task.user_id, created_from: task.created_from_conversation ?? null, conversation_ids: task.conversation_ids ?? [] };
  },
});
