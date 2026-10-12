// Why a hosted turn stopped short of an answer (plan pl-840): the engine's
// typed notice (NOTICE_KINDS in contracts/assistant) drawn as one calm block
// with the one thing the person can do about it. The sentence is the
// engine's own; the action comes from its kind. Only the conversation's last
// notice offers an action: once anything follows it, the moment has passed.
import { useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { PENDING_HOSTED_GRACE_MS } from "./pendingSend";
import { RotateCcw, ArrowRight, Mail, Repeat } from "lucide-react";
import type { NoticeKind } from "@codecast/shared/contracts/assistant";
import { NOTICE_DOT, noticeMove, noticeWords } from "../../lib/hostedNotice";
import { TopUpLink } from "../plan/TopUpLink";
export { hostedNoticeKind, lastNoticeKind, NOTICE_ROW_WORD, noticeWords } from "../../lib/hostedNotice";
import { cn } from "@/lib/utils";
import { sendToSession } from "../../lib/sendToSession";
import { useInboxStore } from "../../store/inboxStore";
import { useLaneMailAbilities } from "../simple/useLaneMail";
import { useUpgradesOpen } from "../simple/billing";
import { usePlanMeter } from "../simple/usePlanFigures";
import { LANE_COPY, approvalAnswerWords } from "../simple/lane";
import { UseWhiskNow } from "../simple/UseWhiskNow";
import { useThinkingAvailable } from "../simple/assistantPromise";
import { EMAIL_PROOF_DIGITS, useEmailProof } from "../simple/useEmailProof";

export type NoticeAction = { label: string; icon: typeof RotateCcw; run: () => void; busy?: string };

/** The one thing a person can do about a stop, by its kind: the notice's own
 *  button, and the inbox's "Try these again" over every stopped row
 *  (GlobalSessionPanel RetryStoppedButton), so the two never disagree. */
export function actionFor(kind: NoticeKind, conversationId: string | undefined, retryText: string | undefined, upgradesOpen: boolean): NoticeAction | null {
  const move = conversationId ? noticeMove(kind, retryText, upgradesOpen) : null;
  if (!move || !conversationId) return null;
  const { send } = move;
  return {
    label: move.label,
    busy: move.busy,
    icon: kind === "error" || kind === "unavailable" ? RotateCcw : ArrowRight,
    // A budget stop's move opens Plan; until a plan can be bought it has
    // none, and the notice says when the allowance comes back (BudgetReturn).
    run: send ? () => sendToSession(conversationId, send) : () => useInboxStore.getState().openSettingsModal("plan"),
  };
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
  // While no provider can serve, a retry is a known failure: the button
  // waits, and comes back by itself when the server's probe gets through.
  const down = useThinkingAvailable() === false && (kind === "error" || kind === "unavailable");
  // A sent action holds the button until the row it sends replaces this
  // notice, so a second click never queues a second turn. A send that never
  // lands (no new row within the pending grace) frees it again.
  const [sent, setSent] = useState(false);
  useWatchEffect(() => {
    if (!sent) return;
    const t = window.setTimeout(() => setSent(false), PENDING_HOSTED_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [sent]);
  // A stop that later turns moved past is history: one quiet line in the
  // reply column, without the invitation to try again that no longer applies.
  const words = noticeWords(content, retries, !!action || !live);
  if (!live) {
    return (
      <div className="mx-auto conv-col px-2 sm:px-4 py-1" data-hosted-notice={kind} data-hosted-notice-past="">
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-sol-text-dim">
          <span aria-hidden className={cn("mt-[8px] h-1 w-1 shrink-0 rounded-full opacity-70", NOTICE_DOT[kind])} />
          <span className="min-w-0">{words}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto conv-col px-2 sm:px-4 py-1.5" data-hosted-notice={kind}>
      <div className={cn(
        // The dot sits on the first line, and on a phone the action takes its
        // own row under the words so the sentence keeps the card's width.
        "flex flex-wrap items-start gap-x-3 gap-y-2.5 rounded-[var(--radius,8px)] border border-sol-border bg-sol-bg-alt/60 px-3.5 py-2.5",
      )}>
        <span aria-hidden className={cn("mt-[13px] h-1.5 w-1.5 shrink-0 rounded-full", NOTICE_DOT[kind])} />
        <p className="min-w-0 flex-1 py-[5px] text-[13.5px] leading-relaxed text-sol-text-muted">
          {words}
          {kind === "budget" && !upgradesOpen && <BudgetReturn />}
        </p>
        {kind === "verify" && <EmailProofForm conversationId={conversationId} />}
        {action && (
          <div className="shrink-0 max-[479px]:basis-full max-[479px]:pl-[18px]">
          <button
            type="button"
            disabled={sent || down}
            onClick={() => { if (sent || down) return; if (action.busy) setSent(true); action.run(); }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius,8px)] border border-sol-border bg-sol-card px-3 text-[13px] font-medium text-sol-text transition-colors hover:border-sol-text-dim/50 hover:bg-sol-bg-highlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/40 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-sol-card"
          >
            <action.icon className={cn("h-3.5 w-3.5", sent && action.icon === RotateCcw && "animate-spin")} aria-hidden />
            {down ? "Back soon" : sent && action.busy ? action.busy : action.label}
          </button>
          </div>
        )}
      </div>
    </div>
  );
}

const FIELD = "h-8 rounded-[var(--radius,8px)] border border-sol-border bg-sol-card px-2.5 text-[13px] text-sol-text placeholder:text-sol-text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/40";

/** The `verify` stop's move: the mailed code, entered here, proves the
 *  address and the stopped ask picks up by itself (useEmailProof). */
function EmailProofForm({ conversationId }: { conversationId: string | undefined }) {
  const proof = useEmailProof(conversationId);
  if (proof.phase === "done") {
    return <p className="basis-full pl-[18px] text-[13px] text-sol-text-muted" data-email-proof-done>Thanks, your email is confirmed. Picking this up now.</p>;
  }
  return (
    <form
      className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2 pl-[18px]"
      onSubmit={(e) => { e.preventDefault(); void proof.submit(); }}
      data-email-proof
    >
      <input
        value={proof.code}
        onChange={(e) => proof.setCode(e.target.value)}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="6-digit code"
        maxLength={EMAIL_PROOF_DIGITS}
        aria-label="Code from the email"
        className={cn(FIELD, "w-32 font-mono tracking-[0.2em] placeholder:font-sans placeholder:tracking-normal")}
      />
      <button type="submit" disabled={!proof.ready} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius,8px)] border border-sol-border bg-sol-card px-3 text-[13px] font-medium text-sol-text transition-colors hover:bg-sol-bg-highlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/40 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-sol-card">
        {proof.phase === "checking" ? "Checking…" : "Confirm"}
      </button>
      <button type="button" onClick={() => void proof.resend()} disabled={proof.phase === "sending"} className="text-[12.5px] text-sol-text-dim underline-offset-2 hover:text-sol-text hover:underline disabled:opacity-60">
        {proof.phase === "sending" ? "Sending…" : proof.phase === "sent" ? "Sent. Check your email" : "Send a new code"}
      </button>
      {proof.error && <p className="basis-full text-[12.5px] text-sol-red" role="alert">{proof.error}</p>}
    </form>
  );
}

/** When a used-up month comes back, in the composer's own sentence. */
function BudgetReturn() {
  const { wallet, resets } = usePlanMeter(false);
  return wallet && resets ? <span className="block pt-1 text-sol-text-dim">{LANE_COPY.plan.allowanceOut(resets)} <TopUpLink /></span> : null;
}



export { approvalAnswerAddsToReceipt } from "../simple/lane";

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

export { offersMailConnect, routineOffer, type RoutineOffer } from "../../lib/hostedOffers";
import type { RoutineOffer } from "../../lib/hostedOffers";

const CHIP = "inline-flex h-8 items-center gap-1.5 rounded-[var(--radius,8px)] border border-sol-border bg-sol-card px-3 text-[13px] font-medium text-sol-text transition-colors hover:bg-sol-bg-highlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/40";

export function RoutineOfferChip({ offer, onAsk }: { offer: RoutineOffer; onAsk: (text: string) => void }) {
  return (
    <div className="-mt-3 pb-3" data-hosted-routine-offer>
      <button type="button" onClick={() => onAsk(offer.ask)} className={CHIP}>
        <Repeat className="h-3.5 w-3.5" aria-hidden />
        {offer.label}
      </button>
    </div>
  );
}

/** The button under such a reply: it opens Settings > Integrations, where
 *  the Whisk row connects. Shown only while mail is not connected and the
 *  deployment can connect it. */
export function MailConnectChip() {
  const mail = useLaneMailAbilities();
  // Offered to connect where it can work, and to reconnect a connection
  // Whisk stopped accepting (the assistant tells them to; this is the button).
  const reconnect = mail.connected && mail.needsReconnect;
  if (!mail.known || (mail.connected && !reconnect)) return null;
  if (!reconnect && mail.available === false) {
    return <div className="-mt-3 pb-3" data-hosted-mail-whisk><UseWhiskNow /></div>;
  }
  if (!reconnect && mail.available !== true) return null;
  return (
    <div className="-mt-3 pb-3" data-hosted-mail-connect>
      <button
        type="button"
        onClick={() => useInboxStore.getState().openSettingsModal("integrations")}
        className={CHIP}
      >
        <Mail className="h-3.5 w-3.5" aria-hidden />
        {reconnect ? LANE_COPY.connections.reconnect : "Connect mail and calendar"}
      </button>
    </div>
  );
}
