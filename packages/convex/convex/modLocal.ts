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
const MAX_KEYS = 100;
/** A call nobody claimed in this long has been given up on by its caller; it never runs late. */
const CALL_EXPIRY_MS = 120_000;

export async function tokenUser(ctx: any, api_token: string): Promise<Id<"users"> | null> {
  const result = await verifyApiToken(ctx, api_token);
  return result ? (result.userId as Id<"users">) : null;
}

export async function ownMod(ctx: any, userId: Id<"users">, name: string) {
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
    const text = JSON.stringify(args.value ?? null);
    if (text.length > MAX_VALUE) return { error: `a published value holds at most ${MAX_VALUE / 1000} KB` };
    const existing = await ctx.db.query("mod_state").withIndex("by_mod_key", (q: any) => q.eq("mod_id", mod._id).eq("key", args.key)).first();
    // An unchanged value is not a write: every tab re-receives the state set on each one.
    if (existing && JSON.stringify(existing.value ?? null) === text && existing.device_name === args.device_name) return { ok: true, unchanged: true };
    const row = { value: args.value ?? null, device_name: args.device_name, updated_at: Date.now() };
    if (existing) await ctx.db.patch(existing._id, row);
    else {
      const count = (await ctx.db.query("mod_state").withIndex("by_mod_key", (q: any) => q.eq("mod_id", mod._id)).take(MAX_KEYS + 1)).length;
      if (count >= MAX_KEYS) return { error: `a mod publishes at most ${MAX_KEYS} keys` };
      await ctx.db.insert("mod_state", { mod_id: mod._id, user_id: userId, key: args.key, ...row });
    }
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
    const now = Date.now();
    for (const c of pending) {
      if (now - c.created_at > CALL_EXPIRY_MS) {
        await ctx.db.patch(c._id, { status: "failed", error: "expired: no machine claimed it within 2 minutes", updated_at: now });
        continue;
      }
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
