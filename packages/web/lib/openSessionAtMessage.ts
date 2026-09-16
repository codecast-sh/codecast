import { useInboxStore } from "../store/inboxStore";

// Open a conversation at a specific message. The inbox consumes
// pendingScrollToMessageId (QueuePageClient) and pages the window in.
// Callers on a thread (inbox / /conversation/) preventDefault and use this;
// callers on any other page leave the /conversation/<id>#msg-<id> href alone
// so RedirectToInbox reads the hash.
export function openSessionAtMessage(
  conversationId: string,
  messageId?: string | null,
  timestamp?: number | null,
) {
  useInboxStore.getState().requestNavigate(conversationId, {
    scrollToMessageId: messageId ?? null,
    scrollToMessageTimestamp: timestamp ?? null,
  });
}

export function isOnThreadRoute(pathname?: string | null): boolean {
  const raw = pathname ?? (typeof window !== "undefined" ? window.location.pathname : "");
  const path = raw.split("?")[0].split("#")[0];
  return path === "/inbox" || path.startsWith("/inbox/") || path.startsWith("/conversation/");
}
