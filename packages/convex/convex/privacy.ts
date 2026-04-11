import { Id } from "./_generated/dataModel";

type DbCtx = { db: any };

type ConversationForAccess = {
  user_id: Id<"users">;
  team_id?: Id<"teams">;
  is_private: boolean;
  team_visibility?: string;
  share_token?: string;
};

export type AccessLevel = "owner" | "team" | "shared" | "denied";

// ── Team membership ──

export async function isTeamMember(
  ctx: DbCtx,
  userId: Id<"users">,
  teamId: Id<"teams">
): Promise<boolean> {
  const m = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) =>
      q.eq("user_id", userId).eq("team_id", teamId)
    )
    .first();
  return !!m;
}

async function getOwnerTeamVisibility(
  ctx: DbCtx,
  ownerId: Id<"users">,
  teamId: Id<"teams">
): Promise<string> {
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) =>
      q.eq("user_id", ownerId).eq("team_id", teamId)
    )
    .first();
  return membership?.visibility || "summary";
}

function isVisibilityShareable(visibility: string): boolean {
  return visibility !== "hidden" && visibility !== "activity";
}

// ── Access control (single conversation) ──
// is_private is the source of truth (set at creation from directory_team_mappings auto_share).
// team_visibility is the per-conversation override. Membership visibility is user-level opt-out.

export async function isConversationTeamVisible(
  ctx: DbCtx,
  conversation: ConversationForAccess
): Promise<boolean> {
  if (!conversation.team_id) return false;
  const ownerVisibility = await getOwnerTeamVisibility(
    ctx,
    conversation.user_id,
    conversation.team_id
  );
  if (!isVisibilityShareable(ownerVisibility)) return false;
  if (conversation.is_private === false) return true;
  if (conversation.team_visibility && conversation.team_visibility !== "private")
    return true;
  return false;
}

function isConversationTeamVisibleSync(
  conversation: { is_private: boolean; team_visibility?: string; team_id?: any; user_id: any },
  ownerMembershipVisibility: string
): boolean {
  if (!conversation.team_id) return false;
  if (!isVisibilityShareable(ownerMembershipVisibility)) return false;
  if (conversation.is_private === false) return true;
  if (conversation.team_visibility && conversation.team_visibility !== "private")
    return true;
  return false;
}

export async function canTeamMemberAccess(
  ctx: DbCtx,
  viewerId: Id<"users">,
  conversation: ConversationForAccess
): Promise<boolean> {
  if (!conversation.team_id) return false;
  if (!(await isTeamMember(ctx, viewerId, conversation.team_id))) return false;
  return isConversationTeamVisible(ctx, conversation);
}

export async function checkConversationAccess(
  ctx: DbCtx,
  viewerId: Id<"users"> | null,
  conversation: ConversationForAccess
): Promise<AccessLevel> {
  if (viewerId) {
    if (conversation.user_id.toString() === viewerId.toString()) return "owner";
    if (await canTeamMemberAccess(ctx, viewerId, conversation)) return "team";
  }
  if (conversation.share_token) return "shared";
  return "denied";
}

// ── Team feed filter ──
// Pre-loads membership data for team feed filtering, returns a predicate.
// Use this everywhere team conversations are listed or counted.
//
// Visibility is determined by is_private (set at creation from auto_share).
// Membership visibility is a user-level opt-out (hidden users are invisible).
//
// Usage:
//   const filter = await createTeamFeedFilter(ctx, teamId);
//   const visible = conversations.filter(c => filter.isVisible(c));
//   const vis = filter.getVisibility(userId);  // for resolveVisibilityMode

type ConversationForFeed = {
  user_id: { toString(): string };
  team_id?: any;
  is_private: boolean;
  team_visibility?: string;
};

export type TeamFeedFilter = {
  isVisible: (conversation: ConversationForFeed) => boolean;
  getVisibility: (userId: string) => string;
  memberships: Array<{ user_id: Id<"users">; visibility?: string }>;
};

export async function createTeamFeedFilter(
  ctx: DbCtx,
  teamId: Id<"teams">
): Promise<TeamFeedFilter> {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
    .collect();

  const visibilityMap = new Map<string, string>(
    memberships.map((m: any) => [m.user_id.toString(), m.visibility || "summary"])
  );

  const isVisible = (conversation: ConversationForFeed): boolean => {
    if (!conversation.team_id) return false;
    const ownerVis = visibilityMap.get(conversation.user_id.toString()) || "summary";
    return isConversationTeamVisibleSync(conversation as any, ownerVis);
  };

  const getVisibility = (userId: string): string => {
    return visibilityMap.get(userId) || "summary";
  };

  return { isVisible, getVisibility, memberships };
}

// ── Team resolution for session creation ──
// Single source of truth for resolving which team a conversation belongs to.
// Used by dispatch.ts and conversations.ts session creation.

export type DirectoryMapping = {
  team_id: Id<"teams">;
  path_prefix: string;
  auto_share: boolean;
};

export function resolveTeamForPath(
  userMappings: DirectoryMapping[],
  conversationPath: string | undefined,
  fallbackTeamId: Id<"teams"> | undefined
): { teamId: Id<"teams"> | undefined; isPrivate: boolean; autoShared: boolean } {
  let resolvedTeamId = fallbackTeamId;
  let isPrivate = true;
  let autoShared = false;

  if (conversationPath && userMappings.length > 0) {
    let bestMatch: DirectoryMapping | null = null;
    for (const mapping of userMappings) {
      if (
        conversationPath === mapping.path_prefix ||
        conversationPath.startsWith(mapping.path_prefix + "/")
      ) {
        if (!bestMatch || mapping.path_prefix.length > bestMatch.path_prefix.length) {
          bestMatch = mapping;
        }
      }
    }

    if (bestMatch) {
      resolvedTeamId = bestMatch.team_id;
      if (bestMatch.auto_share) { isPrivate = false; autoShared = true; }
    } else {
      resolvedTeamId = undefined;
    }
  }

  return { teamId: resolvedTeamId, isPrivate, autoShared };
}

// ── Visibility modes ──

export type VisibilityMode = "full" | "detailed" | "summary" | "minimal";

const MEMBERSHIP_TO_VISIBILITY: Record<string, VisibilityMode> = {
  hidden: "minimal",
  activity: "minimal",
  summary: "summary",
  full: "full",
  detailed: "detailed",
  minimal: "minimal",
};

export function resolveVisibilityMode(
  teamVisibility: string | undefined,
  ownerMembershipVisibility: string | undefined,
  isTeamFilter: boolean
): VisibilityMode {
  if (!isTeamFilter) return "full";
  if (teamVisibility) return teamVisibility as VisibilityMode;
  const fallback = ownerMembershipVisibility || "activity";
  return MEMBERSHIP_TO_VISIBILITY[fallback] || "detailed";
}
