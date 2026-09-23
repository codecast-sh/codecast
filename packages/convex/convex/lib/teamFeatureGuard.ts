// The team feature GUARD, a leaf module: it reads a team's flag bag and
// nothing else, and imports nothing from ./functions. Every module that gates
// a read or a write on a feature (chat, calls, org, transcripts, the anchors
// roster) imports from here. teamFeatures.ts holds the admin mutations and
// re-exports these, so the two never form a cycle: a module wrapper that
// imports a gate that imports the module wrapper dies at load ("Cannot access
// 'mutation' before initialization") in every test that reaches it.
import type { Id } from "../_generated/dataModel";
import {
  TEAM_FEATURES,
  workspaceFeatureEnabled,
  type TeamFeatureKey,
} from "@codecast/shared/contracts";
import {
  attachedAvailability,
  createFeatureGuard,
  defineFeatures,
} from "@platform/flags";

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

/**
 * Is `key` on in a workspace: a team's own flag, or, for the personal
 * workspace (no team), any team the person belongs to. The personal rule is
 * the shared one (workspaceFeatureEnabled) so the web hook, the CLI and this
 * guard agree on whose personal org exists.
 */
export async function workspaceHasFeature(
  ctx: DbCtx,
  scope: { team_id?: Id<"teams"> | null; user_id?: Id<"users"> | null },
  key: TeamFeatureKey,
): Promise<boolean> {
  if (scope.team_id) return teamHasFeature(ctx, scope.team_id, key);
  if (!scope.user_id) return false;
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", scope.user_id))
    .collect();
  const teams = await Promise.all(memberships.map((m: any) => ctx.db.get(m.team_id)));
  return workspaceFeatureEnabled(teams, null, key);
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

/** The workspace guard: throws the shared message unless `key` is on for the
 *  scope (a team's flag, or the personal rule). For writes that create org
 *  rows, so a hidden feature cannot be reached by a stale client or a raw
 *  API call. */
export async function requireWorkspaceFeature(
  ctx: DbCtx,
  scope: { team_id?: Id<"teams"> | null; user_id?: Id<"users"> | null },
  key: TeamFeatureKey,
  fail: (message: string) => never = (m) => { throw new Error(m); },
): Promise<void> {
  if (!(await workspaceHasFeature(ctx, scope, key))) fail(guard.offMessage(key));
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

