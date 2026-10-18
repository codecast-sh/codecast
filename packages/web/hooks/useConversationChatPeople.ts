import { useSyncExternalStore } from "react";
import { useTrackedStore } from "../store/inboxStore";
import type { ChatMember } from "../lib/chatViews";
import { viewersOf, viewersSig } from "../components/presence/memberPresence";
import type { PresenceRow } from "./useDocPresence";

// The people an open dock is talking to, by conversation, so the room stays
// on screen when someone steps away mid conversation.
const held = new Map<string, string[]>();
const listeners = new Set<() => void>();
export function holdConversationChatPeople(conversationId: string, ids: string[] | null) {
  if (ids) held.set(conversationId, ids);
  else held.delete(conversationId);
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * Who the dock talks to: teammates viewing this conversation (the roster's
 * viewing field) plus teammates in its composer, or, while the dock is open
 * and they have all gone, the people it was open with. Share link guests are
 * not on the roster and have no chat.
 */
export function useConversationChatPeople(conversationId: string, present: readonly PresenceRow[]): ChatMember[] {
  const st = useTrackedStore([
    (s) => viewersSig(s.teamMembers, conversationId, s.currentUser?._id?.toString?.() ?? null),
    (s) => s.teamMembers,
  ]);
  const me = st.currentUser?._id ? String(st.currentUser._id) : null;
  const keep = useSyncExternalStore(subscribe, () => held.get(conversationId), () => undefined);
  const roster: any[] = st.teamMembers ?? [];
  const byId = new Map(roster.map((m) => [String(m._id), m]));
  const ids = new Set(viewersOf(roster, conversationId, me).map((m) => String(m._id)));
  for (const row of present) if (row.user_id !== me && byId.has(row.user_id)) ids.add(row.user_id);
  const live = [...ids].sort();
  const chosen = live.length ? live : keep ?? [];
  return chosen.map((id) => byId.get(id)).filter((m) => m && !m.is_bot) as ChatMember[];
}
