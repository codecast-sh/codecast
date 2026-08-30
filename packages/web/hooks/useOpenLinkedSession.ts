import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLocation } from "react-router";
import { useInboxStore, sessionRowFromSummary } from "../store/inboxStore";
import { isInboxSessionView, resolveSessionSelectKind, type SessionSelectKind } from "../lib/inboxRouting";
import { divertSessionOpen } from "../lib/openIntent";
import { openBeside, sessionPanePath } from "../lib/stage";

// Mirrors DashboardLayout's `isMobile` threshold (window.innerWidth < 768).
// Below it the desktop stage/rail layout is gone; route to the full page.
const MOBILE_MAX_WIDTH = 768;

/**
 * What a click on a linked session should do, given which surface is mounted.
 * A click always takes the conversation to the STAGE — side by side is a
 * deliberate gesture (a drag onto the stage, or openConversationBeside), never
 * a click's side effect.
 *  - "select": make it the current inbox conversation (instant, same path fork
 *    chips and parent links use)
 *  - "route": go to /conversation/<id> -- the universal target: an authenticated
 *    owner is redirected into the inbox with the session selected, a guest gets
 *    the read-only viewer
 */
export function resolveLinkedSessionOpen(kind: SessionSelectKind, narrow: boolean): "select" | "route" {
  if (narrow) return "route";
  if (kind === "inboxInPlace") return "select";
  return "route";
}

/**
 * Open a conversation BESIDE what's on stage, as a split pane — the
 * programmatic form of dragging a session onto the stage. Falls back to the
 * stage itself when a pane can't open (narrow window, pane cap).
 */
export function openConversationBeside(id: string) {
  // A Cmd-click opens the session in a background tab / detached window
  // instead of beside the page — and must not reshape the stage.
  if (divertSessionOpen(id)) return;
  if (openBeside(sessionPanePath(id))) return;
  useInboxStore.getState().navigateToSession(id);
}

/**
 * Open a session that's linked from another surface -- a task's or doc's
 * "Sessions" list, or a workflow run's agent rows (DynamicRunView, which also
 * renders inline in conversations). Resolves the right open gesture for the
 * mounted surface via resolveSessionSelectKind, the same decision the global
 * session list uses.
 *
 * Seeds a minimal session stub first so the target surface has a row to render
 * before the live query resolves -- the linked_conversations snapshot carries
 * enough to show the header immediately.
 */
export function useOpenLinkedSession() {
  const router = useRouter();
  const pathname = usePathname();
  // Real browser URL: `pathname` is tab-aware and reports the carried tab route
  // on Settings, so the settings check must come from the router (see
  // resolveSessionSelectKind's doc).
  const routerLocation = useLocation();
  return useCallback((conv: any) => {
    const sid = conv._id;
    const store = useInboxStore.getState();
    if (!store.sessions[sid]) {
      // sessionRowFromSummary carries the triage stamps through (a stampless
      // stub renders a stashed/dismissed session as an active needs-input card
      // at boot, ct-42666) and keeps parent_conversation_id so a workflow-agent
      // stub classifies as a subagent instead of surfacing top-level.
      store.syncRecord("sessions", sid, sessionRowFromSummary({
        ...conv,
        is_idle: !conv.is_active,
      }));
    }
    const narrow = typeof window !== "undefined" && window.innerWidth < MOBILE_MAX_WIDTH;
    const kind = resolveSessionSelectKind({
      isOnSettingsPage: routerLocation.pathname.startsWith("/settings"),
      isOnInboxPage: isInboxSessionView(pathname, store.currentConversation?.source),
      isOnConversationPage: pathname?.includes("/conversation/") ?? false,
    });
    const open = resolveLinkedSessionOpen(kind, narrow);
    if (open === "route") {
      router.push(`/conversation/${sid}`);
    } else {
      store.navigateToSession(sid);
    }
  }, [router, pathname, routerLocation.pathname]);
}
