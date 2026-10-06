// Which review notes an agent's reply answers. A batch of notes reaches a
// session as one message (reviewNotes.sendNotesToSession); when the agent
// replies, a note counts as answered when the reply
//
//   1. quotes it: the note's words appear in the reply, or a quoted line of
//      the reply (`> …`) is a stretch of the note;
//   2. names its place: `path:line` (or a range) with the note's file and a
//      line inside the note's lines;
//   3. answers its message: the reply follows the very message that carried
//      the batch, and that batch was this one note. With several notes the
//      parent link alone cannot say which one was answered, so it needs (1)
//      or (2).
//
// Deterministic on purpose: no model call decides this.

import type { Doc, Id } from "../_generated/dataModel";

export type SentNote = {
  id: string;
  content: string;
  file_path?: string;
  line_number?: number;
  line_end?: number;
  sent_client_id?: string;
};

export type AnswerReason = "quote" | "place" | "parent";

/** Shortest note text (normalized) a verbatim quote must cover to count. */
const MIN_QUOTE_CHARS = 12;

const normalize = (text: string) => text.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();

function quotes(note: SentNote, reply: string, replyNorm: string): boolean {
  const body = normalize(note.content);
  if (body.length >= MIN_QUOTE_CHARS && replyNorm.includes(body)) return true;
  for (const line of reply.split("\n")) {
    const m = line.match(/^\s*>+\s?(.*)$/);
    if (!m) continue;
    const quoted = normalize(m[1]);
    if (quoted.length >= MIN_QUOTE_CHARS && body.includes(quoted)) return true;
  }
  return false;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function namesPlace(note: SentNote, reply: string): boolean {
  if (!note.file_path || note.line_number === undefined) return false;
  const base = note.file_path.split("/").pop()!;
  const first = note.line_number;
  const last = note.line_end ?? note.line_number;
  // `src/a.ts:42`, `a.ts:40-44`, `a.ts#L42`, any directory prefix or none.
  const pattern = new RegExp(`(?:^|[^\\w.-])(?:[\\w.@-]+/)*${escape(base)}(?::|#L)(\\d+)(?:[-–](?:L)?(\\d+))?`, "g");
  for (const m of reply.matchAll(pattern)) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from <= last && to >= first) return true;
  }
  return false;
}

/**
 * The notes `reply` answers and why. `parentClientId` is the client_id of the
 * user message the reply follows; `batchSizes` counts the notes each
 * sent_client_id carried.
 */
export function answeredNotes(
  notes: SentNote[],
  reply: { content: string; parentClientId?: string | null },
  batchSizes: Map<string, number>,
): Array<{ id: string; reason: AnswerReason }> {
  const replyNorm = normalize(reply.content);
  const out: Array<{ id: string; reason: AnswerReason }> = [];
  for (const note of notes) {
    const reason: AnswerReason | null = quotes(note, reply.content, replyNorm)
      ? "quote"
      : namesPlace(note, reply.content)
        ? "place"
        : note.sent_client_id && note.sent_client_id === reply.parentClientId && batchSizes.get(note.sent_client_id) === 1
          ? "parent"
          : null;
    if (reason) out.push({ id: note.id, reason });
  }
  return out;
}

/**
 * Called as an assistant message lands: stamp the session's sent, unanswered
 * notes that this reply answers. One index read when nothing is waiting,
 * which is nearly always.
 */
export async function markAnsweredReviewNotes(
  ctx: any,
  conversationId: Id<"conversations">,
  message: { _id: Id<"messages">; content?: string; timestamp: number },
): Promise<void> {
  if (!message.content?.trim()) return;
  const waiting: Doc<"review_comments">[] = await ctx.db
    .query("review_comments")
    .withIndex("by_sent_conversation_answered", (q: any) =>
      q.eq("sent_to_conversation_id", conversationId).eq("answered_at", undefined))
    .take(200);
  const candidates = waiting.filter((n) => n.sent_at !== undefined && n.sent_at <= message.timestamp);
  if (candidates.length === 0) return;

  const parent = await ctx.db
    .query("messages")
    .withIndex("by_conversation_role_timestamp", (q: any) =>
      q.eq("conversation_id", conversationId).eq("role", "user").lt("timestamp", message.timestamp))
    .order("desc")
    .first();
  // The parent rule needs the whole batch's size, answered notes included,
  // and only when a waiting note came in the message the reply follows.
  const batchSizes = new Map<string, number>();
  const parentClientId: string | undefined = parent?.client_id;
  if (parentClientId && candidates.some((n) => n.sent_client_id === parentClientId)) {
    const sent: Doc<"review_comments">[] = await ctx.db
      .query("review_comments")
      .withIndex("by_sent_conversation_answered", (q: any) => q.eq("sent_to_conversation_id", conversationId))
      .take(1000);
    batchSizes.set(parentClientId, sent.filter((n) => n.sent_client_id === parentClientId).length);
  }

  const answered = answeredNotes(
    candidates.map((n) => ({
      id: n._id,
      content: n.content,
      file_path: n.file_path,
      line_number: n.line_number,
      line_end: n.line_end,
      sent_client_id: n.sent_client_id,
    })),
    { content: message.content, parentClientId },
    batchSizes,
  );
  const now = Date.now();
  for (const { id } of answered) {
    await ctx.db.patch(id as Id<"review_comments">, { answered_message_id: message._id, answered_at: now });
  }
}
