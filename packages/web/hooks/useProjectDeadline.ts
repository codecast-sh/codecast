import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";

/** Timestamp to the yyyy-mm-dd a date field wants, in local time. */
function toDateInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type DeadlineProject = { _id: string; target_date?: number | null; status?: string };

/** A project's deadline, read and written the one way the board and the
 *  sheet share. A deadline is the end of its day in LOCAL time, so a project
 *  "due Sep 26" is on time all of Sep 26, not just until midnight UTC. Clear
 *  writes null, which rides the dispatch to webUpdate and drops the field. */
export function useProjectDeadline(project: DeadlineProject) {
  const { _id, target_date } = project;
  const onCommit = useCallback((day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    const ts = new Date(y, m - 1, d, 23, 59, 59).getTime();
    if (ts !== target_date) useInboxStore.getState().updateProject(_id, { target_date: ts });
  }, [_id, target_date]);
  const onClear = useCallback(() => useInboxStore.getState().updateProject(_id, { target_date: null }), [_id]);
  return { day: target_date ? toDateInput(target_date) : undefined, onCommit, onClear };
}
