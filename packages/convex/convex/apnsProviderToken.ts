import { v } from "convex/values";
import { internalMutation, internalQuery } from "./functions";
import type { QueryCtx } from "./_generated/server";

export const APNS_TOKEN_REFRESH_MS = 50 * 60 * 1000;

async function tokenRow(ctx: Pick<QueryCtx, "db">, key: string) {
  return ctx.db.query("system_config").withIndex("by_key", (q) => q.eq("key", key)).unique();
}

function fresh(row: { updated_at: number } | null, now: number): boolean {
  return !!row && row.updated_at <= now && now - row.updated_at < APNS_TOKEN_REFRESH_MS;
}

const identity = { key_id: v.string(), team_id: v.string() };
const cacheKey = (args: { key_id: string; team_id: string }) =>
  `apns_provider_jwt:${args.team_id}:${args.key_id}`;

export const get = internalQuery({
  args: identity,
  handler: async (ctx, args): Promise<string | null> => {
    const row = await tokenRow(ctx, cacheKey(args));
    return fresh(row, Date.now()) ? row!.value : null;
  },
});

export const retain = internalMutation({
  args: { ...identity, token: v.string(), issued_at: v.number() },
  handler: async (ctx, args): Promise<string> => {
    const key = cacheKey(args);
    const row = await tokenRow(ctx, key);
    const now = Date.now();
    if (fresh(row, now)) return row!.value;
    if (!fresh({ updated_at: args.issued_at }, now)) throw new Error("APNs provider token is stale");
    const value = { value: args.token, updated_at: args.issued_at };
    if (row) await ctx.db.patch(row._id, value);
    else await ctx.db.insert("system_config", { key, ...value });
    return args.token;
  },
});
