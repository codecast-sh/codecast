import { useCallback } from "react";
import { toast } from "sonner";
import { useSyncTriggers } from "./useSyncTriggers";
import { animatedHideSessions } from "../store/undoActions";
import { useInboxStore } from "../store/inboxStore";
import {
  armedInjectTasksFor,
  killCanceledTasksFor,
  taskDisplayTitle,
  type TaskRow,
} from "../components/triggerTasks";

// Killing a session cancels the triggers that inject into it (server side, on
// the hide transition) and restoring it re-arms them (server side, on the
// un-hide transition). Both side effects are invisible unless the product SAYS
// so — this hook is the one place that says it, shared by every kill/restore
// surface: the sidebar card buttons, the command palette, the keyboard chords,
// and the stashed-bucket "Kill all".

export function useTriggerKillNotice() {
  // The triggers a kill cancels and a restore re-arms are read off the store
  // at the moment of the click, fed by the shared trigger feeder (armed rows
  // plus a recent tail; useSyncTriggers). This hook mounts app-wide, and it
  // used to hold its own subscription to the complete trigger history:
  // thousands of rows per account, 1.5 GB read in 191 s of prod on
  // 2026-11-12 (ct-92571).
  useSyncTriggers();

  // Toast the cancellation with a "Keep trigger" escape hatch (re-arm WITHOUT
  // restoring the session). The undo of the kill itself needs no client hook:
  // the undo patch clears inbox_dismissed_at, and the server's un-hide
  // transition re-arms the stamped triggers authoritatively.
  const noticeCanceled = useCallback((armed: TaskRow[]) => {
    if (!armed.length) return;
    const revive = () => {
      const { triggerAction } = useInboxStore.getState();
      for (const t of armed) triggerAction(t._id, "reactivate");
    };
    toast(
      armed.length === 1
        ? `Also canceled trigger "${taskDisplayTitle(armed[0])}"`
        : `Also canceled ${armed.length} triggers bound to this session`,
      {
        description: "Its next fire would have revived the session you just killed. Restoring the session re-arms it.",
        duration: 10000,
        action: {
          label: armed.length === 1 ? "Keep trigger" : "Keep triggers",
          onClick: () => {
            revive();
            toast.success(
              armed.length === 1
                ? "Trigger re-armed — it will revive this session on its next fire"
                : `${armed.length} triggers re-armed`,
            );
          },
        },
      },
    );
  }, []);

  // Bulk kill (a selection, the stashed bucket's "Kill all"): every card
  // collapses out, the kill is one undo, and the notice is one aggregate.
  const killManyWithNotice = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const armed = new Map(ids.map((id) => [id, armedInjectTasksFor(storeTasks(), id)]));
    void animatedHideSessions(ids, "kill").then((killed) => noticeCanceled(killed.flatMap((id) => armed.get(id) ?? [])));
  }, [noticeCanceled]);
  // Kill one session, saying what triggers died with it.
  const killWithNotice = useCallback((id: string) => killManyWithNotice([id]), [killManyWithNotice]);

  // Restore a killed session, saying what triggers came back with it. The
  // re-arm itself happens server-side on the un-hide transition; this only
  // makes the side effect visible (a once-trigger whose time has passed
  // re-arms a minute out — silently reviving it would be a nasty surprise).
  const restoreWithNotice = useCallback((id: string) => {
    const revived = killCanceledTasksFor(storeTasks(), id);
    useInboxStore.getState().restoreSession(id);
    if (revived.length) {
      toast.success(
        revived.length === 1
          ? `Re-armed trigger "${taskDisplayTitle(revived[0])}" — its kill canceled it`
          : `Re-armed ${revived.length} triggers the kill canceled`,
      );
    }
  }, []);

  return { killWithNotice, killManyWithNotice, restoreWithNotice };
}

function storeTasks(): TaskRow[] {
  return Object.values((useInboxStore.getState() as any).agentTasks ?? {}) as TaskRow[];
}
