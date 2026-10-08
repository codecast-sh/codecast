import { useMemo } from "react";
import { Ban, Check, Hourglass, type LucideIcon } from "lucide-react";
import { isTerminalTaskStatus, waitTone, type WaitState } from "@codecast/shared/tasks";
import { useInboxStore } from "../../store/inboxStore";
import { blockerStatusSig, storeBlockedMark, WAIT_TONE_STYLE, type BoardTask } from "../../lib/taskBlockers";

/** A wait that can no longer clear, wherever one is drawn: a "no entry" sign,
 * never the warning triangle, which marks urgent priority on the same rows. */
export const FailedWaitIcon = Ban;

type WaitStyle = { icon: LucideIcon; token: string; text: string };

const WAIT_ICON: Record<WaitState, LucideIcon> = { waiting: Hourglass, met: Check, failed: FailedWaitIcon };

/** Each wait state's glyph in its own colour (`WAIT_TONE_STYLE`). Where it
 *  sits on a task, read `waitStateStyle`. */
export const WAIT_STATE_STYLE = Object.fromEntries(
  Object.entries(WAIT_ICON).map(([state, icon]) => [state, { icon, ...WAIT_TONE_STYLE[state as WaitState] }]),
) as Record<WaitState, WaitStyle>;

/** A wait's glyph on a task in `status`, in its `waitTone`: its state's
 *  colour while it holds something, dim past that. */
export function waitStateStyle(state: WaitState, status: string | null | undefined): WaitStyle {
  return { icon: WAIT_ICON[state], ...WAIT_TONE_STYLE[waitTone(state, status)] };
}

/**
 * A blocked task's one mark on its row and card (task-graph.md TG12): an
 * hourglass, distinct from the session count's link, with a count when several
 * things hold it and a tooltip naming each. A failed wait draws FailedWaitIcon
 * in red, as on the task page and the timeline, because that task needs
 * re-planning rather than patience. Orange only where it gates pickup
 * (`blockerGatesPickup`); a task already being worked draws it dim. A closed
 * task is held by nothing and draws nothing. `small` matches the 12px icons
 * of a card or a plan's task list.
 */
export function TaskBlockedMark({ task, small = false, className = "" }: { task: BoardTask; small?: boolean; className?: string }) {
  // Wake on the statuses of its task blockers only: a store change that moves
  // none of them selects the same string, and the labels are built once below.
  const sig = useInboxStore((s) => blockerStatusSig(task, s.tasks));
  const mark = useMemo(
    () => (isTerminalTaskStatus(task.status) ? null : storeBlockedMark(task, useInboxStore.getState().tasks)),
    [task, sig],
  );
  if (!mark) return null;
  const style = waitStateStyle(mark.failed ? "failed" : "waiting", task.status);
  return (
    <span
      role="img"
      aria-label={mark.tip}
      title={mark.tip}
      className={`flex items-center gap-0.5 flex-shrink-0 text-[10px] font-mono ${style.text} ${className}`}
    >
      <style.icon className={small ? "w-3 h-3" : "w-3.5 h-3.5"} />
      {mark.count > 1 && mark.count}
    </span>
  );
}
