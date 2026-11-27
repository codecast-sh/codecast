import { query, mutation } from "./functions";
import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { isStaff } from "./lib/staff";
import { userTeams } from "./lib/teamFeatureGuard";
import { isBelowMinimum } from "@platform/flags";
import type { Id } from "./_generated/dataModel";

// Admin-gated upsert of a single system_config row. Shared by every "minimum
// version" lever (CLI binary, desktop app) so the auth + upsert lives once.
async function setSystemConfig(
  ctx: any,
  key: string,
  value: string,
  apiToken: string,
): Promise<{ success: true; version: string }> {
  const result = await verifyApiToken(ctx, apiToken);
  if (!result) {
    throw new Error("Unauthorized");
  }

  const user = await ctx.db.get(result.userId);
  if (!user || !isStaff(user)) {
    throw new Error("Admin access required");
  }

  const existing = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      value,
      updated_at: Date.now(),
      updated_by: result.userId,
    });
  } else {
    await ctx.db.insert("system_config", {
      key,
      value,
      updated_at: Date.now(),
      updated_by: result.userId,
    });
  }

  return { success: true, version: value };
}

export async function getSystemConfig(ctx: any, key: string): Promise<string | null> {
  const config = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .unique();
  return config?.value ?? null;
}

/** The highest of the given floors; null when none is set. */
export function highestFloor(floors: Array<string | null | undefined>): string | null {
  return floors.reduce<string | null>((top, f) => (f && (!top || isBelowMinimum(top, f)) ? f : top), null);
}

/**
 * The CLI floor a user's machines are held to: the global min_cli_version
 * raised by the floor of every team they belong to. A team floor never lowers
 * the global one. Null when nothing is set.
 */
export async function effectiveMinCliVersion(ctx: any, userId: Id<"users"> | null | undefined): Promise<string | null> {
  const global = await getSystemConfig(ctx, "min_cli_version");
  if (!userId) return global;
  const teams = await userTeams(ctx, userId);
  return highestFloor([global, ...teams.map((t) => t?.min_cli_version)]);
}

// A daemon that sends its token gets its owner's floor (team floors included);
// one that predates that sends no args and gets the global floor.
export const getMinCliVersion = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const auth = args.api_token ? await verifyApiToken(ctx, args.api_token) : null;
    return effectiveMinCliVersion(ctx, auth?.userId);
  },
});

export const setMinCliVersion = mutation({
  args: {
    version: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    setSystemConfig(ctx, "min_cli_version", args.version, args.api_token),
});

// Minimum desktop (Electron) app version. When a client's installed app is
// below this, the daemon applies the published update EVEN WHILE THE APP IS
// RUNNING (quit + swap + relaunch) instead of deferring — the only way an
// always-open client ever converges. release.sh sets this on each desktop
// release, mirroring how deploy.sh force-updates the CLI.
export const getMinDesktopVersion = query({
  args: {},
  handler: async (ctx) => getSystemConfig(ctx, "min_desktop_version"),
});

export const setMinDesktopVersion = mutation({
  args: {
    version: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    setSystemConfig(ctx, "min_desktop_version", args.version, args.api_token),
});
