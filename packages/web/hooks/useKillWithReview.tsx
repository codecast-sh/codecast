import { useCallback, useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { SwitchReview, type SwitchLedger } from "../components/consequential/ConsequentialSwitch";
import { killReviewOf } from "../components/consequential/killReview";
import type { TaskRow } from "../components/triggerTasks";

/** A Kill pressed from a plain button (a card's X): it ends at once when
 *  nothing is lost, else shows the review every Kill surface shows first
 *  (killReviewOf). `onKill` is the kill itself (useTriggerKillNotice), which
 *  asks a role's own session to retire instead. Render `dialog` once. */
export function useKillWithReview(onKill: (ids: string[]) => void) {
  const [review, setReview] = useState<{ ids: string[]; ledger: SwitchLedger } | null>(null);
  const kill = useCallback((ids: string[]) => {
    const st = useInboxStore.getState();
    const sessions = ids.map((id) => st.sessions[id]).filter((s) => !!s);
    const ledger = killReviewOf(sessions, Object.values(st.agentTasks ?? {}) as TaskRow[]);
    if (ledger) setReview({ ids, ledger });
    else onKill(ids);
  }, [onKill]);
  const dialog = review ? (
    <SwitchReview
      ledger={review.ledger}
      onClose={() => setReview(null)}
      onConfirm={() => { setReview(null); onKill(review.ids); }}
    />
  ) : null;
  return { kill, dialog };
}
