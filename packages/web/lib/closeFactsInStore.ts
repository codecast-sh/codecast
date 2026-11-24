// The facts a Close reads for one session, from the store around it: its armed
// triggers (the roster, counted by the server's shared isArmedInjectTrigger),
// a send this window has not seen land, and its nested group. The web tooltip
// (components/inbox/SessionCloseTip) and the phone's menu line (mobile
// lib/sessionVerbs) both read through here, so they say what the gesture
// (store closeInDraft) does. Relative imports only: the phone bundles this file.
import type { CloseFacts } from "@codecast/shared/contracts/closeKind";
import { closeFactsOf, closeTakesDownOf, nestedInFlightOf, type CloseRow } from "./sessionClose";
import { isArmedInjectTrigger } from "@codecast/shared/contracts/armedTrigger";
import type { TaskRow } from "../components/triggerTasks";
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
    (Object.values(st.agentTasks ?? {}) as TaskRow[]).filter((t) => t.originating_conversation_id === row._id && isArmedInjectTrigger(t)).length,
    now,
    convHasPendingSend(st.pendingMessages?.[row._id], now),
    nestedInFlightOf(rows, row._id, now),
    closeTakesDownOf(rows, row._id).length,
  );
}
