import { useMemo } from "react";
import { Ban, Hourglass } from "lucide-react";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { useInboxStore } from "../../store/inboxStore";
import { blockerStatusSig, storeBlockedMark, type BoardTask } from "../../lib/taskBlockers";

/**
 * A blocked task's one mark on its row and card (task-graph.md TG12): an
 * hourglass, distinct from the session count's link, with a count when several
 * things hold it and a tooltip naming each. A failed wait draws FailedWaitIcon
 * in red, as on the task page and the timeline, because that task needs
 * re-planning rather than patience. Orange only where it gates pickup (an
 * open task); a task already being worked draws it dim. A closed task is held
 * by nothing and draws nothing.
 */
/** A wait that can no longer clear, wherever one is drawn: a "no entry" sign,
 * never the warning triangle, which marks urgent priority on the same rows. */
export const FailedWaitIcon = Ban;

export function TaskBlockedMark({ task, className = "" }: { task: BoardTask; className?: string }) {
  // Wake on the statuses of its task blockers only: a store change that moves
  // none of them selects the same string, and the labels are built once below.
  const sig = useInboxStore((s) => blockerStatusSig(task, s.tasks));
  const mark = useMemo(
    () => (isTerminalTaskStatus(task.status) ? null : storeBlockedMark(task, useInboxStore.getState().tasks)),
    [task, sig],
  );
  if (!mark) return null;
  const Glyph = mark.failed ? FailedWaitIcon : Hourglass;
  const tone = mark.failed ? "text-sol-red" : task.status === "in_progress" || task.status === "in_review" ? "text-sol-text-dim" : "text-sol-orange";
  return (
    <span
      role="img"
      aria-label={mark.tip}
      title={mark.tip}
      className={`flex items-center gap-0.5 flex-shrink-0 text-[10px] font-mono ${tone} ${className}`}
    >
      <Glyph className="w-3.5 h-3.5" />
      {mark.count > 1 && mark.count}
    </span>
  );
}
