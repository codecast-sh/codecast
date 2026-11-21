// Windowed counters for the agent noise rules (docs/architecture/
// agent-channels.md C2/C3). `takeQuota` counts one more event under `key` in
// the current window and says whether it fit; `takeQuotas` does the same
// for several keys at once, all or none, and `reserveQuotas` holds that
// spend until the caller commits it. It never throws: a caller that
// refuses (an agent over its daily post cap) and a caller that degrades (a
// mention that folds instead of waking) both branch on the answer.
//
// Windows are buckets, not sliding: in a room "30 lines per day" means the UTC
// day, which is the number a person can reason about when a bot goes quiet; in
// a DM the bucket is the person's latest line there, so their reply resets it.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// The agent noise rules (docs/architecture/agent-channels.md C2/C3), counted
// in chat_agent_quota. A role or session posts at most this many lines per
// room per UTC day (in a DM, since a person last wrote there), starts at most
// this many thread roots in the same window, and a mention
// wakes at most this often per sender and per target per hour — over the cap
// the send is refused (posts) or the mention folds (wakes).
export const AGENT_POSTS_PER_CHANNEL_DAY = 30;
export const AGENT_ROOTS_PER_CHANNEL_DAY = 5;
export const MENTION_WAKES_PER_SENDER_HOUR = 10;
export const MENTION_WAKES_PER_TARGET_HOUR = 30;

// The hourly wake caps (C2): one more wake from `senderKey` and one more into
// `targetKey`, both or neither; over either the wake folds. Checked per target
// so one folded target does not fold the rest, and spent only after each check
// that can skip the target: a wake that cannot happen must not spend hourly
// credit. The mention rail (sender: the person) and the mention-reply relay
// (sender: the replying session) both count against these keys, so an agent
// answering an agent costs what a fresh mention costs.
export function mentionWakeQuotas(senderKey: string, targetKey: string): { key: string; limit: number }[] {
  return [
    { key: `mention_from:${senderKey}`, limit: MENTION_WAKES_PER_SENDER_HOUR },
    { key: `mention_to:${targetKey}`, limit: MENTION_WAKES_PER_TARGET_HOUR },
  ];
}

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

// One more agent line in this channel, or why not (C3): the refusal message,
// or null when it fit. A room counts per UTC day. A DM counts since a person
// last wrote there: a person's line opens a fresh count, so a conversation
// they drive is never refused, while narration nobody answers stops at the
// same 30 lines and 5 roots.
export async function takeAgentPostQuota(
  ctx: Pick<MutationCtx, "db">,
  channel: Doc<"chat_channels">,
  posterKey: string,
  isRoot: boolean,
): Promise<string | null> {
  const dm = channel.kind === "dm";
  const bucket = dm ? await dmQuotaBucket(ctx, channel._id) : dayBucket();
  const where = dm ? "this conversation" : `#${channel.name}`;
  const perDay = !bucket.startsWith("since:");
  if (isRoot && !(await takeQuota(ctx, `root:${channel._id}:${posterKey}`, bucket, AGENT_ROOTS_PER_CHANNEL_DAY)).ok) {
    return `An agent may start at most ${AGENT_ROOTS_PER_CHANNEL_DAY} threads ${perDay ? "per day " : ""}in ${where}${perDay ? "" : " until a person writes in it"}; reply in an existing thread instead (--thread <root>)`;
  }
  if (!(await takeQuota(ctx, `post:${channel._id}:${posterKey}`, bucket, AGENT_POSTS_PER_CHANNEL_DAY)).ok) {
    return perDay
      ? `An agent may post at most ${AGENT_POSTS_PER_CHANNEL_DAY} lines per day in ${where}; the cap resets at midnight UTC`
      : `An agent may post at most ${AGENT_POSTS_PER_CHANNEL_DAY} lines in ${where} until a person writes in it`;
  }
  return null;
}

// The DM's count window: the newest line a person wrote ("since:<created_at>",
// "since:0" before anyone has). A person's line is one no agent wrote: not
// origin "agent", not an anchor's, not a bot user's. Agent lines since it are
// bounded by the cap itself, so the walk is short; past DM_QUOTA_SCAN agent
// lines with no person among them it falls back to the room rule, per UTC day.
const DM_QUOTA_SCAN = 300;

async function dmQuotaBucket(ctx: Pick<MutationCtx, "db">, channelId: Id<"chat_channels">): Promise<string> {
  const bots = new Map<string, boolean>();
  let scanned = 0;
  for await (const row of ctx.db
    .query("chat_messages")
    .withIndex("by_channel_created", (q: any) => q.eq("channel_id", channelId))
    .order("desc")) {
    if (++scanned > DM_QUOTA_SCAN) return `day:${dayBucket()}`;
    if (row.origin === "agent" || row.author_kind === "agent") continue;
    const key = row.user_id.toString();
    if (!bots.has(key)) bots.set(key, !!(await ctx.db.get(row.user_id))?.is_bot);
    if (!bots.get(key)) return `since:${row.created_at}`;
  }
  return "since:0";
}
