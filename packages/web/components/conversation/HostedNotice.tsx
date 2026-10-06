// Why a hosted turn stopped short of an answer (plan pl-840): the engine's
// typed notice (NOTICE_KINDS in contracts/assistant) drawn as one calm block
// with the one thing the person can do about it. The sentence is the
// engine's own; the action comes from its kind. Only the conversation's last
// notice offers an action: once anything follows it, the moment has passed.
import { RotateCcw, ArrowRight, Mail } from "lucide-react";
import { APPROVAL_ANSWERS, noticeKindOf, type NoticeKind } from "@codecast/shared/contracts/assistant";
import { cn } from "@/lib/utils";
import { sendToSession } from "../../lib/sendToSession";
import { useInboxStore } from "../../store/inboxStore";
import { useLaneMailAbilities } from "../simple/useLaneMail";

/** The notice kind of a transcript row, or null for any other row. A notice
 *  the engine wrote before notices were typed is known by its key
 *  (`notice:<turn>`) and read by its words. */
export function hostedNoticeKind(row: { subtype?: string | null; message_uuid?: string | null; content?: string | null }): NoticeKind | null {
  const typed = noticeKindOf(row.subtype);
  if (typed) return typed;
  if (!row.message_uuid?.startsWith("notice:")) return null;
  const text = row.content ?? "";
  if (/usage included|most I spend/i.test(text)) return "budget";
  if (/taking longer/i.test(text)) return "time";
  if (/safety check/i.test(text)) return "safety";
  return "error";
}

/** What the person types for them when they press the notice's action. */
const KEEP_GOING = "Keep going";

type NoticeAction = { label: string; icon: typeof RotateCcw; run: () => void };

function actionFor(kind: NoticeKind, conversationId: string | undefined, retryText: string | undefined): NoticeAction | null {
  if (!conversationId) return null;
  switch (kind) {
    case "error":
    case "unavailable":
      return retryText ? { label: kind === "unavailable" ? "Try now" : "Try again", icon: RotateCcw, run: () => sendToSession(conversationId, retryText) } : null;
    case "time":
      return { label: KEEP_GOING, icon: ArrowRight, run: () => sendToSession(conversationId, KEEP_GOING) };
    case "budget":
      return { label: "Open Plan", icon: ArrowRight, run: () => useInboxStore.getState().openSettingsModal("plan") };
    case "safety":
      return null;
  }
}

/** The dot's tone: a stop the person can fix reads warm, a wait reads calm. */
const DOT: Record<NoticeKind, string> = {
  error: "bg-sol-red/70",
  unavailable: "bg-sol-yellow",
  budget: "bg-sol-orange",
  time: "bg-sol-blue/70",
  safety: "bg-sol-red/70",
};

export function HostedNotice({ kind, content, conversationId, retryText, live }: {
  kind: NoticeKind;
  content: string;
  conversationId: string | undefined;
  /** The person's last words, which Try again sends again. */
  retryText?: string;
  /** Whether this is the conversation's last row, so its action still applies. */
  live: boolean;
}) {
  const action = live ? actionFor(kind, conversationId, retryText) : null;
  return (
    <div className="mx-auto conv-col px-2 sm:px-4 py-1.5" data-hosted-notice={kind}>
      <div className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius,8px)] border border-sol-border bg-sol-bg-alt/60 px-3.5 py-2.5",
        !live && "opacity-70",
      )}>
        <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[kind])} />
        <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-sol-text-muted">{content}</p>
        {action && (
          <button
            type="button"
            onClick={action.run}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius,8px)] border border-sol-border bg-sol-card px-3 text-[13px] font-medium text-sol-text transition-colors hover:border-sol-text-dim/50 hover:bg-sol-bg-highlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/40"
          >
            <action.icon className="h-3.5 w-3.5" aria-hidden />
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** What the person answered an approval, as a receipt says it. */
export function approvalAnswerWords(answer: string): string {
  if (answer === APPROVAL_ANSWERS.approve) return "You said yes";
  if (answer === APPROVAL_ANSWERS.always) return "You said yes, and not to ask again";
  if (answer === APPROVAL_ANSWERS.decline) return "You said no";
  return `You said: “${answer}”`;
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
