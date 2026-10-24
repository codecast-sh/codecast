// The two primitives every chat_messages writer shares: the per-channel stamp
// and the patch. A leaf module, so a writer outside chat.ts (session reply
// placeholders, the Slack mirror) uses the same rules without importing chat.ts.

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// EVERY chat patch goes through here. The store keeps the previous row identity
// when no scalar changed, so a patch that only touched an array would never
// reach the UI; bumping `updated_at` unconditionally is what makes array-only
// changes visible. Exported so a test can assert the invariant.
export async function patchChat(
  ctx: MutationCtx,
  id: Id<"chat_messages"> | Id<"chat_channels"> | Id<"chat_reads">,
  patch: Record<string, unknown>,
): Promise<void> {
  await ctx.db.patch(id as any, { ...patch, updated_at: Date.now() } as any);
}

// Strictly monotonic per channel. created_at is load-bearing three ways —
// pagination order, the unread scan's `gt(lastReadAt)`, and the read mark
// itself — and two rows in the same millisecond break all three at once:
// a message landing in the read mark's millisecond is unread yet invisible
// to the badge forever. One indexed read per insert buys the invariant.
export async function nextChatStamp(
  ctx: MutationCtx,
  channelId: Id<"chat_channels">,
): Promise<number> {
  const newestRow = await ctx.db
    .query("chat_messages")
    .withIndex("by_channel_created", (q: any) => q.eq("channel_id", channelId))
    .order("desc")
    .first();
  return Math.max(Date.now(), (newestRow?.created_at ?? 0) + 1);
}
