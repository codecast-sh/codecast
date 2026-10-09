"use client";
// The one place a staged answer is explained (org-staffing.md S39): a press
// on Approve, Reject or Reply fires nothing, so the controls it replaces give
// way to a band that says what will happen when the composer sends, with Undo
// at its end. The subject card, the group row and the foot all mount it.
import React from "react";
import { Check, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { TakeoverEdit } from "./TakeoverEdit";
import { LedgerWord, type SubjectAnswer } from "./ProposalSubjectCard";

/** The band's words: the first word in the verdict's ink, the rest quiet. */
export function stagedWords(answer: SubjectAnswer, retry = false): [string, string] {
  if (answer.verdict === "reject") return ["Rejection added to your reply.", "Goes out when you send it."];
  if (answer.verdict === "note") return ["Note added to your reply.", "Goes out when you send it."];
  if (retry) return ["Retry added to your reply.", "Runs again when you send it."];
  if (answer.leave_sessions) return ["Approval added to your reply,", "leaving the sessions where they are. Nothing changes until you send it."];
  return ["Approval added to your reply.", "Nothing changes until you send it."];
}

const WASH: Record<SubjectAnswer["verdict"], string> = {
  approve: "color-mix(in srgb, var(--sol-violet) 8%, transparent)",
  reject: "color-mix(in srgb, var(--sol-red) 8%, transparent)",
  note: "color-mix(in srgb, var(--sol-border) 30%, transparent)",
};
/** The band's wash, for a field drawn joined under it. */
export const stagedWash = (verdict: SubjectAnswer["verdict"]) => WASH[verdict];
const INK: Record<SubjectAnswer["verdict"], string> = {
  approve: "text-[color:var(--ink-violet)]",
  reject: "text-[color:var(--ink-red)]",
  note: "text-[color:var(--sol-text)]",
};

export function StagedBand({ answer, retry, onUndo, field, you, takeover, joined, className }: {
  answer: SubjectAnswer;
  /** The approval retries a failed entry. */
  retry?: boolean;
  onUndo: () => void;
  /** The reply field while it is open; drawn under the first line. */
  field?: React.ReactNode;
  /** The person's words once the field closed (LedgerYou). */
  you?: React.ReactNode;
  /** What approving would take over (R1); the tick rides the approval as `leave_sessions`. */
  takeover?: { phrase: string; leave: boolean; onLeave: (v: boolean) => void };
  /** A field drawn right under the band, on the same wash: the band's bottom corners open to it. */
  joined?: boolean;
  className?: string;
}) {
  const [first, rest] = stagedWords(answer, retry);
  const Icon = answer.verdict === "approve" ? Check : answer.verdict === "reject" ? X : null;
  return (
    <div
      role="status"
      className={cn("org-pop-in motion-reduce:animate-none min-w-0 rounded-md px-2.5 py-1.5 text-[12.5px] leading-[18px]", joined && "rounded-b-none", className)}
      style={{ background: WASH[answer.verdict] }}
      data-staged={answer.verdict}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {Icon && <Icon aria-hidden className={cn("h-3 w-3 shrink-0", INK[answer.verdict])} />}
        <span className="min-w-0 flex-1 text-[color:var(--sol-text-secondary)]">
          <b className={cn("font-semibold", INK[answer.verdict])}>{first}</b> {rest}
        </span>
        <LedgerWord className="-mr-2 ml-auto h-6 text-[11px]" onClick={onUndo} aria-label="Undo this answer" data-staged-undo>Undo</LedgerWord>
      </div>
      {field ? <div className="mt-1.5 min-w-0">{field}</div> : you ? <div className="mt-1 min-w-0">{you}</div> : null}
      {takeover && answer.verdict === "approve" && <TakeoverEdit className="mt-1.5" phrase={takeover.phrase} leave={takeover.leave} onLeave={takeover.onLeave} />}
    </div>
  );
}
