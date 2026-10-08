import { useMemo } from "react";
import { Hourglass, TriangleAlert } from "lucide-react";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { useInboxStore } from "../../store/inboxStore";
import { blockedMark, blockerStatusSig, openBlockers, type BoardTask } from "../../lib/taskBlockers";

/**
 * A blocked task's one mark on its row and card (task-graph.md TG12): an
 * hourglass, distinct from the session count's link, with a count when several
 * things hold it and a tooltip naming each. A red warning when a wait failed,
 * as on the task page, because that task needs re-planning rather than
 * patience. A closed task is held by nothing and draws nothing.
 */
export function TaskBlockedMark({ task, className = "" }: { task: BoardTask; className?: string }) {
  // Wake on the statuses of its task blockers only: a store change that moves
  // none of them selects the same string, and the labels are built once below.
  const sig = useInboxStore((s) => blockerStatusSig(task, s.tasks));
  const mark = useMemo(
    () => (isTerminalTaskStatus(task.status) ? null : blockedMark(openBlockers(task, useInboxStore.getState().tasks))),
    [task, sig],
  );
  if (!mark) return null;
  const Glyph = mark.failed ? TriangleAlert : Hourglass;
  return (
    <span
      role="img"
      aria-label={mark.tip}
      title={mark.tip}
      className={`flex items-center gap-0.5 flex-shrink-0 text-[10px] font-mono ${mark.failed ? "text-sol-red" : "text-sol-orange"} ${className}`}
    >
      <Glyph className="w-3.5 h-3.5" />
      {mark.count > 1 && mark.count}
    </span>
  );
}
