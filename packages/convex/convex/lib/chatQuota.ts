// Windowed counters for the agent noise rules (docs/architecture/
// agent-channels.md C2/C3). `takeQuota` counts one more event under `key` in
// the current window and says whether it fit; `takeQuotas` does the same
// for several keys at once, all or none, and `reserveQuotas` holds that
// spend until the caller commits it. It never throws: a caller that
// refuses (an agent over its daily post cap) and a caller that degrades (a
// mention that folds instead of waking) both branch on the answer.
//
// Windows are UTC calendar buckets, not sliding: "30 lines per day" means
// today, which is the number a person can reason about when a bot goes quiet.

import type { MutationCtx } from "../_generated/server";

// Who a machine's line is counted against: a bot by its user id, a session-typed
// line by the session behind it. The session id is the caller's own stamp (an
// honest downgrade, like `origin`): narrowing the count to a session is a
// convenience for a fleet of sessions under one human, not a boundary.
export function agentPosterKey(userId: string, originSessionId?: string): string {
  return originSessionId ? `${userId}:${originSessionId}` : String(userId);
}

export function dayBucket(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function hourBucket(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 13);
}

export function takeQuota(
  ctx: Pick<MutationCtx, "db">,
  key: string,
  bucket: string,
  limit: number,
): Promise<{ ok: boolean }> {
  return takeQuotas(ctx, bucket, [{ key, limit }]);
}

// `reserveQuotas` spent at once, for a caller with no check between the two.
export async function takeQuotas(
  ctx: Pick<MutationCtx, "db">,
  bucket: string,
  quotas: { key: string; limit: number }[],
): Promise<{ ok: boolean }> {
  const commit = await reserveQuotas(ctx, bucket, quotas);
  if (commit) await commit();
  return { ok: !!commit };
}

// One more event under every key, all or none: null when any key is full, and
// nothing is spent. Otherwise the returned commit spends them all, so a caller
// can run another check that may refuse (a rate limit) between the two and
// spend nothing when it does.
export async function reserveQuotas(
  ctx: Pick<MutationCtx, "db">,
  bucket: string,
  quotas: { key: string; limit: number }[],
): Promise<(() => Promise<void>) | null> {
  const rows = await Promise.all(quotas.map(({ key }) =>
    ctx.db
      .query("chat_agent_quota")
      .withIndex("by_key_bucket", (q: any) => q.eq("key", key).eq("bucket", bucket))
      .first(),
  ));
  if (quotas.some(({ limit }, i) => (rows[i]?.count ?? 0) + 1 > limit)) return null;
  return async () => {
    const now = Date.now();
    await Promise.all(quotas.map(({ key }, i) => {
      const row = rows[i];
      return row
        ? ctx.db.patch(row._id, { count: row.count + 1, updated_at: now })
        : ctx.db.insert("chat_agent_quota", { key, bucket, count: 1, updated_at: now });
    }));
  };
}
