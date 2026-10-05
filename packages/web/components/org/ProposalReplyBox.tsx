"use client";
// The reply box for a surface with no conversation composer in reach
// (docs/architecture/org-staffing.md S39): the org page's asks column on a
// phone or with the thread column closed, the company document, a proposal a
// person posted. It draws the rows the composer's tray draws (the same
// component), a short field for a reply, and the frame's one filled button,
// "Send N answers". The send applies the approvals and, when the proposal has
// a thread, the server writes one message into it: the answers in words, then
// what was typed. The batch is the composer's own (`reviewComments[batchKey]`),
// keyed by the thread's conversation, so answers given here and answers given
// in that conversation are literally one batch; with no thread the key is
// `proposal:<id>` and nobody is told.
import { useState } from "react";
import { cn } from "../../lib/utils";
import { proposalAnswersOf, takeProposalAnswers } from "../../lib/reviewActions";
import { useInboxStore } from "../../store/inboxStore";
import { FIELD_SIZING_STYLE } from "../composerLayout";
import { KeyCap } from "../KeyCap";
import { PendingBatchRows } from "../ReviewBar";
import { OrgButton } from "./OrgButton";
import type { OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";
import { LEDGER_INKS, LEDGER_RULE, LEDGER_STOP } from "./ProposalSubjectCard";
import { isDecidable } from "./staffingModel";

export type ProposalThreadKey = { conversation_id: string } | null | undefined;

/** Where a proposal's answers collect when no composer is in reach: its
 *  thread's conversation when it has one, else a key of its own. */
export function proposalBatchKey(proposalId: string, thread: ProposalThreadKey): string {
  return thread?.conversation_id ?? `proposal:${proposalId}`;
}

/**
 * The send, for every host without a composer: take this proposal's answers
 * out of the batch, apply them (replyOnOrgProposal, `seen` from the store's
 * rows), and have the server say them into the thread with what was typed.
 * No thread: the verdicts apply and nothing is sent. Returns the words that
 * went, "" when nothing was pending.
 */
export function sendProposalAnswers(batchKey: string, proposalId: string, thread: ProposalThreadKey, typed = ""): string {
  const body = typed.trim();
  return takeProposalAnswers(batchKey, {
    proposalId,
    ...(thread ? { say: { thread: thread.conversation_id, ...(body ? { body } : {}), client_id: `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}` } } : {}),
  });
}

export type ProposalReplyBoxProps = {
  proposal: Pick<OrgProposalRow, "_id" | "short_id" | "title" | "status">;
  changes: readonly OrgProposalChange[];
  /** proposalBatchKey(proposal._id, thread). */
  batchKey: string;
  thread?: ProposalThreadKey;
  /** Stay at the foot of a scrolling column, on the page's own ground. */
  sticky?: boolean;
  /** The host's own send (the DEV preview flips its fixture rows and clears
   *  the batch itself). Absent: sendProposalAnswers. */
  onSend?: (typed: string) => void;
  className?: string;
};

export function ProposalReplyBox({ proposal, changes, batchKey, thread, sticky, onSend, className }: ProposalReplyBoxProps) {
  const answers = useInboxStore((s) => proposalAnswersOf(s.reviewComments[batchKey], proposal._id).length);
  const [typed, setTyped] = useState("");
  // The hint shows until the first answer lands here; after that the box is
  // either the rows or nothing.
  const [answered, setAnswered] = useState(false);
  if (answers > 0 && !answered) setAnswered(true);
  const waiting = proposal.status === "open" && changes.some((c) => isDecidable(c.status));
  const send = () => {
    if (!answers) return;
    if (onSend) onSend(typed);
    else sendProposalAnswers(batchKey, proposal._id, thread, typed);
    setTyped("");
  };
  if (!answers && !typed.trim()) {
    if (answered || !waiting) return null;
    return <p className={cn("m-0 text-[11.5px] leading-[18px] text-[color:var(--ink-quiet)]", LEDGER_INKS, className)} data-reply-hint>Answer the changes above, then send.</p>;
  }
  return (
    <div
      className={cn("not-prose border-t pt-3 text-[12.5px]", LEDGER_INKS, sticky && "sticky bottom-0 bg-[var(--sol-bg)] pb-1", className)}
      style={{ borderColor: LEDGER_RULE }}
      {...LEDGER_STOP}
      data-proposal-reply-box={answers}
    >
      {/* The rows grow to their content here (a column's foot has the room the
          composer's strip does not) and scroll past a cap behind a scrollbar
          that stays visible. Only this proposal's answers: two proposals can
          share one thread key. */}
      <div className="cc-review-tray-list cc-review-tray-list-grow canvas-scroll mb-2.5"><PendingBatchRows batchKey={batchKey} proposalId={proposal._id} /></div>
      <textarea
        value={typed}
        rows={2}
        placeholder="Add a reply (optional)"
        aria-label="Add a reply"
        className="block w-full resize-none rounded-md border bg-transparent px-2.5 py-1.5 text-[12.5px] leading-[20px] text-[color:var(--sol-text)] outline-none placeholder:text-[color:var(--ink-quiet)] focus:border-[color-mix(in_srgb,var(--sol-violet)_60%,transparent)]"
        style={{ borderColor: LEDGER_RULE, ...FIELD_SIZING_STYLE }}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        }}
        data-proposal-reply-typed
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={cn("inline-flex items-center gap-1 text-[11px] leading-[16px] text-[color:var(--ink-quiet)]")}><KeyCap size="xs">return</KeyCap> send</span>
        {!thread && <span className="min-w-0 text-[11px] leading-[16px] text-[color:var(--ink-quiet)]" data-reply-no-thread>Your answers apply; nobody is told.</span>}
        <OrgButton primary size="sm" className="ml-auto" disabled={!answers} onClick={send} data-send-answers={answers}>Send {answers} {answers === 1 ? "answer" : "answers"}</OrgButton>
      </div>
    </div>
  );
}
