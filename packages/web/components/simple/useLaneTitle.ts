// The lane's window title. index.html ships the marketing title, and outside
// DashboardLayout nothing replaces it, so every lane page writes its own:
// "Codecast Approvals", or "Codecast Home | Reply to Dana about Thursday" in a
// conversation. Same format as the full app (appDocumentTitle), since the
// browser tab, history and the window switcher all list windows by it.
import { useLocation } from "react-router";
import { appDocumentTitle } from "../../lib/browserPane";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { conversationTitle, laneSurfaceLabel } from "./lane";

/** A conversation's plain title from the store, or null with no id. */
export function useLaneConversationTitle(id: string | null): string | null {
  return useInboxStore((s) => {
    if (!id) return null;
    const live = s.resolveLiveSessionId(id);
    return conversationTitle(s.sessions[live] ?? (s.conversations[live] as any));
  });
}

/** Write the window title for the lane page at the current path, naming
 *  `thing` (a conversation's title) after the section when there is one. */
export function useLaneDocumentTitle(thing: string | null = null): void {
  const { pathname } = useLocation();
  const title = appDocumentTitle(laneSurfaceLabel(pathname), thing);
  useWatchEffect(() => {
    if (document.title !== title) document.title = title;
  }, [title]);
}
