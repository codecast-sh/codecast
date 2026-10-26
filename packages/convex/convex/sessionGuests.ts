// Session guests: the signed-out side of guest suggestions (the owner's side
// is guestSuggestions.ts). People without an account suggest messages for a
// shared session; its owner decides which ones the session receives.
//
// A guest is a session_guests row, made when they give a name, and proves it
// with the secret their browser was handed (only its hash is stored, as call
// guests do). Every function here takes the share token as well, and answers
// only while that token is still the session's link and the owner still has
// suggestions on (conversations.guest_suggestions): turning the link off or
// rotating it shuts every guest out. A guest reads and writes their own
// suggestions and nothing else of anyone's. Nothing a guest writes reaches the
// session, the owner's machine or the agent until the owner sends it.
//
// A link anybody can hold is bounded where it could cost the owner: new
// guests per minute per session, waiting suggestions per guest, and length.
import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { guestDisplayName, normalizeGuestName } from "@codecast/shared/contracts";
import { emitNotification } from "./notificationRouter";
import { sha256Hex } from "./lib/hash";
import { newSlug } from "./lib/slug";

export const GUEST_SUGGESTION_MAX_CHARS = 8000;
export const GUEST_PENDING_MAX = 5;
export const GUESTS_PER_MINUTE = 10;
const GUEST_SECRET_LENGTH = 32;
// A guest sees their recent suggestions, not their whole history.
const GUEST_HISTORY = 20;

type Ctx = { db: any };

const guestArgs = {
  conversation_id: v.string(),
  share_token: v.string(),
  guest_id: v.string(),
  secret: v.string(),
};

/** The conversation, when this share token opens it and its owner takes suggestions. */
async function openConversation(ctx: Ctx, conversationId: string, shareToken: string): Promise<Doc<"conversations"> | null> {
  const id = ctx.db.normalizeId("conversations", conversationId);
  const conversation = id ? await ctx.db.get(id) : null;
  if (!conversation?.share_token || conversation.share_token !== shareToken) return null;
  return conversation.guest_suggestions ? conversation : null;
}

/** The guest row these credentials prove, on this conversation and this link. */
async function provenGuest(
  ctx: Ctx,
  conversation: Doc<"conversations">,
  args: { guest_id: string; secret: string; share_token: string },
): Promise<Doc<"session_guests"> | null> {
  const id = ctx.db.normalizeId("session_guests", args.guest_id);
  const guest = id ? await ctx.db.get(id) : null;
  if (!guest || String(guest.conversation_id) !== String(conversation._id)) return null;
  if (typeof args.secret !== "string" || args.secret.length < 16 || args.secret.length > 128) return null;
  if ((await sha256Hex(args.secret)) !== guest.secret_hash) return null;
  if ((await sha256Hex(args.share_token)) !== guest.share_token_hash) return null;
  return guest;
}

/** What the share page shows a guest: whether suggestions are open, who they
 *  are, and their own recent suggestions. */
export const guestState = query({
  args: {
    conversation_id: v.string(),
    share_token: v.string(),
    guest_id: v.optional(v.string()),
    secret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await openConversation(ctx, args.conversation_id, args.share_token);
    if (!conversation) return { open: false as const };
    const guest = args.guest_id && args.secret
      ? await provenGuest(ctx, conversation, { guest_id: args.guest_id, secret: args.secret, share_token: args.share_token })
      : null;
    if (!guest) return { open: true as const, guest: null, suggestions: [] };
    const rows = await ctx.db
      .query("guest_suggestions")
      .withIndex("by_guest", (q: any) => q.eq("guest_id", guest._id))
      .order("desc")
      .take(GUEST_HISTORY);
    return {
      open: true as const,
      guest: { name: guest.name },
      suggestions: rows
        .filter((r: any) => r.status !== "withdrawn")
        .map((r: any) => ({ _id: r._id, body: r.sent_body ?? r.body, status: r.status, created_at: r.created_at }))
        .reverse(),
    };
  },
});

