import { useMemo } from "react";
import type { InboxSession } from "../store/inboxStore";
import { useCoarseNow } from "./useCoarseNow";
import { useLiveWatchRows } from "./useLiveWatchRows";
import { partitionTriggerInbox, type TaskRow, type TriggerRow } from "../components/triggerTasks";
import { dormantWakeLabel, dormantWakeOf, sessionTriggerRows } from "../components/inbox/dormantWake";

/** One session's wake (dormantWakeOf) and its words, from the trigger rows it
 *  is handed; `owner` names who it returns to when that is not the viewer. */
export function useDormantWake(session: InboxSession, rows: TriggerRow[], owner?: string | null) {
  const now = useCoarseNow(30_000);
  const watches = useLiveWatchRows(session, now);
  const wake = dormantWakeOf(session, rows, watches, now);
  return { wake, label: dormantWakeLabel(wake, now, owner) };
}

/** The rows an open session's inbox card would carry, built from the trigger roster. */
export function useSessionTriggerRows(session: InboxSession, tasks: TaskRow[] | undefined): TriggerRow[] {
  const now = useCoarseNow(30_000);
  return useMemo(() => {
    const { rows } = partitionTriggerInbox(tasks, { [session._id]: session }, { focusedId: session._id, now });
    return sessionTriggerRows(rows, session);
  }, [tasks, session, now]);
}
