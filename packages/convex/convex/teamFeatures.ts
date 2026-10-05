// Per-team opt-in features (chat, calls, org): the admin toggles. The catalog
// and the "absent = off" rule live in @codecast/shared/contracts/teamFeatures;
// the gate machinery (resolver, guard, offMessage, the per-user snippet
// availability the daemon heartbeat carries) is lib/teamFeatureGuard, a leaf
// re-exported here so existing importers keep one path.
import { v } from "convex/values";
import { mutation, internalMutation } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { TEAM_FEATURE_KEYS, teamFeatureEnabled, type TeamFeatures } from "@codecast/shared/contracts";
import type { Id } from "./_generated/dataModel";
import { applyFeatureChange } from "@platform/flags";
import { TEAM_FEATURE_CATALOG } from "./lib/teamFeatureGuard";
import { changesFlagChanged } from "./lib/changesDirty";
import { stopTeamRecordings } from "./lib/callRecordingRuns";

export {
  TEAM_FEATURE_CATALOG,
  teamHasFeature,
  workspaceHasFeature,
  teamFeatureOffMessage,
  requireTeamFeature,
  requireWorkspaceFeature,
  gatedSnippetAvailability,
} from "./lib/teamFeatureGuard";

const teamFeatureKeyValidator = v.union(
  ...(TEAM_FEATURE_KEYS.map((k) => v.literal(k)) as [any, ...any[]]),
);

/** What a feature change does beyond the flag. Calls going off takes every
 *  room of the team away from its people at once: the live room list drops
 *  them (and the REC mark with them), and every Stop is refused by the
 *  feature gate. So a room being filmed stops here, said in the room's
 *  thread, rather than filming people who can no longer see it or end it. */
async function afterFeatureChange(ctx: any, teamId: Id<"teams">, before: TeamFeatures | undefined, after: TeamFeatures) {
  await changesFlagChanged(ctx, teamId, before, after);
  if (teamFeatureEnabled({ features: before }, "calls") && !teamFeatureEnabled({ features: after }, "calls")) {
    await stopTeamRecordings(ctx, teamId, "calls_off");
  }
}


/** Admin-only: turn one team feature on or off. */
export const setTeamFeature = mutation({
  args: {
    team_id: v.id("teams"),
    feature: teamFeatureKeyValidator,
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id))
      .unique();
    const team = await ctx.db.get(args.team_id);
    const features = applyFeatureChange(TEAM_FEATURE_CATALOG, {
      isAdmin: membership?.role === "admin",
      current: team?.features,
      scopeExists: !!team,
      key: args.feature,
      enabled: args.enabled,
    });
    await ctx.db.patch(args.team_id, { features });
    await afterFeatureChange(ctx, args.team_id, team?.features, features);
    return { features };
  },
});

/** Operator-only (run.sh): the same change as setTeamFeature without a
 *  member's login, for turning a feature on or off for a team from the shell.
 *  Usage: packages/convex/run.sh teamFeatures:setTeamFeatureInternal
 *  '{"team_id":"<id>","feature":"org","enabled":true}' */
export const setTeamFeatureInternal = internalMutation({
  args: {
    team_id: v.id("teams"),
    feature: teamFeatureKeyValidator,
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.team_id);
    const features = applyFeatureChange(TEAM_FEATURE_CATALOG, {
      isAdmin: true,
      current: team?.features,
      scopeExists: !!team,
      key: args.feature,
      enabled: args.enabled,
    });
    await ctx.db.patch(args.team_id, { features });
    await afterFeatureChange(ctx, args.team_id, team?.features, features);
    return { team: team?.name ?? null, features };
  },
});
