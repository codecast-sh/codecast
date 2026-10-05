import { v } from "convex/values";
import { mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import { ownMod, tokenUser } from "./modLocal";

/**
 * Calls from a mod's UI into its local half ($.local.call), as a queue: the
 * web enqueues one and watches it; the daemon running that half claims it and
 * writes the answer (modLocal.cliClaimCalls / cliFinishCall). Its own module:
 * a call is not a row of any collection the store syncs.
 */

const CALLS_KEPT = 100;

/** Queue a call into a mod's local half. The author's own mods only: the call runs on their machine. */
export async function enqueueCall(ctx: any, userId: Id<"users">, mod: any, method: string, callArgs: unknown) {
  if (!mod || String(mod.user_id) !== String(userId)) throw new Error("a local call reaches only your own mods");
  if (!mod.local_code) throw new Error(`${mod.name} has no local half`);
  const now = Date.now();
  const id = await ctx.db.insert("mod_calls", { mod_id: mod._id, user_id: userId, method: method.slice(0, 80), args: callArgs ?? null, status: "pending", created_at: now, updated_at: now });
  const old = await ctx.db.query("mod_calls").withIndex("by_mod_created", (q: any) => q.eq("mod_id", mod._id)).order("desc").take(CALLS_KEPT + 20);
  for (const c of old.slice(CALLS_KEPT)) await ctx.db.delete(c._id);
  return id;
}

export async function readCall(ctx: any, userId: Id<"users">, id: Id<"mod_calls">) {
  const call = await ctx.db.get(id);
  if (!call || String(call.user_id) !== String(userId)) return null;
  return { status: call.status, result: call.result, error: call.error, device_name: call.device_name };
}

export const webCall = mutation({
  args: { mod_id: v.id("mods"), method: v.string(), args: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");
    return await enqueueCall(ctx, userId, await ctx.db.get(args.mod_id), args.method, args.args);
  },
});

export const webGetCall = query({
  args: { id: v.id("mod_calls") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    return userId ? await readCall(ctx, userId, args.id) : null;
  },
});

/** `cast mod call`: the same call from a terminal, to try a local half without its UI. */
export const cliCall = mutation({
  args: { api_token: v.string(), name: v.string(), method: v.string(), args: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const mod = await ownMod(ctx, userId, args.name);
    if (!mod) return { error: `no mod named "${args.name}"` };
    try {
      return { id: await enqueueCall(ctx, userId, mod, args.method, args.args) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const cliGetCall = query({
  args: { api_token: v.string(), id: v.id("mod_calls") },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    return (await readCall(ctx, userId, args.id)) ?? { error: "no such call" };
  },
});
