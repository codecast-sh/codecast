// What a hosted assistant's turn engine (plan pl-840) needs to replay a
// conversation that the message row does not carry: thinking signatures
// (message_thinking) and tool call arguments as the model wrote them, before
// redaction (message_tool_inputs). Message rows sync to every client cache and
// feed every transcript surface, so they stay redacted and unsigned; the
// engine reads these records back through `withHostedReplay` alone.
//
// A thinking signature covers the exact thinking text, so it must replay with
// it to resume a turn that thought before an approval. A tool call's raw
// arguments are what an approved call runs with, and what the person approved
// (assistant_turns.pending_call shows them): replaying the redacted form would
// run something other than what was approved.

import type { MutationCtx, QueryCtx } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";

/** The thinking fields a hosted message write carries (the harness's MessageRow names). */
export type ThinkingFields = { thinking?: string; thinking_signature?: string; thinking_redacted?: boolean };

type ToolCall = { id: string; name: string; input: string };

/** A hosted message write: thinking fields plus the tool calls as the model wrote them. */
export type HostedReplayFields = ThinkingFields & { tool_calls?: ReadonlyArray<ToolCall> };

/**
 * The thinking signature to keep with a message's thinking. A signature
 * covers the exact thinking text; when redaction changed the stored text the
 * signature no longer verifies: it is dropped, and the thinking is not
 * replayed.
 */
export function signedThinkingFields(
  msg: ThinkingFields,
  storedThinking: string | undefined,
): { thinking_signature?: string; thinking_redacted?: boolean } {
  if (!msg.thinking_signature || storedThinking !== msg.thinking) return {};
  return { thinking_signature: msg.thinking_signature, ...(msg.thinking_redacted ? { thinking_redacted: true } : {}) };
}

/** The raw arguments of each call whose stored (redacted) arguments differ, by call id. */
export function rawToolInputs(
  raw: ReadonlyArray<ToolCall>,
  stored: ReadonlyArray<ToolCall> | undefined,
): Array<{ id: string; input: string }> {
  const storedById = new Map((stored ?? []).map((call) => [call.id, call.input]));
  return raw.filter((call) => storedById.get(call.id) !== call.input).map((call) => ({ id: call.id, input: call.input }));
}

type RecordTable = "message_thinking" | "message_tool_inputs";

// Both tables key on the same by_conversation_message index; the query is
// typed through one of them because Convex cannot type an index over a union.
function recordFor<T extends RecordTable>(
  ctx: QueryCtx,
  table: T,
  conversationId: Id<"conversations">,
  messageId: Id<"messages">,
): Promise<Doc<T> | null> {
  return ctx.db
    .query(table as "message_thinking")
    .withIndex("by_conversation_message", (q) => q.eq("conversation_id", conversationId).eq("message_id", messageId))
    .first() as Promise<Doc<T> | null>;
}

/**
 * Brings one side record in step with a write: `undefined` leaves it alone
 * (the write did not touch what it covers), `null` deletes it, and fields
 * insert or patch it.
 */
async function syncRecord<T extends RecordTable>(
  ctx: MutationCtx,
  table: T,
  conversationId: Id<"conversations">,
  messageId: Id<"messages">,
  fields: Record<string, unknown> | null | undefined,
): Promise<void> {
  if (fields === undefined) return;
  const existing = await recordFor(ctx, table, conversationId, messageId);
  if (fields === null) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  if (!existing) {
    await ctx.db.insert(table, { conversation_id: conversationId, message_id: messageId, ...fields } as never);
  } else if (Object.entries(fields).some(([key, value]) => JSON.stringify((existing as Record<string, unknown>)[key]) !== JSON.stringify(value))) {
    await ctx.db.patch(existing._id, fields as never);
  }
}

/**
 * Keeps a hosted message's replay records in step with what was just stored
 * for it. A write is covered by what it carries, or by nothing:
 * - Thinking: signed by the signature it carries, or by none. New thinking
 *   without a usable signature (mid stream, or changed by redaction) clears
 *   the old one, which would no longer verify.
 * - Tool calls: the raw arguments of each call redaction changed. Calls that
 *   redaction left alone need no record.
 * A write that carries neither leaves the records alone.
 */
export async function storeHostedReplay(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  messageId: Id<"messages">,
  msg: HostedReplayFields,
  stored: { thinking: string | undefined; tool_calls: ReadonlyArray<ToolCall> | undefined },
): Promise<void> {
  const signed = signedThinkingFields(msg, stored.thinking);
  const thinking = signed.thinking_signature
    ? { signature: signed.thinking_signature, redacted: signed.thinking_redacted }
    : msg.thinking === undefined ? undefined : null;
  await syncRecord(ctx, "message_thinking", conversationId, messageId, thinking);

  const inputs = msg.tool_calls ? rawToolInputs(msg.tool_calls, stored.tool_calls) : undefined;
  await syncRecord(ctx, "message_tool_inputs", conversationId, messageId, inputs === undefined ? undefined : inputs.length > 0 ? { inputs } : null);
}

/**
 * Message rows as the turn engine replays them: assistant rows get their
 * thinking signatures (`thinking_signature`, `thinking_redacted`, the fields
 * the harness's history conversion reads) and their tool calls' raw
 * arguments back. The turn engine loads a hosted conversation's history
 * through this; client reads never do.
 */
export async function withHostedReplay<T extends Doc<"messages">>(
  ctx: QueryCtx,
  rows: readonly T[],
): Promise<Array<T & Pick<ThinkingFields, "thinking_signature" | "thinking_redacted">>> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.role !== "assistant") return row;
      const [thinking, toolInputs] = await Promise.all([
        recordFor(ctx, "message_thinking", row.conversation_id, row._id),
        row.tool_calls?.length ? recordFor(ctx, "message_tool_inputs", row.conversation_id, row._id) : null,
      ]);
      if (!thinking && !toolInputs) return row;
      const raw = new Map((toolInputs?.inputs ?? []).map((entry) => [entry.id, entry.input]));
      return {
        ...row,
        ...(thinking ? { thinking_signature: thinking.signature, ...(thinking.redacted ? { thinking_redacted: true } : {}) } : {}),
        ...(raw.size > 0 && row.tool_calls
          ? { tool_calls: row.tool_calls.map((call) => (raw.has(call.id) ? { ...call, input: raw.get(call.id)! } : call)) }
          : {}),
      };
    }),
  );
}
