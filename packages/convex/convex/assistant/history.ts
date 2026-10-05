// A hosted conversation's transcript as the turn engine reads and writes it
// (plan pl-840, docs/architecture/hosted-assistant.md "The turn"). The
// messages table is the one home of the conversation: the run reads its rows
// back through withHostedReplay (thinking signatures and raw tool arguments,
// which client reads never see) and writes every row it makes through the same
// batch writer the daemons use, so the transcript, previews, usage rollup and
// pending echo settle behave as for any session.
import { MESSAGE_ROW_FIELDS, type MessageRow } from "@platform/agent";
import type { MutationCtx, QueryCtx } from "../functions";
import type { Id } from "../_generated/dataModel";
import { withHostedReplay } from "../hostedReplay";
import { writeMessageBatch, type MessageBatch } from "../messages";

/** The newest rows a run replays. The harness shapes what the model reads
 *  (prepareContext); this bounds what one action loads and returns. */
export const HISTORY_MAX_ROWS = 200;

/** A row the batch writer accepts. */
export type StoredRow = MessageBatch["messages"][number];

const ROW_FIELDS = new Set<string>(MESSAGE_ROW_FIELDS);

/** A messages row as the harness reads it: only the fields a MessageRow
 *  carries, with no undefined values (a Convex value cannot hold one).
 *  Images without bytes are left out; the harness cannot send a storage id. */
export function toMessageRow(doc: Record<string, unknown>): MessageRow {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined || value === null || !ROW_FIELDS.has(key)) continue;
    row[key] = value;
  }
  if (Array.isArray(row.images)) {
    const images = (row.images as Array<Record<string, unknown>>)
      .filter((image) => typeof image.data === "string")
      .map((image) => ({ media_type: image.media_type, data: image.data, ...(image.tool_use_id ? { tool_use_id: image.tool_use_id } : {}) }));
    if (images.length > 0) row.images = images;
    else delete row.images;
  }
  return row as unknown as MessageRow;
}

/** A harness row in the batch writer's shape: tool call arguments as JSON
 *  text, and nothing the writer does not take. */
export function toStoredRow(row: MessageRow): StoredRow {
  const stored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || !ROW_FIELDS.has(key)) continue;
    stored[key] = value;
  }
  if (row.tool_calls) {
    stored.tool_calls = row.tool_calls.map((call) => ({
      id: call.id,
      name: call.name,
      input: typeof call.input === "string" ? call.input : JSON.stringify(call.input),
    }));
  }
  return stored as StoredRow;
}

/** True when a row is something the model wrote that people can read or the
 *  model can continue from. A model call that failed before it wrote anything
 *  arrives as an empty assistant row: it is charged, never stored, so the
 *  transcript shows no empty bubble. */
export function isStorableRow(row: MessageRow): boolean {
  if (row.role !== "assistant") return true;
  return !!(row.content?.trim() || row.thinking?.trim() || row.tool_calls?.length);
}

/** A person's words (or a routine's frame): a user row that carries text and
 *  answers no tool call. The harness reads such a row as the person speaking. */
export function isPersonRow(row: MessageRow): boolean {
  return row.role === "user" && !row.tool_results?.length && !!row.content?.trim();
}

/** The conversation's newest rows, oldest first, as the run replays them. The
 *  slice starts at the person's words, so it never opens on a tool result
 *  whose call fell outside it or on the model speaking first. */
export async function loadHistory(ctx: QueryCtx, conversationId: Id<"conversations">): Promise<MessageRow[]> {
  const newest = await ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conversationId))
    .order("desc")
    .take(HISTORY_MAX_ROWS);
  const replayed = await withHostedReplay(ctx, newest.reverse());
  const rows = replayed.map((doc) => toMessageRow(doc as unknown as Record<string, unknown>));
  const start = rows.findIndex(isPersonRow);
  return start < 0 ? [] : rows.slice(start);
}

/** Writes rows into a hosted conversation's transcript through the batch
 *  writer every session uses (messages.writeMessageBatch), with all its side
 *  effects. Reads the conversation fresh, since the writer patches its counts.
 *  False when the conversation is gone (deleted while a turn ran): there is
 *  nothing to write into, and the caller still has to end its turn and settle
 *  the wallet in the same mutation, so this never throws for it. */
export async function writeRows(ctx: MutationCtx, conversationId: Id<"conversations">, rows: StoredRow[]): Promise<boolean> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return false;
  if (rows.length > 0) await writeMessageBatch(ctx, conversation, { conversation_id: conversationId, messages: rows });
  return true;
}

/** One plain line from the assistant: a notice the person reads (why a turn
 *  stopped), keyed so a repeated write lands on the same row. */
export async function writeNotice(ctx: MutationCtx, conversationId: Id<"conversations">, key: string, text: string): Promise<boolean> {
  return await writeRows(ctx, conversationId, [{ role: "assistant", message_uuid: `notice:${key}`, content: text, timestamp: Date.now() }]);
}

export interface CallRef {
  id: string;
  name: string;
  input: string | Record<string, unknown>;
}

/** Tool calls in the rows that no tool result answers, in order. */
export function unansweredCalls(rows: readonly MessageRow[]): CallRef[] {
  const answered = new Set<string>();
  for (const row of rows) for (const result of row.tool_results ?? []) answered.add(result.tool_use_id);
  const open: CallRef[] = [];
  for (const row of rows) {
    if (row.role !== "assistant") continue;
    for (const call of row.tool_calls ?? []) if (!answered.has(call.id)) open.push(call);
  }
  return open;
}

/**
 * Unanswered calls the harness will not reach on its own. It answers the
 * open calls of the model's last message when nobody spoke after it (a run
 * woken again, or one that died before storing its results). Any other open
 * call (on an earlier message, or with the person's words after it) would
 * reach the model as a call with no result, which the API refuses, so the
 * engine answers it as not run.
 */
export function strandedCalls(rows: readonly MessageRow[]): CallRef[] {
  let last = rows.length - 1;
  while (last >= 0 && rows[last].role !== "assistant") last--;
  const recoverable = new Set<string>();
  if (last >= 0 && !rows.slice(last + 1).some(isPersonRow)) {
    for (const call of rows[last].tool_calls ?? []) recoverable.add(call.id);
  }
  return unansweredCalls(rows).filter((call) => !recoverable.has(call.id));
}
