import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";

// Mirrors DashboardLayout's `isMobile` threshold (window.innerWidth < 768).
// Below it, the layout stops rendering the desktop conversation side-column
// (`showConversationColumn` is gated `!isMobile`), so opening a session there
// via openSidePanel would set state that only slides in a generic session-list
// drawer -- never the tapped conversation. We route to the full page instead.
const MOBILE_MAX_WIDTH = 768;

/**
 * Open a session that's linked from a detail page (a task's or doc's "Sessions"
 * list). On desktop it peeks the conversation in the side column; on a narrow
 * viewport -- where that column isn't rendered -- it routes to the full
 * conversation so the click isn't a dead end. `/conversation/<id>` is the
 * universal target: for an authenticated owner it redirects into the inbox with
 * the session selected, and for a guest it renders the read-only viewer.
 *
 * Seeds a minimal session stub first so the side panel / inbox has a row to
 * render before the live query resolves -- the linked_conversations snapshot
 * carries enough to show the header immediately.
 */
export function useOpenLinkedSession() {
  const router = useRouter();
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
      });
    }
    const narrow = typeof window !== "undefined" && window.innerWidth < MOBILE_MAX_WIDTH;
    if (narrow) {
      router.push(`/conversation/${sid}`);
    } else {
      store.openSidePanel(sid);
    }
  }, [router]);
}
