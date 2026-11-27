import { useMemo } from "react";
import type { InboxSession } from "../store/inboxStore";
import { useCoarseNow } from "./useCoarseNow";
import { partitionTriggerInbox, type TaskRow, type TriggerRow } from "../components/triggerTasks";
import { sessionTriggerRows } from "../components/inbox/dormantWake";

/** The rows an open session's inbox card would carry, built from the trigger roster. */
export function useSessionTriggerRows(session: InboxSession, tasks: TaskRow[] | undefined): TriggerRow[] {
  const now = useCoarseNow(30_000);
  return useMemo(() => {
    const { rows } = partitionTriggerInbox(tasks, { [session._id]: session }, { focusedId: session._id, now });
    return sessionTriggerRows(rows, session);
  }, [tasks, session, now]);
}
