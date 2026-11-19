// Thread pages fetched before anyone opens them, so a tap on "3 replies"
// lands on a thread that is already in the store. The channel page carries
// each root's reply rollup (chatThreadSummaries) but not the replies, which
// only chat.getThread returns. A root is wanted while the store holds fewer
// replies than its rollup counts, or none as new as its last reply.
//
// Mobile's Metro reaches this file, so imports stay relative.

import type { ChatMessageRow, ChatThreadSummaryRow } from "../store/chatSlice";

/** Roots among `rootIds` whose replies the store does not fully hold, in the
 *  order given (callers pass the newest first). */
export function threadsMissingReplies(
  rootIds: string[],
  summaries: Record<string, ChatThreadSummaryRow | undefined>,
  messages: Record<string, ChatMessageRow>,
): string[] {
  const wanted = new Set(rootIds.filter((id) => (summaries[id]?.reply_count ?? 0) > 0));
  if (wanted.size === 0) return [];
  const held = new Map<string, { count: number; newest: number }>();
  for (const id in messages) {
    const row = messages[id];
    const root = row.thread_root_id ? String(row.thread_root_id) : undefined;
    if (!root || !wanted.has(root)) continue;
    const h = held.get(root) ?? { count: 0, newest: 0 };
    h.count += 1;
    h.newest = Math.max(h.newest, row.created_at);
    held.set(root, h);
  }
  return [...wanted].filter((id) => {
    const s = summaries[id]!;
    const h = held.get(id);
    return !h || h.count < s.reply_count || h.newest < s.last_reply_at;
  });
}
