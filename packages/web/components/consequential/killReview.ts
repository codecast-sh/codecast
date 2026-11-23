// The one rule for every Kill surface (the card menu, a selection, the
// palette): a kill ends at once unless it would cut a turn off, cancel an
// armed trigger or drop queued messages; then it shows this review first.
import type { InboxSession } from "../../store/inboxStore";
import { armedInjectTasksFor, taskDisplayTitle, type TaskRow } from "../triggerTasks";
import type { SwitchLedger } from "./ConsequentialSwitch";
import { killSessionsLedger } from "./ledgers";

const titleOf = (s: InboxSession) => (s as { title?: string }).title || "Untitled session";

/** The review a kill of `sessions` must show, or null when it may end them at once. */
export function killReviewOf(sessions: InboxSession[], tasks: TaskRow[]): SwitchLedger | null {
  const working = sessions.filter((s) => s.is_idle === false).map(titleOf);
  const triggers = sessions.flatMap((s) => armedInjectTasksFor(tasks, s._id).map(taskDisplayTitle));
  const queued = sessions.filter((s) => s.has_pending).length;
  if (working.length === 0 && triggers.length === 0 && queued === 0) return null;
  return killSessionsLedger({ total: sessions.length, working, triggers, queued, ...(sessions.length === 1 ? { subject: titleOf(sessions[0]!) } : {}) });
}
