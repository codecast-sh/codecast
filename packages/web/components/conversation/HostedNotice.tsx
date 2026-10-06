// Why a hosted turn stopped short of an answer (plan pl-840): the engine's
// typed notice (NOTICE_KINDS in contracts/assistant) drawn as one calm block
// with the one thing the person can do about it. The sentence is the
// engine's own; the action comes from its kind. Only the conversation's last
// notice offers an action: once anything follows it, the moment has passed.
import { useState } from "react";
import { RotateCcw, ArrowRight, Mail } from "lucide-react";
import { APPROVAL_ANSWERS, type NoticeKind } from "@codecast/shared/contracts/assistant";
import { NOTICE_DOT } from "../../lib/hostedNotice";
export { hostedNoticeKind, lastNoticeKind, NOTICE_ROW_WORD } from "../../lib/hostedNotice";
import { cn } from "@/lib/utils";
import { sendToSession } from "../../lib/sendToSession";
import { useInboxStore } from "../../store/inboxStore";
import { useLaneMailAbilities } from "../simple/useLaneMail";
import { useUpgradesOpen } from "../simple/billing";
import { usePlanMeter } from "../simple/usePlanFigures";
import { LANE_COPY } from "../simple/lane";

/** What the person types for them when they press the notice's action. */
const KEEP_GOING = "Keep going";

type NoticeAction = { label: string; icon: typeof RotateCcw; run: () => void; busy?: string };

function actionFor(kind: NoticeKind, conversationId: string | undefined, retryText: string | undefined, upgradesOpen: boolean): NoticeAction | null {
  if (!conversationId) return null;
  switch (kind) {
    case "error":
    case "unavailable":
      return retryText ? { label: kind === "unavailable" ? "Try now" : "Try again", busy: "Trying again…", icon: RotateCcw, run: () => sendToSession(conversationId, retryText) } : null;
    case "time":
      return { label: KEEP_GOING, busy: "Going on…", icon: ArrowRight, run: () => sendToSession(conversationId, KEEP_GOING) };
    case "budget":
      // Until a plan can be bought, Plan has nothing to offer: the notice says
      // when the allowance comes back instead (BudgetReturn).
      return upgradesOpen ? { label: "Open Plan", icon: ArrowRight, run: () => useInboxStore.getState().openSettingsModal("plan") } : null;
    case "safety":
      return null;
  }
}

export function HostedNotice({ kind, content, conversationId, retryText, live, retries = 0 }: {
  kind: NoticeKind;
  content: string;
  conversationId: string | undefined;
  /** The person's last words, which Try again sends again. */
  retryText?: string;
  /** Whether this is the conversation's last row, so its action still applies. */
  live: boolean;
  /** How many times Try again already ran into this same stop. */
  retries?: number;
}) {
  const upgradesOpen = useUpgradesOpen();
  const action = live ? actionFor(kind, conversationId, retryText, upgradesOpen) : null;
  // A sent action holds the button until the row it sends replaces this
  // notice, so a second click never queues a second turn.
  const [sent, setSent] = useState(false);
  return (
    <div className="mx-auto conv-col px-2 sm:px-4 py-1.5" data-hosted-notice={kind}>
      <div className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius,8px)] border border-sol-border bg-sol-bg-alt/60 px-3.5 py-2.5",
        !live && "opacity-70",
      )}>
        <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", NOTICE_DOT[kind])} />
        <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-sol-text-muted">
          {retries > 0 ? "Still can't get through. " : ""}{content}
          {retries > 0 && <span className="text-sol-text-dim">{` Tried ${retries + 1} times.`}</span>}
          {kind === "budget" && live && !upgradesOpen && <BudgetReturn />}
        </p>
        {action && (
          <button
            type="button"
            disabled={sent}
            onClick={() => { if (sent) return; if (action.busy) setSent(true); action.run(); }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius,8px)] border border-sol-border bg-sol-card px-3 text-[13px] font-medium text-sol-text transition-colors hover:border-sol-text-dim/50 hover:bg-sol-bg-highlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/40 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-sol-card"
          >
            <action.icon className={cn("h-3.5 w-3.5", sent && action.icon === RotateCcw && "animate-spin")} aria-hidden />
            {sent && action.busy ? action.busy : action.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** When a used-up month comes back, in the composer's own sentence. */
function BudgetReturn() {
  const { wallet, resets } = usePlanMeter(false);
  return wallet && resets ? <span className="block pt-1 text-sol-text-dim">{LANE_COPY.plan.allowanceOut(resets)}</span> : null;
}

/** What the person answered an approval, as a receipt says it. */
export function approvalAnswerWords(answer: string): string {
  if (answer === APPROVAL_ANSWERS.approve) return "You said yes";
  if (answer === APPROVAL_ANSWERS.always) return "You said yes, and not to ask again";
  if (answer === APPROVAL_ANSWERS.decline) return "You said no";
  return `You said: “${answer}”`;
}

/** Whether an answer says something the step's receipt cannot: a plain yes
 *  or no is already in the receipt ("you said no"), while "don't ask again"
 *  and an answer in the person's own words are not. */
export function approvalAnswerAddsToReceipt(answer: string): boolean {
  return answer !== APPROVAL_ANSWERS.approve && answer !== APPROVAL_ANSWERS.decline;
}

/** A hosted conversation's answer to an approval: a quiet receipt line on
 *  the person's side, not a chat bubble, since the card asked and the step's
 *  own receipt says how it came out. */
export function ApprovalAnswerLine({ answer, question }: { answer: string; question?: string }) {
  return (
    <div className="mx-auto conv-col px-2 sm:px-4 py-1" data-hosted-approval-answer>
      <p className="ml-auto w-fit max-w-[85%] text-right text-[12.5px] leading-snug text-sol-text-dim">
        {approvalAnswerWords(answer)}
        {question ? <span className="text-sol-text-dim/70">{` · ${question}`}</span> : null}
      </p>
    </div>
  );
}

/** Whether a reply offers to connect mail and calendar (the tool set's note
 *  asks the assistant to, when they are not connected). */
export function offersMailConnect(text: string | null | undefined): boolean {
  return /\b(?:re)?connect\b[^.?!\n]{0,40}\b(?:mail|email|calendar)\b/i.test(text ?? "");
}

/** The button under such a reply: it opens Settings > Integrations, where
 *  the Whisk row connects. Shown only while mail is not connected and the
 *  deployment can connect it. */
export function MailConnectChip() {
  const mail = useLaneMailAbilities();
  if (!mail.known || mail.connected || mail.available === false) return null;
  return (
    <div className="mx-auto conv-col px-2 sm:px-4 -mt-3 pb-3" data-hosted-mail-connect>
      <button
        type="button"
        onClick={() => useInboxStore.getState().openSettingsModal("integrations")}
        className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius,8px)] border border-sol-border bg-sol-card px-3 text-[13px] font-medium text-sol-text transition-colors hover:bg-sol-bg-highlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/40"
      >
        <Mail className="h-3.5 w-3.5" aria-hidden />
        Connect mail and calendar
      </button>
    </div>
  );
}
