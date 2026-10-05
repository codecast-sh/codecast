import { v } from "convex/values";
import { mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import type { Id } from "./_generated/dataModel";

/**
 * The local tier of codecast mods (plan pl-839): the half of a mod that the
 * daemon runs on a machine the author owns. This module is the bridge between
 * that half and the app. A daemon fetches the local code of its user's
 * enabled mods (it runs only versions approved on that device), publishes
 * values the sandboxed half reads ($.publish / $.local.get), and claims and
 * answers the calls the sandboxed half makes ($.local.call).
 */

const MAX_VALUE = 200_000;
const CALLS_KEPT = 100;

async function tokenUser(ctx: any, api_token: string): Promise<Id<"users"> | null> {
  const result = await verifyApiToken(ctx, api_token);
  return result ? (result.userId as Id<"users">) : null;
}

async function ownMod(ctx: any, userId: Id<"users">, name: string) {
  return await ctx.db.query("mods").withIndex("by_user_name", (q: any) => q.eq("user_id", userId).eq("name", name)).first();
}

/** The daemon's view: every enabled mod of this user with a local half. */
export const cliLocalMods = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const rows = await ctx.db.query("mods").withIndex("by_user_name", (q: any) => q.eq("user_id", userId)).collect();
    return {
      mods: rows
        .filter((r: any) => r.local_code)
        .map((r: any) => ({ id: r._id, name: r.name, title: r.title, rev: r.rev, enabled: r.enabled, local_hash: r.local_hash, local_code: r.local_code, manifest: r.manifest })),
    };
  },
});

/** One value from a local half, latest write wins. */
export const cliPublish = mutation({
  args: { api_token: v.string(), name: v.string(), key: v.string(), value: v.any(), device_name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const mod = await ownMod(ctx, userId, args.name);
    if (!mod) return { error: `no mod named "${args.name}"` };
    if (JSON.stringify(args.value ?? null).length > MAX_VALUE) return { error: `a published value holds at most ${MAX_VALUE / 1000} KB` };
    const existing = await ctx.db.query("mod_state").withIndex("by_mod_key", (q: any) => q.eq("mod_id", mod._id).eq("key", args.key)).first();
    const row = { value: args.value ?? null, device_name: args.device_name, updated_at: Date.now() };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("mod_state", { mod_id: mod._id, user_id: userId, key: args.key, ...row });
    return { ok: true };
  },
});

/** Hand the pending UI calls for these mods to the daemon that runs them. */
export const cliClaimCalls = mutation({
  args: { api_token: v.string(), names: v.array(v.string()), device_name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const pending = await ctx.db.query("mod_calls").withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "pending")).take(50);
    if (!pending.length) return { calls: [] };
    const names = new Map<string, string>();
    for (const name of args.names) {
      const mod = await ownMod(ctx, userId, name);
      if (mod) names.set(String(mod._id), name);
    }
    const calls = [];
    for (const c of pending) {
      const name = names.get(String(c.mod_id));
      if (!name) continue;
      await ctx.db.patch(c._id, { status: "running", device_name: args.device_name, updated_at: Date.now() });
      calls.push({ id: c._id, name, method: c.method, args: c.args });
    }
    return { calls };
  },
});

export const cliFinishCall = mutation({
  args: { api_token: v.string(), id: v.id("mod_calls"), result: v.optional(v.any()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await tokenUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const call = await ctx.db.get(args.id);
    if (!call || String(call.user_id) !== String(userId)) return { error: "no such call" };
    const tooBig = args.result !== undefined && JSON.stringify(args.result).length > MAX_VALUE;
    await ctx.db.patch(args.id, {
      status: args.error || tooBig ? "failed" : "done",
      result: tooBig ? undefined : args.result,
      error: tooBig ? `the result is over ${MAX_VALUE / 1000} KB` : args.error?.slice(0, 4000),
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

/** Everything this viewer's local halves published. Feeds the store's modState collection. */
export const webState = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db.query("mod_state").withIndex("by_user", (q: any) => q.eq("user_id", userId)).collect();
  },
});

/** Queue a call into a mod's local half. The author's own mods only: the call runs on their machine. */
async function enqueueCall(ctx: any, userId: Id<"users">, mod: any, method: string, callArgs: unknown) {
  if (!mod || String(mod.user_id) !== String(userId)) throw new Error("a local call reaches only your own mods");
  if (!mod.local_code) throw new Error(`${mod.name} has no local half`);
  const now = Date.now();
  const id = await ctx.db.insert("mod_calls", { mod_id: mod._id, user_id: userId, method: method.slice(0, 80), args: callArgs ?? null, status: "pending", created_at: now, updated_at: now });
  const old = await ctx.db.query("mod_calls").withIndex("by_mod_created", (q: any) => q.eq("mod_id", mod._id)).order("desc").take(CALLS_KEPT + 20);
  for (const c of old.slice(CALLS_KEPT)) await ctx.db.delete(c._id);
  return id;
}

async function readCall(ctx: any, userId: Id<"users">, id: Id<"mod_calls">) {
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
