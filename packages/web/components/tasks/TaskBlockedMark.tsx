import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { blockerStatusSig, liveTaskRow, storeBlockedMark, type BoardTask } from "../../lib/taskBlockers";
import { waitStateStyle } from "../../lib/taskWaitStyle";

/**
 * A blocked task's one mark on its row and card (task-graph.md TG12): an
 * hourglass, distinct from the session count's link, with a count when several
 * things hold it and a tooltip naming each. A failed wait draws the Ban glyph
 * in red (`WAIT_STATE_STYLE.failed`, lib/taskWaitStyle), as on the task page
 * and the timeline, because that task needs
 * re-planning rather than patience. Orange only where it gates pickup
 * (`blockerGatesPickup`); a task already being worked draws it dim. A closed
 * task is held by nothing and draws nothing. `small` matches the 12px icons
 * of a card or a plan's task list.
 */
export function TaskBlockedMark({ task, small = false }: { task: BoardTask; small?: boolean }) {
  // Wake on the row's own graph fields and on the statuses and titles of its
  // task blockers: a store change that moves none of them selects the same
  // string, and the labels are built once below. The row handed in as a prop
  // is a snapshot its collection took when `updated_at` last moved, and a
  // graph write leaves `updated_at` to the server's echo, so both the
  // signature and the mark read the store's live copy of the row
  // (`liveTaskRow`) — a wait removed in the page's peek beside this row has
  // to clear the hourglass now, not a round-trip later.
  const sig = useInboxStore((s) => blockerStatusSig(task, s.tasks));
  // The tooltip is the whole of this mark's title and accessible name, so the
  // one thing on it that moves with the clock has to keep moving: a time wait
  // reads "Waiting until Oct 6 12:00", and once that moment goes by unsettled
  // the phrase marks it "(overdue by 3d)" (`blockerWaitingLabel`). The
  // signature above carries only ids, states and titles, so nothing in it ever
  // moves as time passes, and a board left open would hold a lost settle at
  // the words it painted with. A minute's granularity, the clock the task
  // page, the plan graph and the timeline already follow.
  const now = useCoarseNow(60_000);
  const built = useMemo(() => {
    const tasks = useInboxStore.getState().tasks;
    return { mark: storeBlockedMark(task, tasks, now), status: liveTaskRow(task, tasks).status };
  }, [task, sig, now]);
  const mark = built.mark;
  if (!mark) return null;
  const style = waitStateStyle(mark.failed ? "failed" : "waiting", built.status);
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
      className={`flex items-center gap-0.5 flex-shrink-0 text-[10px] font-mono ${text}`}
    >
      <style.icon className={small ? "w-3 h-3" : "w-3.5 h-3.5"} />
      {mark.count > 1 && mark.count}
    </span>
  );
}
