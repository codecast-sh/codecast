import { useShallow } from "zustand/react/shallow";
import { agentStatusAt } from "../lib/liveness";
import { useInboxStore, type InboxSession } from "../store/inboxStore";
import { useNowWhen } from "./useCoarseNow";

// A leaf (no sonner, no DOM) so the phone's session screen reads the same
// fields from the same row as the web composer.

/** The session row's composer-facing fields. The row's identity churns every
 *  ~1s heartbeat (updated_at / last_heartbeat / is_idle overlay), so the
 *  selector returns only these six and re-renders only when one changes.
 *  agent_status is the verdict at the clock (the row holds the daemon's raw
 *  status), and the clock wakes the hook only when that verdict moves. */
export function useManagedSessionFields(conversationId: string | null | undefined) {
  const now = useNowWhen((t) => {
    const sess = conversationId ? useInboxStore.getState().sessions[conversationId] : null;
    return sess ? agentStatusAt(sess, t) ?? "" : "";
  }, 15_000);
  return useInboxStore(useShallow((s) => {
    const sess = conversationId ? s.sessions[conversationId] : null;
    if (!sess) return null;
    return {
      agent_status: agentStatusAt(sess, now) as InboxSession["agent_status"],
      permission_mode: sess.permission_mode,
      session_id: sess.session_id,
      is_connected: sess.is_connected,
      tmux_session: sess.tmux_session,
      team_id: sess.team_id,
    };
  }));
}
