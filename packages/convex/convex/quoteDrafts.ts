// Composer quotes as review_comments rows (ct-70914).
//
// A person reviewing an agent's reply quotes blocks of it into their
// composer's batch (web lib/reviewActions), and the batch rides their next
// message as blockquotes. The batch stays the composer's own state; each item
// also has a twin here, keyed by its id (`client_id`), so once the message goes
// the quote has a record: when it was sent, in which message, and whether the
// agent's reply answered it (lib/reviewAnswered, through the same `sent_*` /
// `answered_*` stamps a `cast review` note carries).
//
// The rows are their author's alone (codeComments.canAccessComment), and every
// other reader of review_comments skips them (lib/quoteRows). A send stamps
// them in the same mutation that queues the message (stampQuotesSent, called
// from pendingMessages.sendMessageV2 and the dispatch send).

import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { canAccessConversation } from "./lib/access";
import { proseAnchorValidator } from "./lib/proseAnchorValidator";
import { isQuoteRow } from "./lib/quoteRows";
import { sessionWaiting } from "./lib/sendOutcome";
import { deliveredOutcome, PROSE_ANCHOR_MAX_CHARS, type SendOutcome } from "@codecast/shared/comments";

/** Most quotes one save or send carries; a batch is a handful. */
export const MAX_QUOTES_PER_CALL = 100;
const MAX_NOTE_CHARS = 20_000;

export const quoteDraftValidator = v.object({
  client_id: v.string(),
  message_id: v.optional(v.string()),
  block_index: v.number(),
  quote: v.string(),
  body: v.string(),
  verdict: v.optional(v.union(v.literal("approve"), v.literal("cut"))),
  created_at: v.optional(v.number()),
});

type QuoteDraftInput = {
  client_id: string;
  message_id?: string;
  block_index: number;
  quote: string;
  body: string;
  verdict?: "approve" | "cut";
  created_at?: number;
};

type Ctx = { db: any };

/**
 * Batch items from the web's dispatch rail, which carries no validator: keep
 * the well formed ones in the shape `quoteDraftValidator` describes.
 */
export function parseQuoteDrafts(raw: unknown): QuoteDraftInput[] {
  if (!Array.isArray(raw)) return [];
  const out: QuoteDraftInput[] = [];
  for (const item of raw.slice(0, MAX_QUOTES_PER_CALL)) {
    const d = item as Record<string, unknown> | null;
    if (!d || typeof d.client_id !== "string" || !d.client_id || typeof d.block_index !== "number" || !Number.isFinite(d.block_index)) continue;
    out.push({
      client_id: d.client_id,
      ...(typeof d.message_id === "string" ? { message_id: d.message_id } : {}),
      block_index: d.block_index,
      quote: typeof d.quote === "string" ? d.quote : "",
      body: typeof d.body === "string" ? d.body : "",
      ...(d.verdict === "approve" || d.verdict === "cut" ? { verdict: d.verdict } : {}),
      ...(typeof d.created_at === "number" ? { created_at: d.created_at } : {}),
    });
  }
  return out;
}

/** The caller's quote row with this batch item id, if any. */
async function ownQuote(ctx: Ctx, userId: Id<"users">, clientId: string): Promise<Doc<"review_comments"> | null> {
  const rows: Doc<"review_comments">[] = await ctx.db
    .query("review_comments")
    .withIndex("by_author_client_id", (q: any) => q.eq("author_user_id", userId).eq("client_id", clientId))
    .collect();
  return rows.find(isQuoteRow) ?? null;
}

/** The message id when it names a message of this conversation, else undefined. */
async function messageIn(ctx: Ctx, conversationId: Id<"conversations">, messageId?: string): Promise<Id<"messages"> | undefined> {
  if (!messageId) return undefined;
  const id = ctx.db.normalizeId("messages", messageId);
  if (!id) return undefined;
  const message = await ctx.db.get(id);
  return message && String(message.conversation_id) === String(conversationId) ? id : undefined;
}

/**
 * Write the caller's quotes on one conversation, each created or updated by
 * its batch item id. A quote already sent is a record and stays as it was
 * sent; a save that arrives after the send (a replayed write) changes nothing.
 */
