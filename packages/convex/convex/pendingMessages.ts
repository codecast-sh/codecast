import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";

async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

// Interactive-prompt / poll keystroke answers (tagged __cc_poll, mirrors the daemon's
// parsePollMessage). These are fire-and-forget: they never echo to the agent's JSONL, so the
// content-matched ack in addMessages can never fire for them. A successful inject IS their
// delivery — re-injecting them on the stale-injected reset just re-sends menu keystrokes and
// mis-navigates the agent's prompts.
export function isControlMessage(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return parsed?.__cc_poll === true && (Array.isArray(parsed.keys) || Array.isArray(parsed.steps));
  } catch {
    return false;
  }
}

export const sendMessageToSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    content: v.string(),
    image_storage_id: v.optional(v.id("_storage")),
    image_storage_ids: v.optional(v.array(v.id("_storage"))),
    client_id: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only send messages to your own conversations");
    }

    if (args.client_id) {
      const existing = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversation_id", args.conversation_id)
        )
        .filter((q) => q.eq(q.field("client_id"), args.client_id))
        .first();
      if (existing) return existing._id;
    }

    const messageId = await ctx.db.insert("pending_messages", {
      conversation_id: args.conversation_id,
      from_user_id: authUserId,
      content: args.content,
      image_storage_id: args.image_storage_id,
      image_storage_ids: args.image_storage_ids,
      client_id: args.client_id,
      status: "pending" as const,
      created_at: Date.now(),
      retry_count: 0,
    });

    const now = Date.now();
    await ctx.db.patch(args.conversation_id, {
      updated_at: now,
      has_pending_messages: true,
      ...(conversation.status === "completed" ? { status: "active" } : {}),
      ...(conversation.inbox_dismissed_at ? { inbox_dismissed_at: undefined } : {}),
    });

    return messageId;
  },
});

export const updateMessageStatus = mutation({
  args: {
    message_id: v.id("pending_messages"),
    status: v.union(
      v.literal("pending"),
      v.literal("injected"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("undeliverable")
    ),
    delivered_at: v.optional(v.number()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    if (message.from_user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only update your own messages");
    }

    // "delivered" is terminal: the agent echoed the message to its JSONL, so it was received.
    // A stale retry timer or the daemon's post-inject DEDUP re-mark must NOT downgrade it back
    // to injected/pending — that re-arms the 120s stuck-message reset and re-injects a duplicate.
    // "cancelled" is likewise terminal: the user stopped this message, so an in-flight daemon
    // mark (injected/failed) must not revive it.
    if (message.status === "delivered" || message.status === "cancelled") {
      return { success: true };
    }

    await ctx.db.patch(args.message_id, {
      status: args.status,
      delivered_at: args.delivered_at,
    });

    // Only clear has_pending_messages when moving to a terminal state (delivered)
    // and no other in-flight messages remain
    if (args.status === "delivered") {
      const remainingPending = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversation_id", message.conversation_id).eq("status", "pending")
        )
        .first();
      if (!remainingPending) {
        const remainingInjected = await ctx.db
          .query("pending_messages")
          .withIndex("by_conversation_status", (q) =>
            q.eq("conversation_id", message.conversation_id).eq("status", "injected")
          )
          .first();
        if (!remainingInjected) {
          await ctx.db.patch(message.conversation_id, { has_pending_messages: false });
        }
      }
    }

    return { success: true };
  },
});

export const retryMessage = mutation({
  args: {
    message_id: v.id("pending_messages"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    if (message.from_user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only retry your own messages");
    }

    // Never re-queue an already-delivered message. Retry timers are scheduled before delivery
    // confirms; if the ack lands first, the timer firing here would otherwise re-pend a
    // delivered message and cause a duplicate injection.
    if (message.status === "delivered") {
      return { success: true };
    }

    await ctx.db.patch(args.message_id, {
      status: "pending" as const,
      retry_count: message.retry_count + 1,
    });

    return { success: true };
  },
});

// User-initiated stop. The retry loop is otherwise indefinite (the healer always revives a
// stranded message), so this is the escape hatch for a message that genuinely can't land —
// e.g. a conversation whose session is gone for good. Terminal: never revived.
export const cancelPendingMessage = mutation({
  args: {
    message_id: v.id("pending_messages"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }
    if (message.from_user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only cancel your own messages");
    }

    // Already terminal — nothing to stop.
    if (message.status === "delivered" || message.status === "cancelled") {
      return { success: true };
    }

    await ctx.db.patch(args.message_id, { status: "cancelled" as const });

    // Clear the conversation flag if nothing else is still in flight.
    const remainingPending = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", message.conversation_id).eq("status", "pending")
      )
      .first();
    if (!remainingPending) {
      const remainingInjected = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversation_id", message.conversation_id).eq("status", "injected")
        )
        .first();
      if (!remainingInjected) {
        await ctx.db.patch(message.conversation_id, { has_pending_messages: false });
      }
    }

    return { success: true };
  },
});

