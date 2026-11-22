// The sessions the inbox's old-sessions prompt counts and its "Dismiss all N"
// dismisses (components/inbox/StaleSessionsPrompt).
import { isSessionHidden, type InboxSession } from "../store/inboxStore";

/** The sessions the prompt counts and "Dismiss all N" dismisses: idle since
 *  `cutoff`, not hidden, pinned or snoozed, and never the one on screen.
 *  Newest first, so the borderline ones lead the review list. */
export function staleSessionsOf(sessions: InboxSession[], activeSessionId: string | null | undefined, cutoff: number): InboxSession[] {
  return sessions
    .filter(
      (sess) =>
        !isSessionHidden(sess) &&
        !sess.is_pinned &&
        !sess.inbox_snoozed_until &&
        sess._id !== activeSessionId &&
        // An unstamped row is unknown, not ancient: never offer it for dismissal.
        !!sess.updated_at && sess.updated_at < cutoff,
    )
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}
