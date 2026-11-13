"use client";
// The one act for a trial run paused where no answer can land: its step left
// the line, or no session asked its card. Re-ask has the run's asking station
// present a new decision at a step the line still has. It stops the run's
// runner on the machine that runs it, so the press rides the store's
// trialReask to that machine (convex lineActions reaskTrialRunCore, the
// daemon's line_trial_reask), which runs the same re-ask the CLI does. The
// button says the run is being asked until its card closes; a machine that
// never picks it up gives the button back, saying so.
import { RotateCcw } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { useCoarseNow } from "../../../hooks/useCoarseNow";

/** How long a press reads as under way before the button offers the act again. */
const REASK_WAIT_MS = 3 * 60 * 1000;

type CardRows = Record<string, { task_id: string; status: string; reask_at?: number }> | undefined;

/** When the problem's waiting cards were last asked again from here; 0 when never. */
const reaskAt = (rows: CardRows, taskId: string) => {
  let at = 0;
  for (const c of Object.values(rows ?? {})) if (c.task_id === taskId && c.status === "waiting" && (c.reask_at ?? 0) > at) at = c.reask_at!;
  return at;
};

/** `taskId` is the problem's row id; `task` its ref, for the label a screen reader hears. */
export function ReaskRun({ taskId, task, className = "lw-act", primary }: { taskId: string; task: string; className?: string; primary?: boolean }) {
  const at = useInboxStore((s) => reaskAt((s as unknown as { trialCards?: CardRows }).trialCards, taskId));
  const now = useCoarseNow(15_000);
  const asking = at > 0 && now - at < REASK_WAIT_MS;
  const lapsed = at > 0 && !asking;
  return (
    <button type="button" className={className} data-primary={primary ? "" : undefined} disabled={asking} aria-label={`Re-ask ${task}`} data-line-reask={task} data-state={asking ? "asking" : lapsed ? "lapsed" : undefined}
      title={asking ? "Its machine is asking the run again; a new decision arrives when its agent has presented it" : lapsed ? "The run's machine did not pick this up. It may be offline; press to try again" : "Has the run's agent present this again as a decision you can answer"}
      onClick={(e) => { e.stopPropagation(); useInboxStore.getState().trialReask(taskId); }}>
      <RotateCcw className="w-3.5 h-3.5" aria-hidden />{asking ? "Asking again" : lapsed ? "Re-ask (no reply)" : "Re-ask"}
    </button>
  );
}

/** The same act where the answers would be, with the reason in a line. */
export function ReaskNotice({ taskId, task, reason }: { taskId: string; task: string; reason: string }) {
  return (
    <div className="ld-reask" data-line-decision-reask>
      <b>{reason}</b>
      <ReaskRun taskId={taskId} task={task} primary />
    </div>
  );
}
