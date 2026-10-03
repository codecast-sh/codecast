import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";

// A leaf (no sonner, no DOM) so the phone's session screen reads the same
// fields from the same row as the web composer.

/** The session row's composer-facing fields. The row's identity churns every
 *  ~1s heartbeat (updated_at / last_heartbeat / is_idle overlay), so the
 *  selector returns only these six and re-renders only when one changes. */
export function useManagedSessionFields(conversationId: string | null | undefined) {
  return useInboxStore(useShallow((s) => {
    const sess = conversationId ? s.sessions[conversationId] : null;
    if (!sess) return null;
    return {
      agent_status: sess.agent_status,
      permission_mode: sess.permission_mode,
      session_id: sess.session_id,
      is_connected: sess.is_connected,
      tmux_session: sess.tmux_session,
      team_id: sess.team_id,
    };
  }));
}
