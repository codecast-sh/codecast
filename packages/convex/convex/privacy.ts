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

export async function canTeamMemberAccess(
  ctx: DbCtx,
  viewerId: Id<"users">,
  conversation: ConversationForAccess
): Promise<boolean> {
  if (!conversation.team_id) return false;
  if (!(await isTeamMember(ctx, viewerId, conversation.team_id))) return false;
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

export function isConversationVisibleInFeed(
  conversation: { team_visibility?: string; is_private: boolean },
  ownerHasMappings: boolean
): boolean {
  if (conversation.team_visibility === "private") return false;
  if (ownerHasMappings && conversation.is_private !== false) return false;
  return true;
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
