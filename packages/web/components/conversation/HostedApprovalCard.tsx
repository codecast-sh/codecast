// A hosted conversation's approval, drawn where the conversation is: one card
// at the end of the transcript that asks the way a person would (plan pl-840).
// The question is the step's own words, the plan under it is the call as the
// engine wrote it for the card (approvalContext: "What I'll do", "When"), and
// the answers are Yes and Not now, with Always allow as a quiet third where
// the engine offers it. No keys, numbers or queue chrome: the developer's
// decision sheet (SessionDecisionCard) keeps those, and the Approvals page
// keeps the queue. The body (plan, what Yes does, the answers) is
// HostedApprovalBody, which the Approvals page draws for the same asks.
import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { Check } from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { answerKeyAllowed } from "../decisions/ChangeCardView";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { APPROVAL_ANSWERS, approvalButtonLabel } from "@codecast/shared/contracts/assistant";
import { RoutineNotifyLine } from "./RoutineNotifyLine";
import type { QueueItem } from "../../lib/decisionQueue";
import { useDecisionAnswer } from "../../hooks/useDecisionAnswer";
import { useOverflows } from "../../hooks/useOverflows";
import { APPROVAL_REFUSED, useOneAnswer } from "../../hooks/useOneAnswer";
export { APPROVAL_REFUSED, useOneAnswer } from "../../hooks/useOneAnswer";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { clipFade } from "../CollapsibleBody";
import { cn } from "@/lib/utils";
import { approvalSettledWords, isRoutineYes, planForCard, yesWords } from "../../lib/hostedApproval";
export { approvalSettledWords, isHostedApproval, planForCard } from "../../lib/hostedApproval";

const APPROVAL_RADIUS = "rounded-[var(--radius,8px)]";


/** The plan scrolls past this share of the window; the cut fades while more
 *  of it is below. */
const PLAN_MAX_VH = 0.4;

/** An answer the body can draw: its stored label, its note, its index. */
type ApprovalOption = { label: string; description?: string; index: number };


/** The plan an approval shows (approvalContext: "What I'll do", "When").
 *  `clamp` holds it to a share of the window with a fade at the cut, for the
 *  conversation; the Approvals page shows it whole, since the engine keeps
 *  it short. */
export function HostedApprovalPlan({ contextMd, clamp = true }: { contextMd: string; clamp?: boolean }) {
  const planRef = useRef<HTMLDivElement>(null);
  const planMax = !clamp ? undefined : typeof window === "undefined" ? 400 : Math.round(window.innerHeight * PLAN_MAX_VH);
  const planOverflows = useOverflows(planRef, planMax ?? Number.MAX_SAFE_INTEGER, [contextMd]);
  const [planAtEnd, setPlanAtEnd] = useState(false);
  return (
    <div
      ref={planRef}
      data-hosted-approval-plan
      onScroll={(e) => {
        const el = e.currentTarget;
        setPlanAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
      }}
      className={cn("mt-2 text-[13.5px] leading-relaxed text-sol-text-muted", clamp && "overflow-y-auto")}
      style={clamp ? { maxHeight: planMax, ...(planOverflows && !planAtEnd ? clipFade(32) : null) } : undefined}
    >
      <MarkdownRenderer content={planForCard(contextMd)} />
    </div>
  );
}

/** One approval's body: the plan, what Yes does, then Yes and Not now (with
 *  Always allow as a quiet third, and any other option the engine wrote).
 *  With `keys`, Y and N answer it and their keycaps show on the buttons. */
