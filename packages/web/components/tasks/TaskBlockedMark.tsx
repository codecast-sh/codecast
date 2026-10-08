import { Hourglass } from "lucide-react";
import type { GraphTask } from "@codecast/shared/tasks";
import { useInboxStore } from "../../store/inboxStore";
import { blockedMark, openBlockers } from "../../lib/taskBlockers";

/**
 * A blocked task's one mark on its row and card (task-graph.md TG12): an
 * hourglass, distinct from the session count's link, with a count when several
 * things hold it and a tooltip naming each. Red when a wait failed, because
 * that task needs re-planning rather than patience.
 */
export function TaskBlockedMark({ task, className = "" }: { task: GraphTask; className?: string }) {
  // The tooltip is the wake signature: the row repaints only when what holds
  // it changes, not on every write to another task.
  const tip = useInboxStore((s) => blockedMark(openBlockers(task, s.tasks))?.tip ?? "");
  if (!tip) return null;
  const mark = blockedMark(openBlockers(task, useInboxStore.getState().tasks));
  if (!mark) return null;
  return (
    <span
      role="img"
      aria-label={mark.tip}
      title={mark.tip}
      className={`flex items-center gap-0.5 flex-shrink-0 text-[10px] font-mono ${mark.failed ? "text-sol-red" : "text-sol-orange"} ${className}`}
    >
      <Hourglass className="w-3.5 h-3.5" />
      {mark.count > 1 && mark.count}
    </span>
  );
}
