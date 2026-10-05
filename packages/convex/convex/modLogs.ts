import { v } from "convex/values";
import { mutation } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import type { Id } from "./_generated/dataModel";

/**
 * What running mods say (console lines, thrown errors, refused calls), written
 * by the web host and read back by `cast mod logs` (mods.cliLogs). Its own
 * module: a log line is not a write to the mods collection the store syncs.
 */

export const LOG_CAP = 300;

export async function appendLogs(ctx: any, modId: Id<"mods">, userId: Id<"users">, entries: { level: string; text: string }[]) {
  const now = Date.now();
  for (const [i, e] of entries.slice(0, 50).entries()) {
    await ctx.db.insert("mod_logs", { mod_id: modId, user_id: userId, level: e.level.slice(0, 10), text: e.text.slice(0, 4000), created_at: now + i / 1000 });
  }
  // Keep the newest LOG_CAP lines: read past the cap, oldest first, and drop the rest.
  const total = await ctx.db
    .query("mod_logs")
    .withIndex("by_mod_created", (q: any) => q.eq("mod_id", modId))
    .order("desc")
    .take(LOG_CAP + 60);
  for (const old of total.slice(LOG_CAP)) await ctx.db.delete(old._id);
}

/** What a running mod said, batched by the web host. */
export const webLog = mutation({
  args: { id: v.id("mods"), entries: v.array(v.object({ level: v.string(), text: v.string() })) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return;
    // The author's own logs only: a teammate's window running a shared mod
    // would otherwise ship what the mod read on their machine to its author.
    const mod = await ctx.db.get(args.id);
    if (!mod || String(mod.user_id) !== String(userId)) return;
    await appendLogs(ctx, args.id, userId, args.entries);
  },
});


/** What a mod's local half said, from the daemon that runs it. The author's own mods only. */
export const cliLog = mutation({
  args: { api_token: v.string(), name: v.string(), entries: v.array(v.object({ level: v.string(), text: v.string() })) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const userId = auth.userId as Id<"users">;
    const mod = await ctx.db.query("mods").withIndex("by_user_name", (q: any) => q.eq("user_id", userId).eq("name", args.name)).first();
    if (!mod) return { error: `no mod named "${args.name}"` };
    await appendLogs(ctx, mod._id, userId, args.entries);
    return { ok: true };
  },
});
