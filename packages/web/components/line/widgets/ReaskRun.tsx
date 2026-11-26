"use client";
// The one act for a run paused where no answer can land: its step left
// the line, or no session asked its card. Re-ask has the run's asking station
// present a new decision at a step the line still has. It stops the run's
// runner on the machine that runs it, so the press rides the store's
// trialReask (a trial problem) or reaskDecision (a decision's own page) to
// that machine (convex lineActions reaskOnRunMachineCore), which runs the same
// re-ask the CLI does. The
// button says the run is being asked until its card closes; a machine that
// never picks it up gives the button back, saying so. The press stops a
// runner and sets its agent working again, so it opens the shared review first
// (components/consequential); only the review's button re-asks.
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useWatchedCommand } from "../../../lib/useProviderKeyCommand";
import { isPermanentDispatchError } from "../../../store/mutativeMiddleware";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { SwitchReview, type SwitchLedger } from "../../consequential/ConsequentialSwitch";
import { MERGES_NEVER } from "../../consequential/lineStartLedger";

/** How long a press reads as under way before the button offers the act again. */
const REASK_WAIT_MS = 3 * 60 * 1000;

type CardRows = Record<string, { task_id: string; status: string; reask_at?: number }> | undefined;

/** When the problem's waiting cards were last asked again from here; 0 when never. */
const reaskAt = (rows: CardRows, taskId: string) => {
  let at = 0;
  for (const c of Object.values(rows ?? {})) if (c.task_id === taskId && c.status === "waiting" && (c.reask_at ?? 0) > at) at = c.reask_at!;
  return at;
};

/** What a re-ask starts, stops and brings back, as the review draws it. */
const reaskLedger = (task: string, lapsed: boolean): SwitchLedger => ({
  name: "Re-ask",
  subject: task,
  shift: null,
  ...(lapsed ? { alert: "Its machine did not answer the last re-ask" } : {}),
  figures: [{ value: "1", label: "run asked again", tone: "warn" }],
  rows: [
    { k: "Stops", v: "The run's runner on its machine", tone: "warn" },
    { k: "Its agent", v: "Presents the decision again" },
    { k: "Then", v: "A new decision for you" },
    { k: "Merges", v: MERGES_NEVER, tone: "ok" },
  ],
  confirm: "Re-ask",
  keep: "Not now",
});

/**
 * The Re-ask button and its review, wherever a run's decision can be asked
 * again: `at` is when this window last asked (0 when never), `subject` names
 * what is asked for a screen reader, and `onReask` sends it, resolving with
 * the command its machine was sent. A refusal, the server's or the machine's
 * (a step that could be either of two, a run that moved on), gives the button
 * back saying it was refused, with the reason on hover.
 */
export function ReaskButton({ at, subject, onReask, onRefused, className = "lw-act", primary }: { at: number; subject: string; onReask: () => Promise<unknown>; onRefused: () => void; className?: string; primary?: boolean }) {
  const now = useCoarseNow(15_000);
  const sent = useWatchedCommand();
  const [sendError, setSendError] = useState<string | null>(null);
  // A command no machine claimed in time expires (`expired_ttl`): that is no reply, never a refusal.
  const failed = sent.outcome?.state === "failed" ? sent.outcome.error : null;
  const unclaimed = failed === "expired_ttl";
  const refused = sendError ?? (unclaimed ? null : failed);
  const asking = !refused && !unclaimed && at > 0 && now - at < REASK_WAIT_MS;
  const lapsed = !refused && !asking && (unclaimed || at > 0);
  // A refusal, or a press no machine claimed, takes its stamp back, so a page opened again later offers Re-ask rather
  // than read as asking.
  useWatchEffect(() => { if (refused || unclaimed) onRefused(); }, [refused, unclaimed]);
  const [review, setReview] = useState(false);
  const reask = async () => {
    setReview(false);
    setSendError(null);
    sent.watch(null);
    try {
      const id = ((await onReask()) as { command_id?: unknown } | null)?.command_id;
      if (typeof id === "string") sent.watch(id);
    } catch (err) {
      // The server's refusal reads as one, in its own words; a send that never landed keeps reading as asking, then lapses.
      if (isPermanentDispatchError(err)) setSendError(humanizeConvexError(err, "The server refused it"));
    }
  };
  return (
    <>
      <button type="button" className={className} data-primary={primary ? "" : undefined} disabled={asking} aria-label={`Re-ask ${subject}`} aria-haspopup="dialog" data-line-reask={subject} data-state={refused ? "refused" : asking ? "asking" : lapsed ? "lapsed" : undefined}
        title={refused ?? (asking ? "Its machine is asking the run again; a new decision arrives when its agent has presented it" : lapsed ? "The run's machine did not pick this up. It may be offline; press to try again" : "Has the run's agent present this again as a decision you can answer")}
        onClick={(e) => { e.stopPropagation(); setReview(true); }}>
        <RotateCcw className="w-3.5 h-3.5" aria-hidden />{refused ? "Re-ask refused" : asking ? "Asking again" : lapsed ? "Re-ask (no reply)" : "Re-ask"}
      </button>
      {/* The review is a portal, but its presses still bubble through this tree: a row it sits in never takes them. */}
      {review && (
        <span className="contents" onClick={(e) => e.stopPropagation()}>
          <SwitchReview ledger={reaskLedger(subject, lapsed)} onClose={() => setReview(false)} onConfirm={() => void reask()} />
        </span>
      )}
    </>
  );
}

/** A trial problem's Re-ask. `taskId` is the problem's row id; `task` its ref, for the label a screen reader hears. */
export function ReaskRun({ taskId, task, className, primary }: { taskId: string; task: string; className?: string; primary?: boolean }) {
  const at = useInboxStore((s) => reaskAt((s as unknown as { trialCards?: CardRows }).trialCards, taskId));
  return <ReaskButton at={at} subject={task} onReask={() => useInboxStore.getState().trialReask(taskId)} onRefused={() => useInboxStore.getState().trialReaskRefused(taskId)} className={className} primary={primary} />;
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
