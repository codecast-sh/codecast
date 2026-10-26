// Guest suggestions, the owner's side (the signed-out guest's side is
// sessionGuests.ts). Guests without an account suggest messages for a shared
// session; nothing reaches the session until its owner sends it.
//
// The owner turns suggestions on for one session (conversations.
// guest_suggestions), which only means something while the session's share
// link is on. Each suggestion waits as a card above the owner's composer,
// fed into the store's guestSuggestions collection by listPending. Send puts
// it into the session as the guest's own words (<user-message from="Ann
// (guest)">), optionally as the owner edited it; Dismiss drops it. Every
// write is a store action whose dispatch side effect calls the helpers here.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { formatUserMessage, guestDisplayName } from "@codecast/shared/contracts";
import { checkConversationAccess } from "./privacy";
import { enqueuePendingMessage } from "./pendingMessages";

type Ctx = { db: any };

/** Whoever owns the session: the runner, or an assigned owner. */
async function requireOwner(ctx: Ctx, userId: Id<"users">, conversation: Doc<"conversations"> | null) {
  if (!conversation || (await checkConversationAccess(ctx, userId, conversation)) !== "owner") {
    throw new Error("Only the session's owner can do this");
  }
  return conversation;
}

// A body that closes the wrapper early would let a guest write a second,
// unattributed message after it. Escaping the tag keeps the whole body inside.
export function guestMessageContent(name: string, body: string): string {
  return formatUserMessage(guestDisplayName(name), body.replace(/<(\/?)user-message/gi, "&lt;$1user-message"));
}

/** The owner's waiting suggestions for one session, oldest first. */
export const listPending = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const id = ctx.db.normalizeId("conversations", args.conversation_id);
    const conversation = id ? await ctx.db.get(id) : null;
    if (!conversation || (await checkConversationAccess(ctx, userId, conversation)) !== "owner") return [];
    const rows = await ctx.db
      .query("guest_suggestions")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversation._id).eq("status", "pending"))
      .take(100);
    return rows
      .sort((a: any, b: any) => a.created_at - b.created_at)
      .map((r: any) => ({
        _id: r._id,
        conversation_id: r.conversation_id,
        guest_name: r.guest_name,
        body: r.body,
        status: r.status,
        created_at: r.created_at,
      }));
  },
});

/** Turn guest suggestions on or off for one session. Off leaves waiting
 *  suggestions where they are: turning it back on shows them again. */
export async function writeGuestSuggestions(ctx: Ctx, userId: Id<"users">, conversationId: string, enabled: boolean) {
  const id = ctx.db.normalizeId("conversations", conversationId);
  const conversation = await requireOwner(ctx, userId, id ? await ctx.db.get(id) : null);
  await ctx.db.patch(conversation._id, { guest_suggestions: enabled });
}

/** Send a suggestion into the session as the guest's words, or the owner's
 *  edit of them. */
export async function sendGuestSuggestionFor(
  ctx: Ctx & { scheduler?: any },
  userId: Id<"users">,
  suggestionId: string,
  editedBody?: string,
) {
  const id = ctx.db.normalizeId("guest_suggestions", suggestionId);
  const row = id ? await ctx.db.get(id) : null;
  if (!row) throw new Error("That suggestion is gone");
  const conversation = await requireOwner(ctx, userId, await ctx.db.get(row.conversation_id));
  if (row.status !== "pending") return { status: row.status };
  const body = (editedBody ?? row.body).trim();
  if (!body) throw new Error("The message is empty");
  await enqueuePendingMessage(ctx, conversation, userId, { content: guestMessageContent(row.guest_name, body), human: true });
  await ctx.db.patch(row._id, {
    status: "sent",
    decided_at: Date.now(),
    ...(body !== row.body ? { sent_body: body } : {}),
  });
  return { status: "sent" };
}

export async function dismissGuestSuggestionFor(ctx: Ctx, userId: Id<"users">, suggestionId: string) {
  const id = ctx.db.normalizeId("guest_suggestions", suggestionId);
  const row = id ? await ctx.db.get(id) : null;
  if (!row) return { status: "gone" };
  await requireOwner(ctx, userId, await ctx.db.get(row.conversation_id));
  if (row.status !== "pending") return { status: row.status };
  await ctx.db.patch(row._id, { status: "dismissed", decided_at: Date.now() });
  return { status: "dismissed" };
}
