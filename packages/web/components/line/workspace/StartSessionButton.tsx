"use client";
// A control that starts an agent session ("Improve this judge", learning-loop.md
// LL4). A session costs money and lands in the inbox, so a press opens the
// shared review (components/consequential SwitchReview): what starts, what it
// costs, what comes back and what stays with the person; only the review's own
// button starts it.
import { useState, type ReactNode } from "react";
import { SwitchReview, type SwitchLedger } from "../../consequential/ConsequentialSwitch";
import { costFigure, listRow, plural, type RunCost } from "../../consequential/lineStartLedger";

export function StartSessionButton({ children, ledger, start, className = "lw-act", primary, title, data }: {
  children: ReactNode;
  /** What the session starts, costs and brings back, as the review draws it. */
  ledger: SwitchLedger;
  start: () => void;
  className?: string;
  primary?: boolean;
  title?: string;
  /** Data attributes for the trigger (tests and verification find it by them). */
  data?: Record<`data-${string}`, string>;
}) {
  const [review, setReview] = useState(false);
  return (
    <>
      <button type="button" className={className} data-primary={primary ? "" : undefined} data-tone={className.includes("lw-chip") ? "ask" : undefined} aria-expanded={review} aria-haspopup="dialog" onClick={() => setReview(true)} title={title} {...data}>
        {children}
      </button>
      {review && <SwitchReview ledger={ledger} onClose={() => setReview(false)} onConfirm={() => { setReview(false); start(); }} />}
    </>
  );
}


/** "Improve this judge", as the review shows it: one session, its price, what it reads and that nothing changes until the card is answered. */
export function improveJudgeLedger(judge: string, wrong: number, cost: RunCost | null): SwitchLedger {
  return {
    name: "Improve this judge",
    subject: judge,
    shift: null,
    figures: [
      { value: "1", label: "agent session starts", tone: "warn" },
      costFigure(cost, 1, "a session"),
      ...(wrong ? [{ value: String(wrong), label: wrong === 1 ? "finding marked wrong" : "findings marked wrong" }] : []),
    ],
    rows: [
      listRow(cost),
      { k: "Reads", v: wrong ? `The ${plural(wrong, "finding")} you marked wrong` : `${judge}'s recent findings` },
      { k: "Tries", v: "A fix on recent data" },
      { k: "Brings back", v: "One card for you" },
      { k: "Changes", v: "Nothing until you answer", tone: "ok" },
    ],
    stop: "Stop its session in the inbox",
    confirm: "Start the session",
    keep: "Not now",
  };
}
