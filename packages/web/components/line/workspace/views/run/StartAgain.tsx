"use client";
// "Start again" on a problem whose newest run failed or went silent
// (line-journeys.md LJ8.3, LJ8.4). It starts a full line run, so its label
// says how long one takes when that can be computed (runDuration) and the
// press opens a review of what starts and what it costs (SwitchReview with
// startAgainLedger); only the review's confirm starts anything.
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useInboxStore } from "../../../../../store/inboxStore";
import { isRefusedDispatchError } from "../../../../../store/mutativeMiddleware";
import { aboutWords, useRunDuration } from "../../../../../lib/line/runDuration";
import { SwitchReview } from "../../../../consequential/ConsequentialSwitch";
import { startAgainLedger } from "../../../../consequential/ledgers";
import { useRunCost } from "../../../../consequential/useRunCost";

export type StartAgainProps = {
  /** The problem's row id, and how it reads in the review: "ct-58680 · Its title". */
  taskId: string;
  problem: string;
  projectId: string | null;
  /** A fix was already built on this problem's branch: the review says the new run reuses it. */
  branch?: boolean;
};

export function StartAgain({ taskId, problem, projectId, branch }: StartAgainProps) {
  const project = useInboxStore((s) => (projectId ? (s.projects as Record<string, { title?: string }> | undefined)?.[projectId]?.title ?? null : null));
  const cost = useRunCost(projectId);
  const ms = useRunDuration(projectId);
  const about = ms ? aboutWords(ms) : null;
  const [review, setReview] = useState(false);
  const [state, setState] = useState<"idle" | "starting" | { error: string }>("idle");
  const start = () => {
    setReview(false);
    setState("starting");
    useInboxStore.getState().startLineCause(taskId).catch((e: unknown) => {
      if (isRefusedDispatchError(e)) setState({ error: (e instanceof Error ? e.message : String(e)).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it" });
    });
  };
  return (
    <>
      {typeof state === "object" && <span className="rp-act-error" role="alert">{state.error}</span>}
      <button type="button" className="lw-act" data-primary="" disabled={state === "starting"} onClick={() => setReview(true)} data-line-start-again={taskId}>
        <RotateCcw className="w-3.5 h-3.5" aria-hidden />{state === "starting" ? "Starting the run" : `Start again${about ? `, about ${about}` : ""}`}
      </button>
      {review && <SwitchReview ledger={startAgainLedger({ problem, project, branch, cost, about })} onClose={() => setReview(false)} onConfirm={start} />}
    </>
  );
}
