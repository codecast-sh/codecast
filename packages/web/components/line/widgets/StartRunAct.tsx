"use client";
// The one control that starts a full line run on a problem again
// (line-journeys.md LJ3 rule 6): its label says what it starts and, when three
// finished runs give one, about how long; pressing it opens the review
// (SwitchReview with startAgainLedger: what starts, what it costs, whether the
// saved branch is reused), and only the review's own button starts the run.
import { useState, type ReactNode } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import { isRefusedDispatchError } from "../../../store/mutativeMiddleware";
import { aboutWords, useRunDuration } from "../../../lib/line/runDuration";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { startAgainLedger } from "../../consequential/ledgers";
import { useRunCost } from "../../consequential/useRunCost";
import { usd } from "../../consequential/lineStartLedger";

export function StartRunAct({ taskId, projectId, problem, label = "Start again", branch = false, primary = true, icon, priced = false, goOn, hold, sendBack, reprove, before }: {
  taskId: string;
  projectId: string | null;
  /** The problem as the review names it: its ref and title. */
  problem: string;
  label?: string;
  /** A fix is already built on a branch the new run picks up. */
  branch?: boolean;
  primary?: boolean;
  icon?: ReactNode;
  /** Say on the button that it starts a paid run, and its price: "Ask again (new run, ~$7)". Where a free act sits beside it. */
  priced?: boolean;
  /** The run is a yes to a step that stopped with nowhere to go: the review names the steps it redoes, the next, and
   *  the proof its check holds the change to (lineNeeds goOnProof), warned when the last run left none. */
  goOn?: { step: string; next: string | null; proof?: string; warn?: string | null };
  /** What the last run said blocks it: the review leads with it. */
  hold?: string | null;
  /** A built fix sent back from review: the review names why (startAgainLedger sendBack). */
  sendBack?: { act: "sendback" | "rebuild"; why: string[] } | null;
  /** A step that rested its advice on one case while the problem holds more: the run proves again on all of them. */
  reprove?: { step: string; findings: number } | null;
  /** Runs on the confirm, before the run starts: what the new run must read first (a note on the problem). */
  before?: () => void;
}) {
  const project = useInboxStore((s) => (projectId ? (s.projects as Record<string, { title?: string }> | undefined)?.[projectId]?.title ?? null : null));
  const cost = useRunCost(projectId);
  const ms = useRunDuration(projectId);
  const about = ms ? aboutWords(ms) : null;
  const [review, setReview] = useState(false);
  const [state, setState] = useState<"idle" | "starting" | { error: string }>("idle");
  const start = () => {
    setReview(false);
    setState("starting");
    before?.();
    useInboxStore.getState().startLineCause(taskId).catch((e: unknown) => {
      if (isRefusedDispatchError(e)) setState({ error: (e instanceof Error ? e.message : String(e)).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it" });
    });
  };
  return (
    <>
      {typeof state === "object" && <span className="lw-act-error" role="alert">{state.error}</span>}
      <button type="button" className="lw-act" data-primary={primary ? "" : undefined} aria-haspopup="dialog" disabled={state === "starting"} onClick={() => setReview(true)} data-line-start-again={taskId}>
        {icon}{state === "starting" ? "Starting the run" : priced ? `${label} (new run${cost ? `, ~${usd(cost.billedUsd)} billed` : ""})` : `${label}${about ? `, about ${about}` : ""}`}
      </button>
      {review && <SwitchReview ledger={startAgainLedger({ problem, project, branch, cost, about, goOn, hold, sendBack, reprove })} onClose={() => setReview(false)} onConfirm={start} />}
    </>
  );
}
