import { useMemo } from "react";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { useInboxStore } from "../../store/inboxStore";
import { blockerStatusSig, storeBlockedMark, waitStateStyle, type BoardTask } from "../../lib/taskBlockers";

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
  // Wake on the statuses and titles of its task blockers only: a store change
  // that moves none of them selects the same string, and the labels are built
  // once below.
  const sig = useInboxStore((s) => blockerStatusSig(task, s.tasks));
  const mark = useMemo(
    () => (isTerminalTaskStatus(task.status) ? null : storeBlockedMark(task, useInboxStore.getState().tasks)),
    [task, sig],
  );
  if (!mark) return null;
  const style = waitStateStyle(mark.failed ? "failed" : "waiting", task.status);
  // Dim says the mark gates nothing right now, not that it is one more
  // metadata counter: at --sol-text-dim with a bare numeral it was character
  // for character the row's session count (TaskRow's Link2 chip), and the two
  // sit adjacent on a row with no other chips. One notch brighter keeps the
  // "one glyph distinct from the session count" TG12 asked for.
  const text = style.tone === "dim" ? "text-sol-text-muted" : style.text;
  return (
    <span
      role="img"
      aria-label={mark.tip}
      title={mark.tip}
      className={`flex items-center gap-0.5 flex-shrink-0 text-[10px] font-mono ${text} ${className}`}
    >
      <style.icon className={small ? "w-3 h-3" : "w-3.5 h-3.5"} />
      {mark.count > 1 && mark.count}
    </span>
  );
}
