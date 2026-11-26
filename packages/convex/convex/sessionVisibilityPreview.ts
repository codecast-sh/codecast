// Who a new session in a folder would reach, before it exists: the composer's
// Personal / Team switch names the team and offers Team only where that team
// has Team sessions on; its Hidden / Summary / Full picker starts on what the
// team would see by default (`visibility`): Hidden where the folder rule keeps
// it private, else the member's own level for the team, the level a shared
// session without one of its own reads at. The same resolves createSession
// runs (resolveTeamForPath for the default, buildShareUpdate for a pick),
// read-only.
import { v } from "convex/values";
import { query } from "./functions";
import { getAuthenticatedUserId } from "./pendingMessages";
import { buildShareUpdate, resolveTeamForPath, type DirectoryMapping } from "./privacy";
import { canUseTeamSessions } from "./lib/teamFeatureGuard";
import { currentMembershipVisibility, type TeamVisibilityLevel } from "./teamVisibility";

export const creationTeam = query({
  args: { path: v.optional(v.string()), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ team_id: string; team_name: string; team_sessions: boolean; visibility: "private" | TeamVisibilityLevel } | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const path = args.path || undefined;
    const { teamId, isPrivate } = resolveTeamForPath(mappings as DirectoryMapping[], path, undefined);
    const share = await buildShareUpdate(ctx as any, { team_id: teamId, git_root: path }, userId);
    if (!share.team_id) return null;
    const team = await ctx.db.get(share.team_id);
    if (!team) return null;
    return {
      team_id: String(team._id),
      team_name: team.name,
      team_sessions: await canUseTeamSessions(ctx as any, team._id),
      // A sharing folder rule names this same team (buildShareUpdate keeps it).
      visibility: isPrivate ? "private" : currentMembershipVisibility(await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", team._id))
        .first()),
    };
  },
});