export async function saveQuotes(
  ctx: Ctx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  drafts: QuoteDraftInput[],
): Promise<{ saved: number }> {
  if (drafts.length > MAX_QUOTES_PER_CALL) throw new Error(`At most ${MAX_QUOTES_PER_CALL} quotes per save`);
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) throw new Error("Conversation not found");
  const now = Date.now();
  let saved = 0;
  for (const draft of drafts) {
    const fields = {
      message_id: await messageIn(ctx, conversationId, draft.message_id),
      block_index: draft.block_index,
      prose_anchor: { text: draft.quote.slice(0, PROSE_ANCHOR_MAX_CHARS), index: draft.block_index },
      verdict: draft.verdict,
      content: draft.body.slice(0, MAX_NOTE_CHARS),
    };
    const existing = await ownQuote(ctx, userId, draft.client_id);
    if (existing) {
      if (existing.sent_at !== undefined || String(existing.conversation_id) !== String(conversationId)) continue;
      await ctx.db.patch(existing._id, { ...fields, updated_at: now });
    } else {
      await ctx.db.insert("review_comments", {
        ...fields,
        origin: "quote",
        conversation_id: conversationId,
        client_id: draft.client_id,
        author_user_id: userId,
        author_kind: "user",
        resolved: false,
        created_at: draft.created_at ?? now,
      });
    }
    saved++;
  }
  return { saved };
}

/** Drop the caller's unsent quotes by batch item id. Sent ones are records and stay. */
export async function removeQuotes(ctx: Ctx, userId: Id<"users">, clientIds: string[]): Promise<{ removed: number }> {
  if (clientIds.length > MAX_QUOTES_PER_CALL) throw new Error(`At most ${MAX_QUOTES_PER_CALL} quotes per remove`);
  let removed = 0;
  for (const clientId of clientIds) {
    const row = await ownQuote(ctx, userId, clientId);
    if (!row || row.sent_at !== undefined) continue;
    await ctx.db.delete(row._id);
    removed++;
  }
  return { removed };
}

/**
 * Stamp the quotes that rode a message just queued into `conversation` under
 * `messageClientId`. Called inside the mutation that queued it, so a quote is
 * marked sent exactly when its message is. Ids that name no unsent quote of
 * the caller's are skipped, and a replay of the same send is a no-op that
 * still reports the quotes it carried. `waiting` is read before the enqueue.
 */
export async function stampQuotesSent(
  ctx: Ctx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  messageClientId: string,
  quoteClientIds: string[],
  waiting: Awaited<ReturnType<typeof sessionWaiting>>,
): Promise<SendOutcome> {
  const now = Date.now();
  const sent: string[] = [];
  for (const clientId of quoteClientIds.slice(0, MAX_QUOTES_PER_CALL)) {
    const row = await ownQuote(ctx, userId, clientId);
    if (!row) continue;
    if (row.sent_at === undefined) {
      await ctx.db.patch(row._id, { sent_at: now, sent_to_conversation_id: conversationId, sent_client_id: messageClientId });
    } else if (row.sent_client_id !== messageClientId) {
      continue;
    }
    sent.push(String(row._id));
  }
  return deliveredOutcome(sent, waiting);
}

/** Queue-time half of a send carrying quotes: read the session's state before the enqueue changes it. */
export async function quotesWaiting(ctx: Ctx, conversationId: Id<"conversations">, quoteClientIds?: string[]) {
  return quoteClientIds?.length ? await sessionWaiting(ctx, conversationId) : null;
}

export const save = mutation({
  args: {
    conversation_id: v.id("conversations"),
    drafts: v.array(quoteDraftValidator),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return await saveQuotes(ctx, userId, args.conversation_id, args.drafts);
  },
});

export const remove = mutation({
  args: { client_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return await removeQuotes(ctx, userId, args.client_ids);
  },
});

/**
 * The caller's quotes on one conversation, drafts and sent, oldest first: what
 * the composer's review rail reads to show a quote as sent, then answered.
 */
export const listForConversation = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) return [];
    const rows = await ctx.db
      .query("review_comments")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", args.conversation_id))
      .collect();
    return rows
      .filter((row) => isQuoteRow(row) && String(row.author_user_id) === String(userId))
      .sort((a, b) => a.created_at - b.created_at)
      .map((row) => ({
        _id: row._id,
        client_id: row.client_id ?? null,
        conversation_id: row.conversation_id ?? null,
        message_id: row.message_id ?? null,
        block_index: row.block_index ?? null,
        quote: row.prose_anchor?.text ?? "",
        body: row.content,
        verdict: row.verdict ?? null,
        created_at: row.created_at,
        sent_at: row.sent_at ?? null,
        sent_to_conversation_id: row.sent_to_conversation_id ?? null,
        answered_message_id: row.answered_message_id ?? null,
        answered_at: row.answered_at ?? null,
      }));
  },
});
