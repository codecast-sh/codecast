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

/**
 * The fixed-window counter itself, callable from any mutation with db access.
 * Keys are arbitrary strings — IP-derived for unauthenticated endpoints, or
 * user-id-derived for authenticated abuse guards (e.g. invite emails).
 */
export async function bumpWindow(
  db: any,
  key: string,
  max: number,
  windowMs: number,
): Promise<{ ok: boolean; retry_after_ms?: number }> {
  const { granted, retry_after_ms } = await takeFromWindow(db, key, max, windowMs, 1);
  return granted ? { ok: true } : { ok: false, retry_after_ms };
}

/**
 * Up to `n` units from the key's window in one write: how many it granted
 * (0 to n). For a mutation that spends many units of one budget at once (the
 * new groups a batch opens), where bumping one at a time would rewrite the
 * counter row once per unit.
 */
export async function takeFromWindow(
  db: any,
  key: string,
  max: number,
  windowMs: number,
  n: number,
): Promise<{ granted: number; retry_after_ms?: number }> {
  if (n <= 0) return { granted: 0 };
  const now = Date.now();
  const existing = await db
    .query("ip_rate_limits")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .first();

  // New key, or the previous window fully elapsed → start a fresh window.
  if (!existing || now - existing.window_start >= windowMs) {
    const granted = Math.min(n, max);
    if (existing) {
      await db.patch(existing._id, { count: granted, window_start: now });
    } else {
      await db.insert("ip_rate_limits", { key, count: granted, window_start: now });
    }
    return granted < n ? { granted, retry_after_ms: windowMs } : { granted };
  }

  const granted = Math.max(0, Math.min(n, max - existing.count));
  if (granted) await db.patch(existing._id, { count: existing.count + granted });
  return granted < n ? { granted, retry_after_ms: windowMs - (now - existing.window_start) } : { granted };
}

/**
 * Whether the key's window is spent, without spending from it: the wait until
 * it has room, or null while it does. For a read that must refuse a caller
 * before doing the work the window counts (a query cannot write the counter).
 */
export async function windowSpent(db: any, key: string, max: number, windowMs: number): Promise<number | null> {
  const now = Date.now();
  const existing = await db
    .query("ip_rate_limits")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .first();
  if (!existing || now - existing.window_start >= windowMs || existing.count < max) return null;
  return windowMs - (now - existing.window_start);
}

export const bump = internalMutation({
  args: { key: v.string(), max: v.number(), window_ms: v.number() },
  handler: async (ctx, args): Promise<{ ok: boolean; retry_after_ms?: number }> =>
    bumpWindow(ctx.db, args.key, args.max, args.window_ms),
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
