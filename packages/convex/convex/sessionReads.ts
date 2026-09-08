// Session unread: where each viewer's attention stopped, one row per
// (user, conversation) in session_reads.
//
// The model is deliberately two numbers and one flag. `acknowledged_at` says
// when the viewer last looked at the session while it was the active view and
// they were actually at the screen; the conversation's own `updated_at` says
// when it last moved. Unread is the comparison, evaluated by every client
// (shared/contracts/sessionRead.isSessionUnread) rather than stored here — so
// an agent re-reporting the same state costs nothing (heartbeats never bump
// updated_at) while a real new turn re-lights the card, and web, mobile and
// the CLI cannot disagree about which cards are lit.
//
// `manual_unread` is the human's override: "I saw it, deal with it later".
// The next presence ack clears it, and nothing else does.
//
// Access: a read mark is never shared, so `user_id` IS the access key and the
// table carries no `workspace` (the same choice thread_reads, bookmarks and
// bucket_assignments make — see CLAUDE.md, "A table earns `workspace` only if
// a row can meaningfully be private to its owner inside a team"). Writes still
// check the conversation itself, so a mark can only be made for a session the
// caller can read.

import { mutation, query } from "./functions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getAuthenticatedUserId } from "./pendingMessages";
import { canAccessConversation } from "./lib/access";
import { resolveConversationRef } from "./conversations";

/** How many marks one client carries. Far past any inbox's visible depth; a
 *  session older than the cap has no mark and reads as unread, which is the
 *  honest answer for something the viewer has not looked at in that long. */
export const SESSION_READ_SCAN = 1000;

export type SessionReadRow = {
  _id: string;
  conversation_id: string;
  acknowledged_at: number;
  manual_unread?: boolean;
  updated_at: number;
};

function project(row: Doc<"session_reads">): SessionReadRow {
  return {
    _id: String(row._id),
    conversation_id: String(row.conversation_id),
    acknowledged_at: row.acknowledged_at,
    ...(row.manual_unread ? { manual_unread: true } : {}),
    updated_at: row.updated_at,
  };
}

async function findMark(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<Doc<"session_reads"> | null> {
  return await ctx.db
    .query("session_reads")
    .withIndex("by_user_conversation", (q: any) =>
      q.eq("user_id", userId).eq("conversation_id", conversationId))
    .first();
}

/** The one write path. `acknowledgedAt` only ever moves forward: an ack that
 *  raced a newer one must never re-unread what the viewer already saw. */
async function upsertMark(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  patch: { acknowledgedAt?: number; manualUnread?: boolean },
): Promise<SessionReadRow> {
  const now = Date.now();
  const existing = await findMark(ctx, userId, conversationId);
  if (!existing) {
    const id = await ctx.db.insert("session_reads", {
      user_id: userId,
      conversation_id: conversationId,
      acknowledged_at: patch.acknowledgedAt ?? 0,
      ...(patch.manualUnread ? { manual_unread: true } : {}),
      updated_at: now,
    });
    return project((await ctx.db.get(id))!);
  }
  const next: Record<string, unknown> = { updated_at: now };
  if (patch.acknowledgedAt !== undefined && patch.acknowledgedAt > existing.acknowledged_at) {
    next.acknowledged_at = patch.acknowledgedAt;
  }
  if (patch.manualUnread !== undefined) next.manual_unread = patch.manualUnread;
  await ctx.db.patch(existing._id, next);
  return project({ ...existing, ...next } as Doc<"session_reads">);
}

/** Resolve what the caller named — a conversation id or a short id — and
 *  refuse a session they cannot read. */
async function requireConversation(
  ctx: MutationCtx,
  userId: Id<"users">,
  ref: string,
): Promise<Doc<"conversations">> {
  const conversation = await resolveConversationRef(ctx, ref, userId);
  if (!conversation) throw new Error("Conversation not found");
  if (!(await canAccessConversation(ctx, userId, conversation))) {
    throw new Error("Conversation not found");
  }
  return conversation;
}

// ── Queries ─────────────────────────────────────────────────────────────────

// The viewer's own marks. Enrichment only: a client that gets nothing back
// (an undeployed backend, a logged-out tab) falls back to its local
// "last opened" record and still renders honest cards.
export const listMine = query({
  args: {
    api_token: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SessionReadRow[]> => {
    const userId = await getAuthenticatedUserId(ctx as any, args.api_token);
    if (!userId) return [];
    const limit = Math.min(Math.max(args.limit ?? SESSION_READ_SCAN, 1), SESSION_READ_SCAN);
    const rows = await ctx.db
      .query("session_reads")
      .withIndex("by_user_updated", (q: any) => q.eq("user_id", userId))
      .order("desc")
      .take(limit);
    return rows.map(project);
  },
});

// ── Mutations ───────────────────────────────────────────────────────────────

// "I am looking at this session now." Called by the client only while the
// conversation is the active view AND the reader is present (usePagePresence),
// never on mere mount — a session open in a background tab is not being read.
export const acknowledge = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.string(),
    // The stamp to write. Defaults to now; the client passes the conversation's
    // own updated_at so the mark it renders optimistically is EXACTLY what the
    // server writes and the card cannot flicker back to unread on the echo.
    acknowledged_at: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SessionReadRow> => {
    const userId = await getAuthenticatedUserId(ctx as any, args.api_token);
    if (!userId) throw new Error("Unauthorized");
    const conversation = await requireConversation(ctx, userId, args.conversation_id);
    const now = Date.now();
    // Never accept a future stamp: it would swallow turns that have not landed.
    const at = Math.min(args.acknowledged_at ?? now, now);
    return await upsertMark(ctx, userId, conversation._id, {
      acknowledgedAt: at,
      manualUnread: false,
    });
  },
});

// "Leave this one lit." Survives every later ack-free change; the next
// presence ack is what clears it.
export const markUnread = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.string(),
  },
  handler: async (ctx, args): Promise<SessionReadRow> => {
    const userId = await getAuthenticatedUserId(ctx as any, args.api_token);
    if (!userId) throw new Error("Unauthorized");
    const conversation = await requireConversation(ctx, userId, args.conversation_id);
    return await upsertMark(ctx, userId, conversation._id, { manualUnread: true });
  },
});
