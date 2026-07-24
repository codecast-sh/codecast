// Centralized owner-or-team access layer for Convex functions.
//
// Wave-1 strangler-fig seed: the canonical home for "can this user touch this
// entity" checks. The task/doc/plan helpers moved here from their old files
// (tasks.ts, docs.ts, plans.ts), which now re-export them so every existing
// caller keeps working unchanged. The conversation sibling follows the same
// owner-or-team shape but routes through privacy.ts because conversation access
// is materially more nuanced than tasks/docs/plans (see below).

import { Id } from "../_generated/dataModel";
import { canTeamMemberAccess, isTeamMember, teamVisibleConvTeam } from "../privacy";
import { forbidden, notFound } from "./auth";

// Re-exported so callers that want the membership primitive can reach it through
// the access layer too (canAccessDoc uses it directly).
export { isTeamMember };

type AccessCtx = { db: any };

// ── Owner-or-team: tasks, docs, plans ──
// These three share one rule: the owner always has access; a non-owner has
// access iff the entity carries a team_id AND the user is a member of that team.
// Task assignment is also an explicit access grant; docs and plans use owner or
// team membership only.

export async function canAccessTask(
  ctx: AccessCtx,
  userId: Id<"users">,
  task: any,
): Promise<boolean> {
  if (task.user_id === userId) return true;
  if (task.assignee && String(task.assignee) === String(userId)) return true;
  if (!task.team_id) return false;
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", task.team_id))
    .first();
  return !!membership;
}

export async function canAccessProject(
  ctx: AccessCtx,
  userId: Id<"users">,
  project: { user_id: Id<"users">; team_id?: Id<"teams"> },
): Promise<boolean> {
  if (String(project.user_id) === String(userId)) return true;
  if (!project.team_id) return false;
  return await isTeamMember(ctx, userId, project.team_id);
}

export async function canAccessPullRequest(
  ctx: AccessCtx,
  userId: Id<"users">,
  pullRequest: { team_id: Id<"teams"> },
): Promise<boolean> {
  return await isTeamMember(ctx, userId, pullRequest.team_id);
}

/** Resolve the membership row or fail closed for an explicitly requested team. */
export async function requireTeamMembership(
  ctx: AccessCtx,
  userId: Id<"users">,
  teamId: Id<"teams">,
): Promise<any> {
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .first();
  if (!membership) forbidden("Forbidden: team membership required");
  return membership;
}

export async function requireTeamAdmin(
  ctx: AccessCtx,
  userId: Id<"users">,
  teamId: Id<"teams">,
): Promise<any> {
  const membership = await requireTeamMembership(ctx, userId, teamId);
  if (membership.role !== "admin") forbidden("Forbidden: team admin required");
  return membership;
}

export type AuthorizedWorkspace =
  | { type: "personal"; userId: Id<"users"> }
  | { type: "team"; teamId: Id<"teams"> };

export function workspaceForResource(
  resource: { user_id: Id<"users">; team_id?: Id<"teams"> },
): AuthorizedWorkspace {
  return resource.team_id
    ? { type: "team", teamId: resource.team_id }
    : { type: "personal", userId: resource.user_id };
}

/** Conversation team_id is routing; only a team-visible conversation is team-scoped. */
export function workspaceForConversation(
  conversation: {
    user_id: Id<"users">;
    team_id?: Id<"teams">;
    is_private?: boolean;
    auto_shared?: boolean;
    team_visibility?: string;
  },
): AuthorizedWorkspace {
  const teamId = teamVisibleConvTeam(conversation);
  return teamId
    ? { type: "team", teamId }
    : { type: "personal", userId: conversation.user_id };
}

export function workspacesMatch(
  left: AuthorizedWorkspace,
  right: AuthorizedWorkspace,
): boolean {
  return left.type === "team" && right.type === "team"
    ? String(left.teamId) === String(right.teamId)
    : left.type === "personal" && right.type === "personal"
      ? String(left.userId) === String(right.userId)
      : false;
}

export function requireWorkspaceMatch(
  left: AuthorizedWorkspace,
  right: AuthorizedWorkspace,
  label: string,
): void {
  if (!workspacesMatch(left, right)) {
    forbidden(`Forbidden: ${label} belongs to another workspace`);
  }
}

