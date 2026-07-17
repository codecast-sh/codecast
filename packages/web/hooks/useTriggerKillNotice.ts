import { useCallback, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { animatedHideSession } from "../store/undoActions";
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
//
// The webList subscription is deduped by Convex with the panel/badge/strip
// subscriptions, so mounting this hook anywhere costs no extra server load.
export function useTriggerKillNotice() {
  const tasks = useQuery(api.agentTasks.webList, {}) as TaskRow[] | undefined;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const reactivateTask = useMutation(api.agentTasks.webReactivate);

  // Toast the cancellation with a "Keep trigger" escape hatch (re-arm WITHOUT
  // restoring the session). The undo of the kill itself needs no client hook:
  // the undo patch clears inbox_dismissed_at, and the server's un-hide
  // transition re-arms the stamped triggers authoritatively.
  const noticeCanceled = useCallback((armed: TaskRow[]) => {
    if (!armed.length) return;
    const revive = () => {
      for (const t of armed) reactivateTask({ task_id: t._id as Id<"agent_tasks"> }).catch(() => {});
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
  }, [reactivateTask]);

  // Kill one session, saying what triggers died with it.
  const killWithNotice = useCallback((id: string) => {
    const armed = armedInjectTasksFor(tasksRef.current, id);
    animatedHideSession(id, "kill");
    noticeCanceled(armed);
  }, [noticeCanceled]);

  // Bulk kill (the stashed bucket's "Kill all"): one aggregate notice.
  const killManyWithNotice = useCallback((ids: string[]) => {
    if (!ids.length) return;
    useInboxStore.getState().killSessions(ids);
    noticeCanceled(ids.flatMap((id) => armedInjectTasksFor(tasksRef.current, id)));
  }, [noticeCanceled]);

  // Restore a killed session, saying what triggers came back with it. The
  // re-arm itself happens server-side on the un-hide transition; this only
  // makes the side effect visible (a once-trigger whose time has passed
  // re-arms a minute out — silently reviving it would be a nasty surprise).
  const restoreWithNotice = useCallback((id: string) => {
    const revived = killCanceledTasksFor(tasksRef.current, id);
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
