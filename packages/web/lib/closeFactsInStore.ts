// The facts a Close reads for one session, from the store around it: its armed
// triggers (the roster), a send this window has not seen land, and its nested
// group. The web tooltip (components/inbox/SessionCloseTip) and the phone's
// menu line (mobile lib/sessionVerbs) both read through here, so they say what
// the gesture (store closeInDraft) does. Relative imports only: the phone
// bundles this file.
import { closeFactsOf, closeTakesDownOf, nestedInFlightOf, type CloseFacts, type CloseRow } from "./sessionClose";
import { armedInjectTasksFor, type TaskRow } from "../components/triggerTasks";
import { convHasPendingSend } from "../store/inboxOverlays";

export type CloseStore = {
  agentTasks?: Record<string, unknown>;
  pendingMessages?: Record<string, any[] | undefined>;
  sessions?: Record<string, any>;
};

export function closeFactsInStore(st: CloseStore, row: CloseRow & { _id: string }, now: number): CloseFacts {
  const rows = Object.values(st.sessions ?? {});
  return closeFactsOf(
    row,
    armedInjectTasksFor(Object.values(st.agentTasks ?? {}) as TaskRow[], row._id).length,
    now,
    convHasPendingSend(st.pendingMessages?.[row._id], now),
    nestedInFlightOf(rows, row._id, now),
    closeTakesDownOf(rows, row._id).length,
  );
}