export async function resetConversationPendingMessages(
  ctx: { db: any },
  conversationId: Id<"conversations">
) {
  const messages = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .collect();

  let resetCount = 0;
  for (const msg of messages) {
    if (msg.status === "failed" || msg.status === "undeliverable" || msg.status === "injected") {
      await ctx.db.patch(msg._id, { status: "pending", retry_count: 0, delivered_at: undefined });
      resetCount++;
    }
  }

  if (resetCount > 0) {
    await ctx.db.patch(conversationId, { has_pending_messages: true });
  }

  return resetCount;
}

// Mark a single pending message delivered (terminal) and clear the conversation's
// has_pending_messages flag when nothing else is in flight. Shared by the content-matched
// ack inside addMessages (the reliable path — fires whenever the agent echoes the message,
// on any sync path) and available to other callers.
export async function markPendingDelivered(
  ctx: { db: any },
  message: { _id: Id<"pending_messages">; conversation_id: Id<"conversations">; status: string }
): Promise<void> {
  // Both are terminal: delivered can't be re-delivered, and a user-cancelled message must not be
  // resurrected by a late content-match ack (the ack scans all rows for the conversation).
  if (message.status === "delivered" || message.status === "cancelled") return;
  await ctx.db.patch(message._id, { status: "delivered" as const, delivered_at: Date.now() });

  const remainingPending = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_status", (q: any) =>
      q.eq("conversation_id", message.conversation_id).eq("status", "pending")
    )
    .first();
  if (remainingPending) return;
  const remainingInjected = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_status", (q: any) =>
      q.eq("conversation_id", message.conversation_id).eq("status", "injected")
    )
    .first();
  if (!remainingInjected) {
    await ctx.db.patch(message.conversation_id, { has_pending_messages: false });
  }
}

export const getPendingMessages = query({
  args: {
    user_id: v.optional(v.id("users")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const targetUserId = args.user_id || authUserId;

    if (targetUserId.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only get your own pending messages");
    }

    const messages = await ctx.db
      .query("pending_messages")
      .withIndex("by_user_status", (q) =>
        q.eq("from_user_id", targetUserId).eq("status", "pending")
      )
      .collect();

    return messages;
  },
});

export const getConversationPendingMessage = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) return null;

    const msgs = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .filter((q) =>
        q.and(
          q.neq(q.field("status"), "delivered"),
          q.neq(q.field("status"), "cancelled")
        )
      )
      .collect();

    const owned = msgs.filter((m) => m.from_user_id.toString() === authUserId.toString());
    const msg = owned.find((m) => m.status === "pending")
      ?? owned.find((m) => m.status === "injected")
      ?? owned.find((m) => m.status === "failed")
      ?? owned.find((m) => m.status === "undeliverable")
      ?? null;
    if (!msg) return null;
    return { created_at: msg.created_at, retry_count: msg.retry_count, status: msg.status as string, content: msg.content };
  },
});

