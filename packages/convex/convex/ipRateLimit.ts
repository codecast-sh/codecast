import { internalMutation } from "./functions";
import { v } from "convex/values";

// IP-keyed fixed-window rate limiter for UNAUTHENTICATED endpoints. The existing
// per-user limiter (rateLimit.ts / checkRateLimit) can't cover the auth relay or
// webhooks because those have no authenticated user. Convex ships no rate limiting
// and every HTTP route is internet-reachable, so without this the only bound on
// brute-forcing a one-shot setup token is the token's own entropy + TTL.
//
// Keyed per (endpoint, client-ip) so counters distribute across keys — no single
// hot doc. FAIL-OPEN on the limiter's own internal error (an availability glitch
// must never lock the whole fleet out of auth); it only DENIES when a key exceeds
// `max` within `window_ms`. Rows pruned hourly (pruneIpRateLimits, see crons.ts).
//
// Scope note: applied to /cli/exchange-token (one-shot — safe to limit). Deliberately
// NOT applied to /cli/claim-auth (the CLI POLLS it during login; a per-IP limit
// would break legitimate sign-in behind shared NAT) or to public share-link queries
// (a query can't write a counter). Extending to those needs per-endpoint tuning or
// @convex-dev/rate-limiter's token-bucket sharding — a deliberate follow-up.

export const bump = internalMutation({
  args: { key: v.string(), max: v.number(), window_ms: v.number() },
  handler: async (ctx, args): Promise<{ ok: boolean; retry_after_ms?: number }> => {
    const now = Date.now();
    const existing = await ctx.db
      .query("ip_rate_limits")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    // New key, or the previous window fully elapsed → start a fresh window.
    if (!existing || now - existing.window_start >= args.window_ms) {
      if (existing) {
        await ctx.db.patch(existing._id, { count: 1, window_start: now });
      } else {
        await ctx.db.insert("ip_rate_limits", { key: args.key, count: 1, window_start: now });
      }
      return { ok: true };
    }

    if (existing.count >= args.max) {
      return { ok: false, retry_after_ms: args.window_ms - (now - existing.window_start) };
    }
    await ctx.db.patch(existing._id, { count: existing.count + 1 });
    return { ok: true };
  },
});

// Drop windows older than 1h (covers any window we use). Bounded single scan —
// the table holds one row per recently-active key.
export const pruneIpRateLimits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const rows = await ctx.db.query("ip_rate_limits").take(5000);
    let deleted = 0;
    for (const r of rows) {
      if (r.window_start < cutoff) {
        await ctx.db.delete(r._id);
        deleted++;
      }
    }
    return { deleted, scanned: rows.length };
  },
});