export function HostedApprovalBody({
  question,
  contextMd,
  options,
  onPick,
  answered = false,
  refused = false,
  keys = false,
  clampPlan = true,
  later,
}: {
  question?: string;
  contextMd?: string;
  options: ApprovalOption[];
  onPick: (index: number) => void;
  answered?: boolean;
  refused?: boolean;
  keys?: boolean;
  clampPlan?: boolean;
  /** A quiet way to put the ask aside unanswered (the Approvals page). */
  later?: { label: string; title?: string; onClick: () => void };
}) {
  const yes = options.find((o) => o.label === APPROVAL_ANSWERS.approve) ?? options[0];
  const always = options.find((o) => o.label === APPROVAL_ANSWERS.always);
  const no = options.find((o) => o.label === APPROVAL_ANSWERS.decline);
  // Any option the engine did not write (a future kind of card) still shows.
  const others = options.filter((o) => o !== yes && o !== always && o !== no);
  // Y and N answer while no field has the keys (the composer keeps its own).
  useWatchEffect(() => {
    if (!keys || answered) return;
    const onKey = (e: KeyboardEvent) => {
      if (!answerKeyAllowed(e)) return;
      if (keyBelongsElsewhere(e.target)) return;
      const pick = e.key === "y" || e.key === "Y" ? yes : e.key === "n" || e.key === "N" ? no : undefined;
      if (!pick) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onPick(pick.index);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys, answered, yes, no, onPick]);
  return (
    <>
      {question && <p className="text-[15px] font-medium leading-snug text-sol-text">{question}</p>}
      {contextMd && <HostedApprovalPlan contextMd={contextMd} clamp={clampPlan} />}
      {/* What Yes does sits with the plan it answers, above both buttons,
          so it never reads as describing Not now. */}
      {yes?.description && <p data-hosted-approval-yes className="mt-2 text-[12.5px] leading-snug text-sol-text-dim">{yesWords(yes.description)}</p>}
      {yes?.description && isRoutineYes(yes.description) && !answered && <RoutineNotifyLine className="mt-1.5" />}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2">
        {yes && (
          <Button type="button" variant="amber" size="sm" data-option={yes.index} disabled={answered} onClick={() => onPick(yes.index)} className={APPROVAL_RADIUS}>
            {approvalButtonLabel(yes.label)}
          </Button>
        )}
        {no && (
          <Button type="button" variant="outline" size="sm" data-option={no.index} disabled={answered} onClick={() => onPick(no.index)} className={APPROVAL_RADIUS}>
            {approvalButtonLabel(no.label)}
          </Button>
        )}
        {/* The keys, said once beside the buttons and only while the card is
            hovered or holds focus, rather than a boxed letter in each button
            or a line under them that the card's edge could cut. */}
        {keys && !answered && (
          <span data-hosted-approval-keys className="ml-1 hidden items-center gap-1.5 text-[11.5px] text-sol-text-dim opacity-0 transition-opacity group-hover/approval:opacity-100 group-focus-within/approval:opacity-100 sm:inline-flex">
            <KeyCap size="xs">Y</KeyCap> yes <KeyCap size="xs">N</KeyCap> not now
          </span>
        )}
        {others.map((o) => (
          <Button key={o.index} type="button" variant="outline" size="sm" data-option={o.index} disabled={answered} onClick={() => onPick(o.index)} className={APPROVAL_RADIUS} title={o.description}>
            {o.label}
          </Button>
        ))}
        {later && (
          <button type="button" data-hosted-approval-later onClick={later.onClick} title={later.title} className={cn("text-[12.5px] text-sol-text-dim underline-offset-2 hover:text-sol-text hover:underline", !always && "ml-auto")}>
            {later.label}
          </button>
        )}
        {always && (
          <button type="button" data-option={always.index} disabled={answered} onClick={() => onPick(always.index)} title={always.description} className="ml-auto text-[12.5px] text-sol-text-dim underline-offset-2 hover:text-sol-text hover:underline disabled:opacity-60">
            {approvalButtonLabel(always.label)}
          </button>
        )}
      </div>
      {refused && <p role="alert" data-hosted-approval-refused className="mt-2 text-[12.5px] text-sol-text-muted">{APPROVAL_REFUSED}</p>}
    </>
  );
}


export function HostedApprovalCard({ item, keys = false }: { item: QueueItem; keys?: boolean }) {
  const { question, options, answer } = useDecisionAnswer(item);
  const { answered, refused, pick } = useOneAnswer(answer);
  return (
    <div className="w-full pt-4" data-session-decision={item.conversationId} data-hosted-approval>
      <div className="group/approval rounded-[var(--radius,8px)] border border-sol-border bg-sol-card px-4 py-3.5">
        <HostedApprovalBody question={question} contextMd={item.contextMd} options={options} onPick={pick} answered={answered} refused={refused} keys={keys} />
      </div>
    </div>
  );
}

/** The answered card, held in place until the transcript moves on, so the
 *  tap shows it registered at the moment trust matters most. It reads the
 *  answer from the store's own decision row, written by the answer action. */
export function HostedApprovalSettled({ label }: { label: string }) {
  return (
    <div className="w-full pt-4" data-hosted-approval-settled>
      <p role="status" className="flex items-center gap-2 rounded-[var(--radius,8px)] border border-sol-border bg-sol-card px-4 py-3 text-[13px] text-sol-text-muted">
        <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
        {approvalSettledWords(label)}
      </p>
    </div>
  );
}

/** Where the card will be while its decision row is still on its way: the
 *  turn has parked on an approval, and the row lands a moment later. One
 *  quiet line, so nothing points at a card that is not drawn yet. */
export function HostedApprovalPending() {
  return (
    <div className="w-full pt-4" data-hosted-approval-pending>
      <p className="rounded-[var(--radius,8px)] border border-dashed border-sol-border px-4 py-3 text-[13px] text-sol-text-dim">Getting the card ready…</p>
    </div>
  );
}
