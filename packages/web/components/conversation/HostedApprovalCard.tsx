// A hosted conversation's approval, drawn where the conversation is: one card
// at the end of the transcript that asks the way a person would (plan pl-840).
// The question is the step's own words, the plan under it is the call as the
// engine wrote it for the card (approvalContext: "What I'll do", "When"), and
// the answers are Yes and Not now, with Always allow as a quiet third where
// the engine offers it. No keys, numbers or queue chrome: the developer's
// decision sheet (SessionDecisionCard) keeps those, and the Approvals page
// keeps the queue.
import { useState } from "react";
import { APPROVAL_ANSWERS, approvalButtonLabel } from "@codecast/shared/contracts/assistant";
import type { QueueItem } from "../../lib/decisionQueue";
import { useDecisionAnswer } from "../../hooks/useDecisionAnswer";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { cn } from "@/lib/utils";

const BUTTON = "inline-flex h-8 items-center rounded-[var(--radius,8px)] px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-orange/40 disabled:opacity-60";

export function HostedApprovalCard({ item }: { item: QueueItem }) {
  const { question, options, answer } = useDecisionAnswer(item);
  // One answer per card: the row leaves the store when the server settles it,
  // and a second click meanwhile would answer twice.
  const [answered, setAnswered] = useState(false);
  const pick = (index: number) => {
    if (answered) return;
    setAnswered(true);
    answer(index);
  };
  const yes = options.find((o) => o.label === APPROVAL_ANSWERS.approve) ?? options[0];
  const always = options.find((o) => o.label === APPROVAL_ANSWERS.always);
  const no = options.find((o) => o.label === APPROVAL_ANSWERS.decline);
  // Any option the engine did not write (a future kind of card) still shows.
  const others = options.filter((o) => o !== yes && o !== always && o !== no);
  return (
    <div className="mx-auto conv-col w-full px-2 sm:px-4 pb-2" data-session-decision={item.conversationId} data-hosted-approval>
      <div className="rounded-[var(--radius,8px)] border border-sol-border bg-sol-card px-4 py-3.5">
        {question && <p className="text-[15px] font-medium leading-snug text-sol-text">{question}</p>}
        {item.contextMd && (
          <div data-hosted-approval-plan className="mt-2 max-h-[40vh] overflow-y-auto text-[13.5px] leading-relaxed text-sol-text-muted">
            <MarkdownRenderer content={item.contextMd} />
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2">
          {yes && (
            <button type="button" data-option={yes.index} disabled={answered} onClick={() => pick(yes.index)} className={cn(BUTTON, "bg-sol-orange text-sol-bg hover:bg-sol-orange/90")}>
              {approvalButtonLabel(yes.label)}
            </button>
          )}
          {no && (
            <button type="button" data-option={no.index} disabled={answered} onClick={() => pick(no.index)} className={cn(BUTTON, "border border-sol-border bg-sol-bg text-sol-text hover:bg-sol-bg-highlight")}>
              {approvalButtonLabel(no.label)}
            </button>
          )}
          {others.map((o) => (
            <button key={o.index} type="button" data-option={o.index} disabled={answered} onClick={() => pick(o.index)} className={cn(BUTTON, "border border-sol-border bg-sol-bg text-sol-text hover:bg-sol-bg-highlight")} title={o.description}>
              {o.label}
            </button>
          ))}
          {yes?.description && <span className="text-[12.5px] text-sol-text-dim">{yes.description}</span>}
          {always && (
            <button type="button" data-option={always.index} disabled={answered} onClick={() => pick(always.index)} title={always.description} className="ml-auto text-[12.5px] text-sol-text-dim underline-offset-2 hover:text-sol-text hover:underline disabled:opacity-60">
              {approvalButtonLabel(always.label)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
