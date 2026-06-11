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

// ── Profile activity visibility ──
// A user's profile page (team/[username]) surfaces their conversations, message
// previews, and activity counts. Selecting by (team_id, user_id) alone is NOT a
// privacy gate — team_id is routing, set even on is_private conversations. These
// helpers re-apply the real gate so a teammate's profile shows only *shared*
// activity, while the owner viewing their own profile sees everything.

// Pure per-conversation decision. Unit-tested in privacy.test.ts.
export function profileConversationVisible(
  isOwner: boolean,
  isViewerTeamMember: boolean,
  ownerMembershipVisibility: string,
  conversation: ConversationForFeed
): boolean {
  if (isOwner) return true; // viewing your own profile → see all your activity
  if (!isViewerTeamMember) return false; // not a member of the scoping team → nothing
  return isConversationTeamVisibleSync(conversation as any, ownerMembershipVisibility);
}

// Builds the predicate used to filter a target user's conversations on their
// profile, loading membership data once via createTeamFeedFilter. Owner sees
// all; a teammate sees only team-visible (non-private) conversations; anyone
// else (or a missing team scope) sees nothing.
export async function getProfileVisibilityPredicate(
  ctx: DbCtx,
  viewerId: Id<"users"> | null,
  targetUserId: Id<"users">,
  teamId: Id<"teams"> | undefined
): Promise<(conversation: ConversationForFeed) => boolean> {
  if (viewerId && viewerId.toString() === targetUserId.toString()) return () => true;
  if (!viewerId || !teamId) return () => false;
  const filter = await createTeamFeedFilter(ctx, teamId);
  const isMember = filter.memberships.some(
    (m) => m.user_id.toString() === viewerId.toString()
  );
  const ownerVis = filter.getVisibility(targetUserId.toString());
  return (conversation) => profileConversationVisible(false, isMember, ownerVis, conversation);
}

// ── Public profile visibility (the third, anonymous tier) ──
// is_private=false only means "team-visible" — NOT world-visible. A session is
// PUBLIC only because its owner explicitly pinned it to their public profile,
// which the pin mutation backs with a share_token. We require BOTH here as
// defense in depth: an un-pin or a revoked token immediately drops the session
// from the anonymous profile even if the other field lingers. No auth context
// is consulted — this is the rule for an anonymous visitor.
export function profilePublicSessionVisible(conversation: {
  profile_pinned_at?: number;
  share_token?: string;
}): boolean {
  return !!conversation.profile_pinned_at && !!conversation.share_token;
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

// Sharing a conversation (is_private → false) MUST guarantee a team_id, or the
// conversation becomes "shared with nobody": every team-visibility check
// short-circuits on `!team_id` (see isConversationTeamVisible), so no teammate
// can see it even though it reads as non-private. This builds the patch that
// flips a conversation shared while ensuring it carries a team:
//   1. keep an already-assigned team_id,
//   2. else re-resolve from the owner's directory mappings (the creation rule),
//   3. else fall back to the owner's active/default team.
// team_id is only omitted if the owner belongs to no team at all.
export async function buildShareUpdate(
  ctx: DbCtx,
  conversation: { team_id?: Id<"teams">; git_root?: string; project_path?: string },
  ownerId: Id<"users">
): Promise<{ is_private: false; team_id?: Id<"teams"> }> {
  const updates: { is_private: false; team_id?: Id<"teams"> } = { is_private: false };
  if (conversation.team_id) {
    updates.team_id = conversation.team_id;
    return updates;
  }

  const mappings = await ctx.db
    .query("directory_team_mappings")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", ownerId))
    .collect();
  const { teamId } = resolveTeamForPath(
    mappings as DirectoryMapping[],
    conversation.git_root || conversation.project_path,
    undefined
  );
  if (teamId) {
    updates.team_id = teamId;
    return updates;
  }

  const owner = await ctx.db.get(ownerId);
  const fallback = owner?.active_team_id ?? owner?.team_id;
  if (fallback) updates.team_id = fallback;
  return updates;
}

// Team/privacy is resolved once at creation from whatever path exists at that
// instant — but several flows mint the conversation before the real path is
// known (quick-create pre-warm, web-started stubs) and stamp project_path /
// git_root later. Without re-resolving, those conversations keep their
// born-blank visibility (private, teamless) forever, even when the directory
// has an auto_share mapping covering it.
//
// Builds the creation-equivalent team/privacy patch for a late path stamp.
// Explicit user choices always win, and a restamp only ever applies a positive
// mapping match — revoking access stays a user action:
//  - team_visibility "private" (user locked it private) → no change
//  - is_private false without auto_shared (user shared it manually) → no change
//  - no mapping match for the path → no change
export function buildPathRestampUpdate(
  conversation: {
    team_id?: Id<"teams">;
    is_private?: boolean;
    auto_shared?: boolean;
    team_visibility?: string;
  },
  mappings: DirectoryMapping[],
  conversationPath: string | undefined
): { team_id?: Id<"teams">; is_private?: boolean; auto_shared?: boolean } | null {
  if (conversation.team_visibility === "private") return null;
  if (conversation.is_private === false && !conversation.auto_shared) return null;

  const { teamId, autoShared } = resolveTeamForPath(mappings, conversationPath, undefined);
  if (!teamId) return null;

  const patch: { team_id?: Id<"teams">; is_private?: boolean; auto_shared?: boolean } = {};
  if (conversation.team_id?.toString() !== teamId.toString()) {
    patch.team_id = teamId;
  }
  if (autoShared && conversation.is_private !== false) {
    patch.is_private = false;
    patch.auto_shared = true;
  }
  return Object.keys(patch).length > 0 ? patch : null;
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
