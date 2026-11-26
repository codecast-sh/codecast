// The team a new session in a folder would belong to, before it exists: the
// composer's Personal / Team switch names it, and offers Team only where that
// team has Team sessions on. The same resolve createSession runs for a Team
// pick (the folder and repo rules, then buildShareUpdate's fallback), read-only.
import { v } from "convex/values";
import { query } from "./functions";
import { getAuthenticatedUserId } from "./pendingMessages";
import { buildShareUpdate, resolveTeamForPath, type DirectoryMapping } from "./privacy";
import { canUseTeamSessions } from "./lib/teamFeatureGuard";

export const creationTeam = query({
  args: { path: v.optional(v.string()), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ team_id: string; team_name: string; team_sessions: boolean } | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const path = args.path || undefined;
    const { teamId } = resolveTeamForPath(mappings as DirectoryMapping[], path, undefined);
    const share = await buildShareUpdate(ctx as any, { team_id: teamId, git_root: path }, userId);
    if (!share.team_id) return null;
    const team = await ctx.db.get(share.team_id);
    if (!team) return null;
    return { team_id: String(team._id), team_name: team.name, team_sessions: await canUseTeamSessions(ctx as any, team._id) };
  },
});