export function isSameWorkspace(
  resource: { user_id: Id<"users">; team_id?: Id<"teams"> },
  workspace: AuthorizedWorkspace,
): boolean {
  return workspace.type === "team"
    ? String(resource.team_id) === String(workspace.teamId)
    : !resource.team_id && String(resource.user_id) === String(workspace.userId);
}

/** Relationships may only join resources inside the same authorization domain. */
export function requireSameWorkspace(
  resource: { user_id: Id<"users">; team_id?: Id<"teams"> },
  workspace: AuthorizedWorkspace,
  label: string,
): void {
  if (!isSameWorkspace(resource, workspace)) {
    forbidden(`Forbidden: ${label} belongs to another workspace`);
  }
}

export async function requireAccessibleTask(
  ctx: AccessCtx,
  userId: Id<"users">,
  taskId: Id<"tasks">,
): Promise<any> {
  const task = await ctx.db.get(taskId);
  if (!task || !(await canAccessTask(ctx, userId, task))) notFound("Task not found");
  return task;
}

export async function requireAccessiblePlan(
  ctx: AccessCtx,
  userId: Id<"users">,
  planId: Id<"plans">,
): Promise<any> {
  const plan = await ctx.db.get(planId);
  if (!plan || !(await canAccessPlan(ctx, userId, plan))) notFound("Plan not found");
  return plan;
}

export async function requireAccessibleProject(
  ctx: AccessCtx,
  userId: Id<"users">,
  projectId: Id<"projects">,
): Promise<any> {
  const project = await ctx.db.get(projectId);
  if (!project || !(await canAccessProject(ctx, userId, project))) notFound("Project not found");
  return project;
}

export async function requireAccessibleDoc(
  ctx: AccessCtx,
  userId: Id<"users">,
  docId: Id<"docs">,
): Promise<any> {
  const doc = await ctx.db.get(docId);
  if (!doc || !(await canAccessDoc(ctx, userId, doc))) notFound("Doc not found");
  return doc;
}

export async function requireAccessibleConversation(
  ctx: AccessCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<any> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) {
    notFound("Conversation not found");
  }
  return conversation;
}

export async function requireAccessiblePullRequest(
  ctx: AccessCtx,
  userId: Id<"users">,
  pullRequestId: Id<"pull_requests">,
): Promise<any> {
  const pullRequest = await ctx.db.get(pullRequestId);
  if (!pullRequest || !(await canAccessPullRequest(ctx, userId, pullRequest))) {
    notFound("Pull request not found");
  }
  return pullRequest;
}

export async function canAccessDoc(
  ctx: AccessCtx,
  userId: Id<"users">,
  doc: { user_id: Id<"users">; team_id?: Id<"teams"> },
): Promise<boolean> {
  if (doc.user_id === userId) return true;
  if (!doc.team_id) return false;
  return await isTeamMember(ctx, userId, doc.team_id);
}

export async function canAccessPlan(
  ctx: AccessCtx,
  userId: Id<"users">,
  plan: any,
): Promise<boolean> {
  if (plan.user_id === userId) return true;
  if (!plan.team_id) return false;
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", plan.team_id))
    .first();
  return !!membership;
}

// ── Owner-or-team: conversations (faithful, NOT oversimplified) ──
// Conversations do NOT use the plain owner-or-team rule above. team_id is
// routing — it's stamped even on private conversations — so "team member" alone
// is not enough. A teammate gets access only when the conversation is actually
// team-visible (is_private:false or a team_visibility override, AND the owner
// hasn't opted out of sharing). This is exactly the rule every conversation
// caller already enforces (comments.ts, messages.ts): `isOwner ||
// canTeamMemberAccess`. We route through privacy.ts so there is one source of
// truth for that nuance. The `shared`/share_token guest path is deliberately
// out of scope — it is a separate, unauthenticated access concern.
export async function canAccessConversation(
  ctx: AccessCtx,
  userId: Id<"users">,
  conversation: {
    user_id: Id<"users">;
    team_id?: Id<"teams">;
    is_private: boolean;
    team_visibility?: string;
    share_token?: string;
  },
): Promise<boolean> {
  if (conversation.user_id.toString() === userId.toString()) return true;
  return await canTeamMemberAccess(ctx, userId, conversation);
}