export const getMessageStatus = query({
  args: {
    message_id: v.id("pending_messages"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    if (message.from_user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only check status of your own messages");
    }

    return {
      status: message.status,
      created_at: message.created_at,
      delivered_at: message.delivered_at,
      retry_count: message.retry_count,
    };
  },
});

// How long after send the healer keeps reviving a stranded message. Long enough that a daemon
// outage or sleep of many minutes fully self-heals; bounded so we don't inject hours-stale
// context into a session that has moved on. A live `pending` message is delivered by the
// daemon's subscription at any age — this window only governs reviving non-pending strays.
export const HEAL_WINDOW_MS = 60 * 60_000;
// Give the JSONL-echo ack a chance to land before re-pending an "injected" message as failed.
const INJECT_ACK_GRACE_MS = 120_000;

export type HealAction =
  | { kind: "skip" }
  | { kind: "deliver_control" }
  | { kind: "repend" };

// Pure decision for the cron healer. The invariant: `retry_count` counts REAL failed delivery
// attempts only — never elapsed wait time. So the healer never bumps it (and resets it to 0 on
// revival, handing the daemon a fresh budget). This is the fix for messages dying on daemon
// reconnect: the old cron bumped retry_count every 30s as a liveness poke, exhausting the
// undeliverable budget while nothing was actually being delivered.
export function planStuckMessageHeal(
  msg: { status: string; content: string; created_at: number },
  now: number
): HealAction {
  const age = now - msg.created_at;
  if (age > HEAL_WINDOW_MS) return { kind: "skip" };

  if (msg.status === "injected") {
    if (age < INJECT_ACK_GRACE_MS) return { kind: "skip" };
    // Control messages have no JSONL echo to ack against; a stale "injected" one was already
    // successfully injected, so promote it to terminal "delivered" rather than re-injecting.
    if (isControlMessage(msg.content)) return { kind: "deliver_control" };
    return { kind: "repend" };
  }
  // "undeliverable" is NOT a dead-end: the daemon raises it after its gentle-retry budget is
  // spent (a useful "escalate" signal), but the healer always revives it so delivery keeps
  // moving forward with no client present. "failed" is the transient sync-failure sibling.
  if (msg.status === "failed" || msg.status === "undeliverable") return { kind: "repend" };

  // "pending" is owned by the daemon's live subscription and its own retry timers — the cron
  // must not touch it (touching it here is what conflated waiting-time with the retry budget).
  return { kind: "skip" };
}

export const retryStuckMessages = internalMutation({
  handler: async (ctx) => {
    const now = Date.now();

    // Scan only the non-terminal, non-pending states that need cron intervention. `delivered`
    // is terminal and `pending` is the daemon's to drive, so neither is queried.
    const candidates: any[] = [];
    for (const status of ["injected", "failed", "undeliverable"] as const) {
      const rows = await ctx.db
        .query("pending_messages")
        .filter((q) =>
          q.and(
            q.eq(q.field("status"), status),
            q.gt(q.field("created_at"), now - HEAL_WINDOW_MS)
          )
        )
        .collect();
      candidates.push(...rows);
    }

    let revived = 0;
    let controlsAcked = 0;
    const reflag = new Set<Id<"conversations">>();
    for (const msg of candidates) {
      const action = planStuckMessageHeal(msg, now);
      if (action.kind === "skip") continue;
      if (action.kind === "deliver_control") {
        await markPendingDelivered(ctx, msg);
        controlsAcked++;
        continue;
      }
      await ctx.db.patch(msg._id, {
        status: "pending" as const,
        retry_count: 0,
        delivered_at: undefined,
      });
      reflag.add(msg.conversation_id);
      revived++;
    }
    for (const convId of reflag) {
      await ctx.db.patch(convId, { has_pending_messages: true });
    }

    if (revived > 0 || controlsAcked > 0) {
      console.log(`retryStuckMessages: revived ${revived} stranded message(s), acked ${controlsAcked} stale control msg(s)`);
    }
  },
});

// Ack: mark all "injected" messages for a conversation as "delivered"
// Called by the daemon when the user's message appears in the synced JSONL
export const ackInjectedMessages = mutation({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed");
    }

    const injected = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", args.conversation_id).eq("status", "injected")
      )
      .collect();

    const now = Date.now();
    for (const msg of injected) {
      await ctx.db.patch(msg._id, { status: "delivered" as const, delivered_at: now });
    }

    if (injected.length > 0) {
      // Check if any pending remain before clearing flag
      const remainingPending = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversation_id", args.conversation_id).eq("status", "pending")
        )
        .first();
      if (!remainingPending) {
        await ctx.db.patch(args.conversation_id, { has_pending_messages: false });
      }
    }

    return { acked: injected.length };
  },
});

// Reset: move "injected" messages back to "pending" (e.g. after session kill)
export const resetInjectedMessages = mutation({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed");
    }

    const injected = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", args.conversation_id).eq("status", "injected")
      )
      .collect();

    for (const msg of injected) {
      await ctx.db.patch(msg._id, {
        status: "pending" as const,
        retry_count: msg.retry_count + 1,
        delivered_at: undefined,
      });
    }

    if (injected.length > 0) {
      await ctx.db.patch(args.conversation_id, { has_pending_messages: true });
    }

    return { reset: injected.length };
  },
});
