import { useMemo } from "react";
import { useInboxStore, type InboxSession } from "../store/inboxStore";
import { isWatchHostDead, liveWatchRowsFor } from "../components/monitorRows";

// Message-derived watch rows (own lifecycle + restart fence) merged with the
// daemon's verified report — the report supplies rows the loaded window lacks
// and retires rows the daemon found dead (liveWatchRowsFor). One hook so the
// full bars, the folded strip and the dormant fallback all read the same rows.
export function useLiveWatchRows(session: InboxSession, now: number) {
  const messages = useInboxStore((st) => st.messages[session._id]);
  return useMemo(
    () => (isWatchHostDead(session, now) ? [] : liveWatchRowsFor(session, messages, now)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the row fields the merge reads
    [messages, now, session.open_tasks, session.open_tasks_at, session.agent_started_at, session.agent_status, session.last_heartbeat, session.inbox_killed_at, session.updated_at],
  );
}
