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

/** The notice card's dot: a stop the person can fix reads warm, a wait
 *  reads calm. */
export const NOTICE_DOT: Record<NoticeKind, string> = {
  error: "bg-sol-red/70",
  unavailable: "bg-sol-yellow",
  budget: "bg-sol-orange",
  time: "bg-sol-blue/70",
  safety: "bg-sol-red/70",
};

/** The word's tone on an inbox row: a stop the person has to act on reads
 *  in the danger ink, a wait in the muted ink. No dot: the word says it. */
export const NOTICE_TONE: Record<NoticeKind, string> = {
  error: "text-sol-red",
  unavailable: "text-sol-text-muted",
  budget: "text-sol-red",
  time: "text-sol-text-muted",
  safety: "text-sol-red",
};

/** A transcript row as the retry fold reads it. `person` marks a user row
 *  that holds the person's own words; other user rows (tool results, slash
 *  commands, wakes) are passed over. */
export type RetryFoldRow = {
  _id: string;
  role?: string;
  content?: string | null;
  subtype?: string | null;
  message_uuid?: string | null;
  person?: boolean;
};

/** How a hosted transcript folds its failed attempts into one turn. A turn
 *  that failed and was tried again, by the person's Try again (the same words
 *  sent again) or by the engine (a second notice with nothing between), shows
 *  as one notice that counts the attempts. `hidden` holds the earlier notices
 *  and the repeated requests; `attempts` the count for each notice still
 *  shown. One pass decides both, so a request and the notice it answered
 *  always fold together. */
export function foldHostedRetries(rows: readonly RetryFoldRow[]): { hidden: Set<string>; attempts: Map<string, number> } {
  const hidden = new Set<string>();
  const attempts = new Map<string, number>();
  let asked: string | undefined;
  // The failure the transcript is still on: the shown notice (null once a
  // retry folded it) and how many attempts it has counted.
  let open = null as { noticeId: string | null; attempts: number } | null;
  for (const row of rows) {
    if (row.role === "user") {
      if (!row.person) continue;
      const text = row.content?.trim();
      if (!text) continue;
      if (open && text === asked) {
        hidden.add(row._id);
        if (open.noticeId) hidden.add(open.noticeId);
        open = { noticeId: null, attempts: open.attempts };
        continue;
      }
      asked = text;
      open = null;
      continue;
    }
    if (row.role !== "assistant") continue;
    const kind = hostedNoticeKind(row);
    if (kind === "error" || kind === "unavailable") {
      if (open?.noticeId) hidden.add(open.noticeId);
      const count: number = (open?.attempts ?? 0) + 1;
      attempts.set(row._id, count);
      open = { noticeId: row._id, attempts: count };
      continue;
    }
    open = null;
  }
  return { hidden, attempts };
}
