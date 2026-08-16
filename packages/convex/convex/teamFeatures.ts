// Per-team opt-in features (chat, calls). The catalog and the "absent = off"
// rule live in @codecast/shared/contracts/teamFeatures; this module is the
// server half: the stored shape, the guard every feature chokepoint calls, the
// admin toggle, and the per-user snippet availability the daemon heartbeat
// carries so a member's agent snippets follow the flag.
import { v } from "convex/values";
import { mutation } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import {
  TEAM_FEATURE_KEYS,
  TEAM_FEATURES,
  teamFeatureEnabled,
  type TeamFeatureKey,
} from "@codecast/shared/contracts";

const teamFeatureKeyValidator = v.union(
  ...(TEAM_FEATURE_KEYS.map((k) => v.literal(k)) as [any, ...any[]]),
);

type DbCtx = { db: any };

/** Is `key` on for team `teamId`? Missing team = off. */
export async function teamHasFeature(
  ctx: DbCtx,
  teamId: Id<"teams"> | null | undefined,
  key: TeamFeatureKey,
): Promise<boolean> {
  if (!teamId) return false;
  const team = await ctx.db.get(teamId);
  return teamFeatureEnabled(team, key);
}

/** The message a caller sees when a feature is off — the same words on the
 *  CLI, the web and mobile, and it says who can fix it. */
export function teamFeatureOffMessage(key: TeamFeatureKey): string {
  const name = TEAM_FEATURES.find((f) => f.key === key)?.name ?? key;
  return `${name} is not enabled for this team. A team admin can turn it on under Settings → Team.`;
}

/**
 * The feature guard. Throws with the shared message unless `key` is on for the
 * team. `fail` lets a module raise its own error class (chat's ConvexError
 * codes) while keeping one wording.
 */
export async function requireTeamFeature(
  ctx: DbCtx,
  teamId: Id<"teams"> | null | undefined,
  key: TeamFeatureKey,
  fail: (message: string) => never = (m) => { throw new Error(m); },
): Promise<void> {
  if (!(await teamHasFeature(ctx, teamId, key))) fail(teamFeatureOffMessage(key));
}

/**
 * Which feature-gated agent snippets this user's teams make available: for
 * every snippet some team feature names, whether at least one of the user's
 * teams has that feature on. Ungated snippets are not listed — the daemon
 * only reconciles what appears here. Rides on the heartbeat response so a
 * machine that was asleep when a team flipped a feature converges on its next
 * beat instead of missing a pushed command.
 */
export async function gatedSnippetAvailability(
  ctx: DbCtx,
  userId: Id<"users">,
): Promise<Record<string, boolean>> {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const teams = await Promise.all(memberships.map((m: any) => ctx.db.get(m.team_id)));
  const out: Record<string, boolean> = {};
  for (const feature of TEAM_FEATURES) {
    const on = teams.some((t: any) => teamFeatureEnabled(t, feature.key));
    for (const slug of feature.snippets) out[slug] = (out[slug] ?? false) || on;
  }
  return out;
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
    if (!membership || membership.role !== "admin") {
      throw new Error("Only admins can change team features");
    }
    const team = await ctx.db.get(args.team_id);
    if (!team) throw new Error("Team not found");
    const features = { ...(team.features ?? {}), [args.feature]: args.enabled };
    await ctx.db.patch(args.team_id, { features });
    return { features };
  },
});
