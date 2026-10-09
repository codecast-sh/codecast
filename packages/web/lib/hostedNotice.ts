// Reading a hosted turn's stop notice (plan pl-840) from transcript rows: the
// engine's typed notice (NOTICE_KINDS in contracts/assistant), its tone, and
// how an inbox row names a conversation that ended on one. A leaf, so the
// pure row view and the transcript read one rule.
import { APPROVAL_ANSWERS, NOTICE_KINDS, noticeKindOf, type NoticeKind } from "@codecast/shared/contracts/assistant";
import { isHostedAgentType } from "@codecast/shared/contracts";

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

type NoticeRow = { role?: string; subtype?: string | null; message_uuid?: string | null; content?: string | null };

/** A hosted conversation row as the stop rule reads it: its agent, and the
 *  stop the engine stamped on it (conversations.hosted_stop). */
type StopRow = { agent_type?: string | null; hosted_stop?: string | null };
const stopsSigCache = new WeakMap<object, WeakMap<object, string>>();

/** The stop a hosted conversation ended on, or null: for any other agent, or
 *  one whose last turn ended on anything else. The row's own stamp
 *  (conversations.hosted_stop, written as the turn stops and cleared when the
 *  next starts) decides, so the answer holds whether or not the transcript is
 *  loaded; a row from before the stamp falls back to the transcript. The
 *  inbox files such a row under "Couldn't finish" rather than the person's
 *  turn, and keeps it out of the needs-input count: the assistant failed
 *  them, they owe no reply. */
export function hostedStopOf(row: StopRow | undefined, messages: readonly NoticeRow[] | undefined): NoticeKind | null {
  if (!row || !isHostedAgentType(row.agent_type)) return null;
  if (row.hosted_stop !== undefined) {
    return (NOTICE_KINDS as readonly string[]).includes(row.hosted_stop ?? "") ? (row.hosted_stop as NoticeKind) : null;
  }
  return lastNoticeKind(messages);
}

/** `rows` split into the person's real turns and the hosted conversations
 *  that ended on a stop. One rule for the inbox section and the badge. */
export function splitHostedStops<T extends { _id: string } & StopRow>(
  rows: readonly T[],
  messagesOf: (id: string) => readonly NoticeRow[] | undefined,
): { asks: T[]; stopped: T[] } {
  const asks: T[] = [];
  const stopped: T[] = [];
  for (const row of rows) (hostedStopOf(row, messagesOf(row._id)) ? stopped : asks).push(row);
  return { asks, stopped };
}

/** A wake signature for which hosted conversations end on a stop, so a view
 *  that splits them re-renders when a stop lands or clears, and not on every
 *  streamed message. */
export function hostedStopsSig(
  sessions: Record<string, StopRow>,
  messages: Record<string, readonly NoticeRow[] | undefined>,
): string {
  let byMessages = stopsSigCache.get(sessions);
  const cached = byMessages?.get(messages);
  if (cached !== undefined) return cached;
  let sig = "";
  for (const id in sessions) {
    const kind = hostedStopOf(sessions[id], messages[id]);
    if (kind) sig += `${id}:${kind},`;
  }
  if (!byMessages) {
    byMessages = new WeakMap();
    stopsSigCache.set(sessions, byMessages);
  }
  byMessages.set(messages, sig);
  return sig;
}

const ANSWER_WORDS = new Set<string>(Object.values(APPROVAL_ANSWERS));

/** The person's last request in a hosted transcript, which Try again sends
 *  again: their last own words, passing over approval answers and wrapped
 *  system rows. */
export function lastAskOf(messages: readonly NoticeRow[] | undefined): string | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages![i];
    if (m.role !== "user") continue;
    const text = m.content?.trim();
    if (!text || text.startsWith("<") || ANSWER_WORDS.has(text)) continue;
    return text;
  }
  return undefined;
}

/** How an inbox row names a conversation that stopped on a notice. */
export const NOTICE_ROW_WORD: Record<NoticeKind, string> = {
  error: "Stopped",
  unavailable: "Will retry",
  budget: "Stopped",
  time: "Paused",
  safety: "Stopped",
  verify: "Confirm email",
  limit: "Stopped",
};

/** The notice card's tone: a stop the person can fix reads warm, a wait
 *  reads calm. Named by palette colour so the web (NOTICE_DOT) and the phone
 *  draw the same dot. */
export const NOTICE_TONE: Record<NoticeKind, "red" | "yellow" | "orange" | "blue"> = {
  error: "red",
  unavailable: "yellow",
  budget: "orange",
  time: "blue",
  safety: "red",
  verify: "blue",
  limit: "orange",
};

const TONE_DOT = { red: "bg-sol-red/70", yellow: "bg-sol-yellow", orange: "bg-sol-orange", blue: "bg-sol-blue/70" } as const;

/** The notice card's dot on the web, from its tone. */
export const NOTICE_DOT = Object.fromEntries(
  Object.entries(NOTICE_TONE).map(([kind, tone]) => [kind, TONE_DOT[tone]]),
) as Record<NoticeKind, string>;

/** What the person types for them when they press a paused turn's action. */
export const KEEP_GOING = "Keep going";

/** The one thing a person can do about a stop, by its kind, as words: the
 *  button's label, what it says while the sent turn lands, and either the
 *  words it sends into the conversation or that it opens the plan. The web's
 *  notice and bulk retry (HostedNotice actionFor) and the phone's notice
 *  (components/hosted/Notice) both read it, so the three never disagree. */
export type NoticeMove = { label: string; busy?: string; send?: string; opensPlan?: true };

export function noticeMove(kind: NoticeKind, retryText: string | undefined, upgradesOpen: boolean): NoticeMove | null {
  switch (kind) {
    case "error":
    case "unavailable":
      return retryText ? { label: kind === "unavailable" ? "Try now" : "Try again", busy: "Trying again…", send: retryText } : null;
    case "time":
      return { label: KEEP_GOING, busy: "Going on…", send: KEEP_GOING };
    case "budget":
    case "limit":
      // Until a plan can be bought, Plan has nothing to offer: the notice says
      // when the allowance comes back instead.
      return upgradesOpen ? { label: "Open Plan", opensPlan: true } : null;
    case "safety":
      return null;
    case "verify":
      // Its move is the code field under the words (EmailProofForm), not a button.
      return null;
  }
}

/** A notice's sentence as drawn. Beside a button, or on a stop later turns
 *  moved past, the engine's closing invitation to ask again no longer says
 *  anything (`dropInvite`), so it goes; a stop that repeated is one line
 *  with the count. */
export function noticeWords(content: string, retries: number, dropInvite: boolean): string {
  if (retries > 0) return `Still can't get through after ${retries + 1} tries. The trouble is on our side, not yours.`;
  return dropInvite ? content.replace(/\s*You can ask me to try again\.?\s*$/i, "") : content;
}

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
