import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";

// Local-first per-message bookmark state. The on/off comes from the store's
// bookmark list (synced globally in useSyncInboxSessions), so the icon reflects
// an optimistic toggle instantly; the write goes through the store action, which
// dispatches the durable server toggle and protects the optimism from being
// clobbered by an unrelated sync. No per-message server query, no click latency.
export function useMessageBookmark(
  conversationId: string | undefined,
  messageId: string | undefined,
) {
  const isBookmarked = useInboxStore(
    (s) => !!messageId && (s.bookmarks as any[]).some((b) => b.message_id === messageId),
  );
  const toggle = useInboxStore((s) => s.toggleBookmark);
  const toggleBookmark = useCallback(() => {
    if (!conversationId || !messageId) return;
    toggle(conversationId, messageId);
  }, [toggle, conversationId, messageId]);
  return { isBookmarked, toggleBookmark };
}
