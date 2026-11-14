// Guest suggestions, the owner's side (the signed-out guest's side is
// sessionGuests.ts, a teammate's is teamSuggestions.ts). Guests without an
// account suggest messages for a shared session, and teammates do while the
// owner is in it; nothing reaches the session until its owner sends it.
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
import { canSendProductMessage, enqueuePendingMessage } from "./pendingMessages";
import { answerers, askStillOpen, liveSuggestion, personName, withoutEndedPrompts } from "./teamSuggestions";

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
    // Newest first, so stale rows can never crowd out what just arrived.
    const rows = await ctx.db
      .query("guest_suggestions")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversation._id).eq("status", "pending"))
      .order("desc")
      .take(100);
    const now = Date.now();
    return (await withoutEndedPrompts(ctx, rows))
      .filter((r: any) => liveSuggestion(r, now))
      .sort((a: any, b: any) => a.created_at - b.created_at)
      .map((r: any) => ({
        _id: r._id,
        conversation_id: r.conversation_id,
        guest_name: r.guest_name,
        author_user_id: r.author_user_id ?? null,
        kind: r.kind ?? null,
        tool_use_id: r.tool_use_id ?? null,
        permission_id: r.permission_id ?? null,
        decision: r.decision ?? null,
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
  if (row.kind === "permission") throw new Error("Answer the permission on its card");
  const body = (editedBody ?? row.body).trim();
  if (!body) throw new Error("The message is empty");
  const now = Date.now();
  if (row.kind === "answer") {
    // Only someone who may press the question card itself submits an answer
    // to it: the runner or the primary owner (an assigned owner proposes).
    if (!answerers(conversation).has(String(userId))) throw new Error("Only the session's runner can answer its questions");
    // The owner's own reply to the question, exactly as the card would send
    // it (teamSuggestions.canonicalAnswer rebuilt it), and only while the
    // question is still open: keys pressed after it closed would land in
    // whatever the terminal shows next. The other proposals for that
    // question are settled by it.
    if (editedBody !== undefined || !(await askStillOpen(ctx, conversation._id, row.tool_use_id))) {
      await ctx.db.patch(row._id, { status: "closed", decided_at: now });
      return { status: "closed" };
    }
    // Prose is typed at the agent's prompt as the owner's input, so it names
    // whose words it is; picked options are the owner's own choice.
    const poll = JSON.parse(body);
    const content = typeof poll.text === "string"
      ? JSON.stringify({ ...poll, text: `${poll.text}\n\n(${row.guest_name}'s answer)` })
      : body;
    await enqueuePendingMessage(ctx, conversation, userId, { content, human: true });
    const rivals = await ctx.db
      .query("guest_suggestions")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversation._id).eq("status", "pending"))
      .order("desc")
      .take(100);
    for (const r of rivals) {
      if (r.kind === "answer" && r.tool_use_id === row.tool_use_id && String(r._id) !== String(row._id)) {
        await ctx.db.patch(r._id, { status: "closed", decided_at: now });
      }
    }
  } else if (row.author_user_id) {
    // A teammate's words, attributed to them as a direct send would be, and
    // only while they could still send them themselves. An edit says whose.
    if (!(await canSendProductMessage(ctx, row.author_user_id, conversation))) {
      await ctx.db.patch(row._id, { status: "closed", decided_at: now });
      return { status: "closed" };
    }
    const owner = await ctx.db.get(userId);
    const name = body === row.body ? row.guest_name : `${row.guest_name}, edited by ${personName(owner)}`;
    await enqueuePendingMessage(ctx, conversation, row.author_user_id, { content: formatUserMessage(name, body), human: true, ...(row.queued ? { queue: true } : {}) });
  } else {
    await enqueuePendingMessage(ctx, conversation, userId, { content: guestMessageContent(row.guest_name, body), human: true });
  }
  await ctx.db.patch(row._id, {
    status: "sent",
    decided_at: now,
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
