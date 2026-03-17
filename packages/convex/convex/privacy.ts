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
// These check whether a specific conversation CAN be seen by a team member.
// They do NOT apply path-based feed filtering -- use TeamFeedFilter for that.

export async function isConversationTeamVisible(
  ctx: DbCtx,
  conversation: ConversationForAccess
): Promise<boolean> {
  if (!conversation.team_id) return false;
  if (conversation.is_private === false) return true;
  if (conversation.team_visibility && conversation.team_visibility !== "private")
    return true;
  const ownerVisibility = await getOwnerTeamVisibility(
    ctx,
    conversation.user_id,
    conversation.team_id
  );
  return isVisibilityShareable(ownerVisibility);
}

function isConversationTeamVisibleSync(
  conversation: { is_private: boolean; team_visibility?: string; team_id?: any; user_id: any },
  ownerMembershipVisibility: string
): boolean {
  if (!conversation.team_id) return false;
  if (conversation.is_private === false) return true;
  if (conversation.team_visibility && conversation.team_visibility !== "private")
    return true;
  return isVisibilityShareable(ownerMembershipVisibility);
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
// Pre-loads all data needed for team feed filtering, returns a predicate.
// Use this everywhere team conversations are listed or counted.
//
// Encapsulates:
//   1. Membership visibility (privacy/sharing check)
//   2. Directory path mapping (only show conversations from mapped projects)
//
// Usage:
//   const filter = await createTeamFeedFilter(ctx, teamId);
//   const visible = conversations.filter(c => filter.isVisible(c));
//   const vis = filter.getVisibility(userId);  // for resolveVisibilityMode

type TeamMapping = { user_id: { toString(): string }; path_prefix: string };

type ConversationForFeed = {
  user_id: { toString(): string };
  team_id?: any;
  is_private: boolean;
  team_visibility?: string;
  git_root?: string;
  project_path?: string;
};

export type TeamFeedFilter = {
  isVisible: (conversation: ConversationForFeed) => boolean;
  getVisibility: (userId: string) => string;
  memberships: Array<{ user_id: Id<"users">; visibility?: string }>;
  mappings: TeamMapping[];
};

export async function createTeamFeedFilter(
  ctx: DbCtx,
  teamId: Id<"teams">
): Promise<TeamFeedFilter> {
  const [memberships, mappings] = await Promise.all([
    ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
      .collect(),
    ctx.db
      .query("directory_team_mappings")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
      .collect(),
  ]);

  const memberUserIds = memberships.map((m: any) => m.user_id) as Array<Id<"users">>;
  const userHasMappings = await buildUserHasMappings(ctx, memberUserIds);

  const visibilityMap = new Map<string, string>(
    memberships.map((m: any) => [m.user_id.toString(), m.visibility || "summary"])
  );

  const isVisible = (conversation: ConversationForFeed): boolean => {
    if (!conversation.team_id) return false;

    const ownerVis = visibilityMap.get(conversation.user_id.toString()) || "summary";
    if (!isConversationTeamVisibleSync(conversation as any, ownerVis)) return false;

    const ownerHas = !!userHasMappings.get(conversation.user_id.toString());
    if (!ownerHas) return true;

    const path = conversation.git_root || conversation.project_path;
    if (!path) return false;

    const userId = conversation.user_id.toString();
    return mappings.some(
      (m: any) => m.user_id.toString() === userId &&
           (path === m.path_prefix || path.startsWith(m.path_prefix + "/"))
    );
  };

  const getVisibility = (userId: string): string => {
    return visibilityMap.get(userId) || "summary";
  };

  return { isVisible, getVisibility, memberships, mappings };
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
  teamSharePaths: string[] | undefined,
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

  if (!autoShared && teamSharePaths && teamSharePaths.length > 0 && resolvedTeamId && conversationPath) {
    for (const sharePath of teamSharePaths) {
      if (conversationPath === sharePath || conversationPath.startsWith(sharePath + "/")) {
        isPrivate = false;
        autoShared = true;
        break;
      }
    }
  }

  return { teamId: resolvedTeamId, isPrivate, autoShared };
}

// ── Resolve team for mutations ──

export async function resolveTeamForMutation(
  ctx: DbCtx,
  userId: Id<"users">,
  opts?: { project_path?: string; team_id?: Id<"teams"> }
): Promise<Id<"teams"> | undefined> {
  if (opts?.team_id) return opts.team_id;

  if (opts?.project_path) {
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const result = resolveTeamForPath(mappings, opts.project_path, undefined, undefined);
    return result.teamId;
  }

  const user = await ctx.db.get(userId);
  return user?.active_team_id || user?.team_id;
}

// ── Build userHasMappings ──

async function buildUserHasMappings(
  ctx: DbCtx,
  userIds: Array<Id<"users">>
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const checks = await Promise.all(
    userIds.map(uid =>
      ctx.db.query("directory_team_mappings")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", uid))
        .first()
    )
  );
  userIds.forEach((uid: Id<"users">, i: number) => {
    if (checks[i]) result.set(uid.toString(), true);
  });
  return result;
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
