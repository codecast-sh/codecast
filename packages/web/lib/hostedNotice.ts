// Reading a hosted turn's stop notice (plan pl-840) from transcript rows: the
// engine's typed notice (NOTICE_KINDS in contracts/assistant), its tone, and
// how an inbox row names a conversation that ended on one. A leaf, so the
// pure row view and the transcript read one rule.
import { noticeKindOf, type NoticeKind } from "@codecast/shared/contracts/assistant";

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

/** The kind of notice a conversation's transcript ends on, or null when it
 *  ends on anything else. The inbox row reads it to say the turn stopped. */
export function lastNoticeKind(messages: readonly { role?: string; subtype?: string | null; message_uuid?: string | null; content?: string | null }[] | undefined): NoticeKind | null {
  const last = messages?.[messages.length - 1];
  return last?.role === "assistant" ? hostedNoticeKind(last) : null;
}

/** How an inbox row names a conversation that stopped on a notice. */
export const NOTICE_ROW_WORD: Record<NoticeKind, string> = {
  error: "Stopped",
  unavailable: "Will retry",
  budget: "Stopped",
  time: "Paused",
  safety: "Stopped",
};

/** The dot's tone: a stop the person can fix reads warm, a wait reads calm. */
export const NOTICE_DOT: Record<NoticeKind, string> = {
  error: "bg-sol-red/70",
  unavailable: "bg-sol-yellow",
  budget: "bg-sol-orange",
  time: "bg-sol-blue/70",
  safety: "bg-sol-red/70",
};

