// Per-team opt-in features (chat, calls). The catalog and the "absent = off"
// rule live in @codecast/shared/contracts/teamFeatures; the gate machinery —
// the resolver, the guard, the admin toggle decision, the fan out to attached
// items, and the wording every surface shares — comes from @platform/flags.
// This module is the server half: it binds that machinery to codecast's
// catalog and to how a team's flags are stored (`teams.features`), and adds
// the per-user snippet availability the daemon heartbeat carries so a member's
// agent snippets follow the flag.
import { v } from "convex/values";
import { mutation } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import {
  TEAM_FEATURE_KEYS,
  TEAM_FEATURES,
  type TeamFeatureKey,
} from "@codecast/shared/contracts";
import {
  applyFeatureChange,
  attachedAvailability,
  createFeatureGuard,
  defineFeatures,
} from "@platform/flags";

const teamFeatureKeyValidator = v.union(
  ...(TEAM_FEATURE_KEYS.map((k) => v.literal(k)) as [any, ...any[]]),
);

type DbCtx = { db: any };

/** codecast's catalog as a @platform/flags catalog. The descriptors are the
 *  shared table verbatim — `snippets` rides along as an extra field, which is
 *  what the snippet fan out below reads. */
export const TEAM_FEATURE_CATALOG = defineFeatures(TEAM_FEATURES);

/** A team, addressed the way the guard loads it: the row lives in this ctx. */
type TeamScope = { ctx: DbCtx; teamId: Id<"teams"> };

const guard = createFeatureGuard<TeamFeatureKey, TeamScope>({
  catalog: TEAM_FEATURE_CATALOG,
  loadFlags: async ({ ctx, teamId }) => (await ctx.db.get(teamId))?.features,
});

const scopeFor = (ctx: DbCtx, teamId: Id<"teams"> | null | undefined): TeamScope | null =>
  teamId ? { ctx, teamId } : null;

/** Is `key` on for team `teamId`? Missing team = off. */
export async function teamHasFeature(
  ctx: DbCtx,
  teamId: Id<"teams"> | null | undefined,
  key: TeamFeatureKey,
): Promise<boolean> {
  return guard.has(scopeFor(ctx, teamId), key);
}

/** The message a caller sees when a feature is off — the same words on the
 *  CLI, the web and mobile, and it says who can fix it. */
export function teamFeatureOffMessage(key: TeamFeatureKey): string {
  return guard.offMessage(key);
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
  return guard.require(scopeFor(ctx, teamId), key, fail);
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
  return attachedAvailability(TEAM_FEATURE_CATALOG, teams, (f) => f.snippets);
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
    return { features };
  },
});
