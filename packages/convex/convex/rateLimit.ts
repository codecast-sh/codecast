import { MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

const WINDOW_MS = 60 * 1000;
const WRITE_LIMIT = 500; // Temporarily increased for bulk import
export const MESSAGE_LIMIT = 3000; // Temporarily increased for bulk import

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

// Every call reads and writes its counter, so one counter per (user, endpoint)
// serializes all of a user's concurrent calls: a daemon creating conversations
// in parallel failed createConversation on OCC against that one row hundreds of
// times an hour. A high limit is split across shards, each call counting
// against one picked at random with its share of the limit, so parallel calls
// mostly touch different rows. A low limit keeps one row and stays exact.
const CALLS_PER_SHARD = 64;
const MAX_SHARDS = 8;

export function rateLimitShards(limit: number): number {
  return Math.max(1, Math.min(MAX_SHARDS, Math.floor(limit / CALLS_PER_SHARD)));
}

// Shard 0 keeps the bare endpoint name, so rows written before sharding stay in use.
export function rateLimitShardKey(endpoint: string, shard: number): string {
  return shard === 0 ? endpoint : `${endpoint}#${shard}`;
}

export async function checkRateLimit(
  ctx: MutationCtx,
  userId: Id<"users">,
  endpoint: string,
  limit: number = WRITE_LIMIT,
  count: number = 1
): Promise<void> {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const shards = rateLimitShards(limit);
  const shard = shards === 1 ? 0 : Math.floor(Math.random() * shards);
  const key = rateLimitShardKey(endpoint, shard);
  const shardLimit = Math.ceil(limit / shards);

  const existing = await ctx.db
    .query("rate_limits")
    .withIndex("by_user_endpoint", (q) =>
      q.eq("user_id", userId).eq("endpoint", key)
    )
    .first();

  if (!existing) {
    await ctx.db.insert("rate_limits", {
      user_id: userId,
      endpoint: key,
      window_start: now,
      request_count: count,
    });
    return;
  }

  if (existing.window_start < windowStart) {
    await ctx.db.patch(existing._id, {
      window_start: now,
      request_count: count,
    });
    return;
  }

  if (existing.request_count + count - 1 >= shardLimit) {
    const secondsRemaining = Math.ceil((existing.window_start + WINDOW_MS - now) / 1000);
    throw new RateLimitError(
      `Rate limit exceeded. Please wait ${secondsRemaining} seconds before retrying.`
    );
  }

  await ctx.db.patch(existing._id, {
    request_count: existing.request_count + count,
  });
}
