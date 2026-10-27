import type { ChatMessageRow, ChatRailChannel } from "./chatSlice";

const DAY_MS = 86_400_000;

/**
 * How much a room is worth offering first: how recently anyone spoke in it,
 * plus how much was said there lately. Recency is the rail's sortAt, so a room
 * whose history is not loaded still ranks by its newest line; volume counts the
 * loaded lines of the last 30 days, each worth less as it ages, so a room
 * talked in every day beats one that got a single line this morning.
 */
export function chatFrecency(
  rows: Pick<ChatRailChannel, "id" | "sortAt">[],
  messages: Record<string, ChatMessageRow>,
  now = Date.now(),
): Map<string, number> {
  const volume = new Map<string, number>();
  for (const id in messages) {
    const m = messages[id];
    const age = (now - m.created_at) / DAY_MS;
    if (m.deleted_at || age > 30) continue;
    volume.set(m.channel_id, (volume.get(m.channel_id) ?? 0) + 1 / (1 + age / 7));
  }
  const out = new Map<string, number>();
  for (const r of rows) {
    const recency = 10 / (1 + Math.max(0, now - r.sortAt) / (3 * DAY_MS));
    out.set(r.id, recency + Math.min(volume.get(r.id) ?? 0, 40));
  }
  return out;
}
