// The one rule for every Kill surface (the card menu, a selection, the
// palette, the phone): a kill ends at once unless it would cut a turn off,
// cancel an armed trigger or drop queued messages; then it shows this review
// first.
import type { InboxSession } from "../../store/inboxStore";
import { armedInjectTasksFor, taskDisplayTitle, type TaskRow } from "../triggerTasks";
import type { SwitchLedger } from "./ConsequentialSwitch";
import { killSessionsLedger } from "./ledgers";

const titleOf = (s: InboxSession) => (s as { title?: string }).title || "Untitled session";

/** The review a kill of `sessions` must show, or null when it may end them at
 *  once. A role's own session is not killed (its kill opens the retire
 *  question instead, store undoActions askRetireInstead), so it counts for
 *  nothing here; a persistent anchor's kill is dormancy that keeps its
 *  triggers and queue (convex cleanup.ts), so only a turn it would cut off counts. */
export function killReviewOf(sessions: InboxSession[], tasks: TaskRow[]): SwitchLedger | null {
  const killed = sessions.filter((s) => !s.standing_role_id);
  const retiring = killed.filter((s) => !s.persistent);
  const working = killed.filter((s) => s.is_idle === false).map(titleOf);
  const triggers = retiring.flatMap((s) => armedInjectTasksFor(tasks, s._id).map(taskDisplayTitle));
  const queued = retiring.filter((s) => s.has_pending).length;
  if (working.length === 0 && triggers.length === 0 && queued === 0) return null;
  return killSessionsLedger({ total: killed.length, working, triggers, queued, ...(killed.length === 1 ? { subject: titleOf(killed[0]!) } : {}) });
}
