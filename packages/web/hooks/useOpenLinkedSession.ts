import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLocation } from "react-router";
import { useInboxStore } from "../store/inboxStore";
import { isInboxSessionView, resolveSessionSelectKind, type SessionSelectKind } from "../lib/inboxRouting";

// Mirrors DashboardLayout's `isMobile` threshold (window.innerWidth < 768).
// Below it, the layout stops rendering the desktop conversation side-column
// (`showConversationColumn` is gated `!isMobile`), so opening a session there
// via openSidePanel would set state that only slides in a generic session-list
// drawer -- never the tapped conversation. We route to the full page instead.
const MOBILE_MAX_WIDTH = 768;

/**
 * What a click on a linked session should do, given which surface is mounted.
 * The side-column peek only renders outside the inbox and conversation pages
 * (DashboardLayout's showConversationColumn), so on those surfaces openSidePanel
 * is a dead end -- it just slides out the generic session-list rail.
 *  - "peek": open in the side column beside a working page (tasks, docs, workflows)
 *  - "select": make it the current inbox conversation (instant, same path fork
 *    chips and parent links use)
 *  - "route": go to /conversation/<id> -- the universal target: an authenticated
 *    owner is redirected into the inbox with the session selected, a guest gets
 *    the read-only viewer
 */
export function resolveLinkedSessionOpen(kind: SessionSelectKind, narrow: boolean): "peek" | "select" | "route" {
  if (narrow) return "route";
  if (kind === "peekPanel") return "peek";
  if (kind === "inboxInPlace") return "select";
  return "route";
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
      store.syncRecord("sessions", sid, {
        _id: conv._id,
        session_id: conv.session_id || conv._id,
        title: conv.title,
        project_path: conv.project_path,
        message_count: conv.message_count || 0,
        updated_at: conv.updated_at,
        started_at: conv.started_at,
        agent_type: conv.agent_type || "claude",
        is_idle: !conv.is_active,
        has_pending: false,
        // Carried by workflow-agent sessions; keeps the seeded stub classified as a
        // subagent by inbox filters instead of surfacing as a top-level row.
        parent_conversation_id: conv.parent_conversation_id,
      });
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
    } else if (open === "select") {
      store.navigateToSession(sid);
    } else {
      store.openSidePanel(sid);
    }
  }, [router, pathname, routerLocation.pathname]);
}
