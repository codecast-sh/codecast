// A hosted conversation's composer at rest, said from where its last exchange
// stands: the web's MessageInput and the phone's session screen read this one
// rule, so the two say the same thing after the same turn.
import { replyAsksPerson } from "@codecast/shared/contracts/assistant";
import type { SessionDecisionItem } from "../store/inboxStore";
import { hostedDeclinedSince } from "./decisionQueue";
import { hostedNoticeKind } from "./hostedNotice";

/** The last exchange: the assistant asked the person something, answered,
 *  stopped on a notice; or the person's message is the last word, after
 *  saying no to one of its approvals or not. Null for an empty conversation. */
export type HostedLast = "asked" | "answered" | "declined" | "stopped" | "sent" | null;

type Row = { role?: string; content?: string | null; timestamp?: number; subtype?: string | null; message_uuid?: string | null };

/** A no invites a change only for DECLINE_HINT_MS (hostedDeclinedSince with
 *  `now`), so a cold revisit reads as an answered conversation rather than an
 *  ask still pending. */
export function hostedLastExchange(
  rows: readonly Row[] | undefined,
  decisions: Record<string, SessionDecisionItem> | undefined,
  conversationId: string,
  now: number,
): HostedLast {
  const list = rows ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const row = list[i];
    if (row?.role === "assistant" && row.content?.trim()) {
      const notice = hostedNoticeKind(row);
      if (notice === "error" || notice === "unavailable") return "stopped";
      return replyAsksPerson(row.content) ? "asked" : "answered";
    }
    if (row?.role === "user" && row.content?.trim()) {
      return hostedDeclinedSince(decisions, conversationId, row.timestamp ?? 0, now) ? "declined" : "sent";
    }
  }
  return null;
}

/** The composer's resting words for that exchange: an open card is answered
 *  above, a question gets a reply, a no invites a change, a stop points at
 *  its own Try again, and an empty conversation invites a new chore. */
export function hostedComposerWords(last: HostedLast, awaitsOk: boolean): string {
  if (awaitsOk) return "Answer the card above, or tell me what to change";
  if (last === "asked") return "Reply…";
  if (last === "declined") return "Tell me what to change";
  // The stop notice carries its own Try again, so this offers the other way on.
  if (last === "stopped") return "Or ask something else";
  return last ? "Reply, or ask a follow-up" : "Ask anything, or hand me a chore";
}
