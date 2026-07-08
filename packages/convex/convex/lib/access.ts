// Centralized owner-or-team access layer for Convex functions.
//
// Wave-1 strangler-fig seed: the canonical home for "can this user touch this
// entity" checks. The task/doc/plan helpers moved here VERBATIM from their old
// files (tasks.ts, docs.ts, plans.ts), which now re-export them so every
// existing caller keeps working unchanged. The conversation sibling follows the
// SAME owner-or-team shape but routes through privacy.ts because conversation
// access is materially more nuanced than tasks/docs/plans (see below).

import { Id } from "../_generated/dataModel";
import { canTeamMemberAccess, isTeamMember } from "../privacy";

// Re-exported so callers that want the membership primitive can reach it through
// the access layer too (canAccessDoc uses it directly).
export { isTeamMember };

type AccessCtx = { db: any };

// ── Owner-or-team: tasks, docs, plans ──
// These three share one rule: the owner always has access; a non-owner has
// access iff the entity carries a team_id AND the user is a member of that team.
// Moved verbatim from tasks.ts / docs.ts / plans.ts.

export async function canAccessTask(
  ctx: AccessCtx,
  userId: Id<"users">,
  task: any,
): Promise<boolean> {
  if (task.user_id === userId) return true;
  if (!task.team_id) return false;
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", task.team_id))
    .first();
  return !!membership;
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
