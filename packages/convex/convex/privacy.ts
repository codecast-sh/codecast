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

// Single source of truth: is this conversation visible to team members?
// Checks (in order): team_visibility override, is_private flag, owner's membership visibility.
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

// Sync version for batch filtering when owner membership visibility is pre-fetched.
export function isConversationTeamVisibleSync(
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

// Directory mapping path filter for feed views.
// Separate concern from privacy: controls which projects a user shares with a team.
export function isPathMappedToTeam(
  userId: string,
  projectPath: string | undefined,
  mappings: Array<{ user_id: { toString(): string }; path_prefix: string }>,
  userHasMappings: Map<string, boolean>
): boolean {
  if (!userHasMappings.get(userId)) return true;
  if (!projectPath) return false;
  return mappings.some(
    m => m.user_id.toString() === userId &&
         (projectPath === m.path_prefix || projectPath.startsWith(m.path_prefix + "/"))
  );
}

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
