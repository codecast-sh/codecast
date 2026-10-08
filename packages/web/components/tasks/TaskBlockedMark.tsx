import { useMemo } from "react";
import { Ban, Check, Hourglass, type LucideIcon } from "lucide-react";
import { isTerminalTaskStatus, type WaitState } from "@codecast/shared/tasks";
import { useInboxStore } from "../../store/inboxStore";
import { blockerStatusSig, storeBlockedMark, type BoardTask } from "../../lib/taskBlockers";

/** A wait that can no longer clear, wherever one is drawn: a "no entry" sign,
 * never the warning triangle, which marks urgent priority on the same rows. */
export const FailedWaitIcon = Ban;

type WaitStyle = { icon: LucideIcon; token: string; text: string };

/** How each wait state draws on every surface (the row mark, the task page's
 *  lines, the timeline, the plan graph): its glyph, its sol token for SVG
 *  and its text class. Where it sits on a task, read `waitStateStyle`. */
export const WAIT_STATE_STYLE: Record<WaitState, WaitStyle> = {
  waiting: { icon: Hourglass, token: "--sol-orange", text: "text-sol-orange" },
  met: { icon: Check, token: "--sol-green", text: "text-sol-green" },
  failed: { icon: FailedWaitIcon, token: "--sol-red", text: "text-sol-red" },
};

/** Whether what holds a task in `status` still gates its pickup: true until
 *  someone works it or it closes. */
export function blockerGatesPickup(status: string | null | undefined): boolean {
  return !isTerminalTaskStatus(status) && status !== "in_progress" && status !== "in_review";
}

/** A wait's style on a task in `status`: waiting is orange only while it
 *  gates pickup, failed red ("needs a re-plan") only while the task is open
 *  to pickup at all; past that it holds nothing and draws dim. */
export function waitStateStyle(state: WaitState, status: string | null | undefined): WaitStyle {
  const style = WAIT_STATE_STYLE[state];
  const live = state === "waiting" ? blockerGatesPickup(status) : state === "failed" ? !isTerminalTaskStatus(status) : true;
  return live ? style : { ...style, token: "--sol-text-dim", text: "text-sol-text-dim" };
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
