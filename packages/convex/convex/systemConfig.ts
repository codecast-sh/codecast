import { query, mutation } from "./functions";
import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";

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
  if (!user || user.role !== "admin") {
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

async function getSystemConfig(ctx: any, key: string): Promise<string | null> {
  const config = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .unique();
  return config?.value ?? null;
}

export const getMinCliVersion = query({
  args: {},
  handler: async (ctx) => getSystemConfig(ctx, "min_cli_version"),
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
