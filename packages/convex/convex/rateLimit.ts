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

export async function checkRateLimit(
  ctx: MutationCtx,
  userId: Id<"users">,
  endpoint: string,
  limit: number = WRITE_LIMIT,
  count: number = 1
): Promise<void> {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const existing = await ctx.db
    .query("rate_limits")
    .withIndex("by_user_endpoint", (q) =>
      q.eq("user_id", userId).eq("endpoint", endpoint)
    )
    .first();

  if (!existing) {
    await ctx.db.insert("rate_limits", {
      user_id: userId,
      endpoint,
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

  if (existing.request_count + count - 1 >= limit) {
    const secondsRemaining = Math.ceil((existing.window_start + WINDOW_MS - now) / 1000);
    throw new RateLimitError(
      `Rate limit exceeded. Please wait ${secondsRemaining} seconds before retrying.`
    );
  }

  await ctx.db.patch(existing._id, {
    request_count: existing.request_count + count,
  });
}
