import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";

export const getMinCliVersion = query({
  args: {},
  handler: async (ctx) => {
    const config = await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", "min_cli_version"))
      .unique();
    return config?.value ?? null;
  },
});

export const setMinCliVersion = mutation({
  args: {
    version: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      throw new Error("Unauthorized");
    }

    const user = await ctx.db.get(result.userId);
    if (!user || user.role !== "admin") {
      throw new Error("Admin access required");
    }

    const existing = await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", "min_cli_version"))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.version,
        updated_at: Date.now(),
        updated_by: result.userId,
      });
    } else {
      await ctx.db.insert("system_config", {
        key: "min_cli_version",
        value: args.version,
        updated_at: Date.now(),
        updated_by: result.userId,
      });
    }

    return { success: true, version: args.version };
  },
});
