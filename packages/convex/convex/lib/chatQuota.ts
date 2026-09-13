// Windowed counters for the agent noise rules (docs/architecture/
// agent-channels.md C2/C3). `takeQuota` counts one more event under `key` in
// the current window and says whether it fit. It never throws: a caller that
// refuses (an agent over its daily post cap) and a caller that degrades (a
// mention that folds instead of waking) both branch on the answer.
//
// Windows are UTC calendar buckets, not sliding: "30 lines per day" means
// today, which is the number a person can reason about when a bot goes quiet.

import type { MutationCtx } from "../_generated/server";

export function dayBucket(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function hourBucket(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 13);
}

export async function takeQuota(
  ctx: Pick<MutationCtx, "db">,
  key: string,
  bucket: string,
  limit: number,
): Promise<{ ok: boolean; count: number }> {
  const now = Date.now();
  const row = await ctx.db
    .query("chat_agent_quota")
    .withIndex("by_key_bucket", (q: any) => q.eq("key", key).eq("bucket", bucket))
    .first();
  const count = (row?.count ?? 0) + 1;
  if (count > limit) return { ok: false, count: row?.count ?? 0 };
  if (row) await ctx.db.patch(row._id, { count, updated_at: now });
  else await ctx.db.insert("chat_agent_quota", { key, bucket, count, updated_at: now });
  return { ok: true, count };
}