/** A viewer of the link gives a name and becomes a guest of this session. */
export const joinAsGuest = mutation({
  args: { conversation_id: v.string(), share_token: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const conversation = await openConversation(ctx, args.conversation_id, args.share_token);
    if (!conversation) throw new Error("This session isn't taking suggestions");
    const name = normalizeGuestName(args.name);
    if (!name) throw new Error("Enter your name");
    const now = Date.now();
    const recent = await ctx.db
      .query("session_guests")
      .withIndex("by_conversation_created", (q: any) => q.eq("conversation_id", conversation._id).gt("created_at", now - 60_000))
      .take(GUESTS_PER_MINUTE);
    if (recent.length >= GUESTS_PER_MINUTE) throw new Error("Too many people are joining right now. Try again in a minute.");
    const secret = newSlug(GUEST_SECRET_LENGTH);
    const guestId = await ctx.db.insert("session_guests", {
      conversation_id: conversation._id,
      name,
      secret_hash: await sha256Hex(secret),
      share_token_hash: await sha256Hex(args.share_token),
      created_at: now,
    });
    return { guest_id: guestId, secret, name };
  },
});

/** A guest suggests one message. It waits for the owner. */
export const suggest = mutation({
  args: { ...guestArgs, body: v.string() },
  handler: async (ctx, args) => {
    const conversation = await openConversation(ctx, args.conversation_id, args.share_token);
    if (!conversation) throw new Error("This session isn't taking suggestions");
    const guest = await provenGuest(ctx, conversation, args);
    if (!guest) throw new Error("Your guest pass expired. Enter your name again.");
    const body = args.body.trim();
    if (!body) throw new Error("Write a message first");
    if (body.length > GUEST_SUGGESTION_MAX_CHARS) throw new Error(`Keep it under ${GUEST_SUGGESTION_MAX_CHARS} characters`);
    const mine = await ctx.db
      .query("guest_suggestions")
      .withIndex("by_guest", (q: any) => q.eq("guest_id", guest._id))
      .order("desc")
      .take(GUEST_HISTORY);
    const waiting = mine.filter((r: any) => r.status === "pending").length;
    if (waiting >= GUEST_PENDING_MAX) {
      throw new Error(`You have ${GUEST_PENDING_MAX} suggestions waiting. Wait for the owner to get to them.`);
    }
    const owner = (conversation.owner_user_id ?? conversation.user_id) as Id<"users">;
    const id = await ctx.db.insert("guest_suggestions", {
      conversation_id: conversation._id,
      guest_id: guest._id,
      guest_name: guest.name,
      owner_user_id: owner,
      body,
      status: "pending",
      created_at: Date.now(),
    });
    // One bell row per waiting batch, not per message: a guest typing five
    // lines in a row should not buzz the owner's phone five times.
    if (waiting === 0) {
      try {
        await emitNotification(ctx as unknown as MutationCtx, {
          event_type: "permission_request",
          actor_name: guestDisplayName(guest.name),
          entity_type: "conversation",
          entity_id: String(conversation._id),
          message: `${guestDisplayName(guest.name)} suggested a message for ${conversation.title || "your session"}`,
          push_body: body.slice(0, 200),
          conversation_id: conversation._id,
          direct_recipient_id: owner,
        });
      } catch {}
    }
    return { suggestion_id: id };
  },
});

/** A guest takes back a suggestion the owner has not decided yet. */
export const withdraw = mutation({
  args: { ...guestArgs, suggestion_id: v.string() },
  handler: async (ctx, args) => {
    const conversation = await openConversation(ctx, args.conversation_id, args.share_token);
    const guest = conversation ? await provenGuest(ctx, conversation, args) : null;
    if (!guest) throw new Error("Your guest pass expired. Enter your name again.");
    const id = ctx.db.normalizeId("guest_suggestions", args.suggestion_id);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || String(row.guest_id) !== String(guest._id) || row.status !== "pending") return { status: row?.status ?? "gone" };
    await ctx.db.patch(row._id, { status: "withdrawn", decided_at: Date.now() });
    return { status: "withdrawn" };
  },
});
