import { mutation, query, internalMutation, internalQuery } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { findConversationByAnyRef, findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { checkConversationAccess } from "./privacy";
import { hasGrantedSendAccess } from "./collab";

export async function getAuthenticatedUserId(
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

// Interactive-prompt / poll answers (tagged __cc_poll, mirrors the daemon's parsePollMessage):
// keystroke selections (keys/steps) and free-text answers that decline the menu and type at
// the prompt (text). These are fire-and-forget — a successful inject IS their delivery, so the
// content-matched ack in addMessages is bypassed and re-injecting them on the stale-injected
// reset is suppressed. Re-injecting a keystroke poll re-sends menu keys and mis-navigates the
// agent's prompts; re-injecting a text poll re-declines and re-types a duplicate answer. (A
// text poll's typed answer DOES echo to the JSONL, unlike a keystroke poll, but the ack still
// can't match it — the stored content is the JSON envelope, not the typed prose.)
export function isControlMessage(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return parsed?.__cc_poll === true && (Array.isArray(parsed.keys) || Array.isArray(parsed.steps) || typeof parsed.text === "string");
  } catch {
    return false;
  }
}

type PendingStatus = "pending" | "injected" | "delivered" | "failed" | "undeliverable" | "cancelled";
const TERMINAL_STATUSES = new Set<PendingStatus>(["delivered", "cancelled"]);

export function isTerminalPendingStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status as PendingStatus);
}

async function rependPendingMessage(
  ctx: { db: any },
  message: { _id: Id<"pending_messages">; status: string; retry_count: number },
  retryCount: number
): Promise<boolean> {
  if (isTerminalPendingStatus(message.status)) return false;
  await ctx.db.patch(message._id, {
    status: "pending" as const,
    retry_count: retryCount,
    delivered_at: undefined,
  });
  return true;
}

async function patchPendingMessageStatus(
  ctx: { db: any },
  message: { _id: Id<"pending_messages">; conversation_id: Id<"conversations">; status: string },
  patch: { status: PendingStatus; delivered_at?: number }
): Promise<boolean> {
  if (isTerminalPendingStatus(message.status)) return false;
  await ctx.db.patch(message._id, patch);
  if (patch.status === "delivered" || patch.status === "cancelled") {
    await clearHasPendingIfQuiet(ctx, message.conversation_id);
  }
  return true;
}

// The owner of a pending message is whoever owns the target conversation — that's the daemon
// responsible for delivering it. For a self-send owner == sender; for a team send they differ.
// owner_user_id is denormalized onto the row (backfilled on legacy rows); fall back to the
// conversation's user_id so an un-backfilled row still routes correctly.
export function pendingMessageOwnerId(
  message: { owner_user_id?: Id<"users"> },
  conversation: { user_id: Id<"users"> }
): string {
  return (message.owner_user_id ?? conversation.user_id).toString();
}

export function canDaemonSeePendingMessage(
  message: { from_user_id: Id<"users">; owner_user_id?: Id<"users">; status: string },
  conversation: { user_id: Id<"users">; owner_device_id?: string },
  userId: Id<"users">,
  deviceId: string
): boolean {
  // Delivery is the TARGET owner's job, not the sender's — a teammate's message is delivered by
  // the owner's daemon. (For a self-send these are the same user.)
  if (pendingMessageOwnerId(message, conversation) !== userId.toString()) return false;
  if (message.status !== "pending") return false;
  return !conversation.owner_device_id || conversation.owner_device_id === deviceId;
}

export async function claimPendingMessageForDaemon(
  ctx: { db: any },
  messageId: Id<"pending_messages">,
  userId: Id<"users">,
  deviceId: string
): Promise<any | null> {
  const message = await ctx.db.get(messageId);
  if (!message) return null;
  const conversation = await ctx.db.get(message.conversation_id);
  if (!conversation || !canDaemonSeePendingMessage(message, conversation, userId, deviceId)) return null;
  if (!conversation.owner_device_id) {
    await ctx.db.patch(message.conversation_id, { owner_device_id: deviceId });
  }
  return message;
}

async function daemonCanMutatePendingMessage(
  ctx: { db: any },
  message: { conversation_id: Id<"conversations">; from_user_id: Id<"users">; owner_user_id?: Id<"users"> },
  userId: Id<"users">,
  deviceId?: string
): Promise<boolean> {
  if (!deviceId) return true;
  // The mutating daemon must own the TARGET conversation (it's the one delivering the message),
  // not be the sender — a teammate's send is delivered & status-updated by the owner's daemon.
  const conversation = await ctx.db.get(message.conversation_id);
  if (!conversation || pendingMessageOwnerId(message, conversation) !== userId.toString()) return false;
  const owner = conversation.owner_device_id as string | undefined;
  if (owner && owner !== deviceId) return false;
  if (!owner) {
    await ctx.db.patch(message.conversation_id, { owner_device_id: deviceId });
  }
  return true;
}

async function daemonCanMutateConversation(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
  deviceId?: string
): Promise<boolean> {
  if (!deviceId) return true;
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.user_id.toString() !== userId.toString()) return false;
  const owner = conversation.owner_device_id as string | undefined;
  if (owner && owner !== deviceId) return false;
  if (!owner) {
    await ctx.db.patch(conversationId, { owner_device_id: deviceId });
  }
  return true;
}

// A pending message has two parties with rights over it: the SENDER (from_user_id — can cancel,
// retry, and read status of their own outgoing message) and the OWNER (whose daemon delivers it
// and writes its status). For a self-send they're the same user; for a team send they differ.
// Every non-delivery mutation funnels through this so a teammate's daemon and the original sender
// can both act, but no unrelated user can.
async function senderOrOwnerCanAct(
  ctx: { db: any },
  message: { conversation_id: Id<"conversations">; from_user_id: Id<"users">; owner_user_id?: Id<"users"> },
  authUserId: Id<"users">
): Promise<boolean> {
  if (message.from_user_id.toString() === authUserId.toString()) return true;
  const conversation = await ctx.db.get(message.conversation_id);
  return !!conversation && pendingMessageOwnerId(message, conversation) === authUserId.toString();
}

export async function updatePendingMessageStatusForDaemon(
  ctx: { db: any },
  messageId: Id<"pending_messages">,
  userId: Id<"users">,
  deviceId: string,
  patch: { status: PendingStatus; delivered_at?: number }
): Promise<{ updated: boolean; skipped?: boolean }> {
  const message = await ctx.db.get(messageId);
  if (!message) return { updated: false, skipped: true };
  if (isTerminalPendingStatus(message.status)) return { updated: false, skipped: true };
  if (!(await daemonCanMutatePendingMessage(ctx, message, userId, deviceId))) {
    return { updated: false, skipped: true };
  }
  const updated = await patchPendingMessageStatus(ctx, message, patch);
  return { updated, skipped: !updated };
}

// Shared insert path for queueing a message to a conversation's daemon: dedups on
// client_id, inserts the pending row, and wakes the conversation (un-dismisses,
// flips completed→active). Both human sends (sendMessageToSession) and session→
// session sends (sendSessionMessage) funnel through here so the wake-up rules
// stay in one place.
export async function enqueuePendingMessage(
  ctx: { db: any },
  conversation: any,
  fromUserId: Id<"users">,
  fields: {
    content: string;
    image_storage_id?: Id<"_storage">;
    image_storage_ids?: Id<"_storage">[];
    client_id?: string;
    // The sender's own conversation, so the cron can notify the sending session if this message
    // can't be delivered. Only meaningful for cross-user (team) sends; omitted for self-sends.
    from_conversation_id?: Id<"conversations">;
  }
): Promise<Id<"pending_messages">> {
  if (fields.client_id) {
    const existing = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q: any) =>
        q.eq("conversation_id", conversation._id)
      )
      .filter((q: any) => q.eq(q.field("client_id"), fields.client_id))
      .first();
    if (existing) return existing._id;
  }

  const messageId = await ctx.db.insert("pending_messages", {
    conversation_id: conversation._id,
    from_user_id: fromUserId,
    // The daemon polls by owner; for a self-send this is the sender, for a team send the teammate.
    owner_user_id: conversation.user_id,
    from_conversation_id: fields.from_conversation_id,
    content: fields.content,
    image_storage_id: fields.image_storage_id,
    image_storage_ids: fields.image_storage_ids,
    client_id: fields.client_id,
    status: "pending" as const,
    created_at: Date.now(),
    retry_count: 0,
  });

  await ctx.db.patch(conversation._id, {
    updated_at: Date.now(),
    has_pending_messages: true,
    ...(conversation.status === "completed" ? { status: "active" } : {}),
    ...(conversation.inbox_dismissed_at ? { inbox_dismissed_at: undefined } : {}),
    ...(conversation.inbox_stashed_at ? { inbox_stashed_at: undefined } : {}),
    ...(conversation.inbox_killed_at ? { inbox_killed_at: undefined } : {}),
  });

  return messageId;
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

    return await enqueuePendingMessage(ctx, conversation, authUserId, {
      content: args.content,
      image_storage_id: args.image_storage_id,
      image_storage_ids: args.image_storage_ids,
      client_id: args.client_id,
    });
  },
});

// The wire format for a session→session message. The body is wrapped so the
// receiving agent (and the web client) can tell who sent it. Keep this tag name
// in sync with the parser in packages/web/components/ConversationView.tsx
// (classifyUserMessage / SessionMessageBlock).
export function formatSessionMessage(fromShortId: string, body: string, fromName?: string): string {
  // `name` is an optional display label for the sender — used when `from` doesn't
  // resolve to a clickable session (e.g. a link collaborator with no session of
  // their own). The parser tolerates the extra attribute, so old readers ignore it.
  const nameAttr = fromName ? ` name="${fromName.replace(/"/g, "'")}"` : "";
  return `<session-message from="${fromShortId}"${nameAttr}>\n${body}\n</session-message>`;
}

// True if the conversation has at least one managed session that has beaten its heartbeat
// recently — i.e. a daemon is alive and could deliver right now. Used to give the sender an
// immediate "looks offline" hint and to decide whether a stuck cross-user send has truly failed.
export async function conversationHasLiveSession(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  now: number
): Promise<boolean> {
  const sessions = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  return sessions.some((s: any) => now - (s.last_heartbeat ?? 0) < HEARTBEAT_ALIVE_MS);
}

// Send a message from one of the user's sessions to another — your own OR a teammate's. The
// target must be a session you can already see (own it, or it's shared to a team you're in); the
// access rule is exactly the feed-visibility rule (checkConversationAccess). The text is injected
// into the target session as a normal user turn (via the existing pending_messages rail), wrapped
// so both the agent and the UI can attribute it to the sender.
// The send itself, factored out of the mutation so it can be driven in tests without the auth
// wrapper. Resolves the target (own-or-team), attributes the sender, queues the message, and
// reports whether the target currently has a live daemon.
export async function performSessionSend(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { to: string; from?: string; body: string; client_id?: string }
): Promise<{
  message_id: Id<"pending_messages">;
  to_short_id: string;
  from_short_id: string;
  cross_user: boolean;
  target_live: boolean;
}> {
  const body = (args.body ?? "").trim();
  if (!body) throw new Error("Message body is empty");

  // Own-or-team: you can message any session the feed would let you see. A merely share-linked
  // session is read-only by default — injecting a turn is a stronger right than reading — UNLESS
  // its owner has granted this user explicit send access for it (collab_grants), the one approved
  // path for a link recipient to run commands in someone else's session.
  const target = await findConversationByAnyRefWhere(ctx, args.to, async (conversation) => {
    const access = await checkConversationAccess(ctx, authUserId, conversation);
    if (access === "owner" || access === "team") return true;
    if (access === "shared" && (await hasGrantedSendAccess(ctx, conversation._id, authUserId))) return true;
    return false;
  });
  if (!target) {
    throw new Error(`No session found for "${args.to}" (you can only message your own sessions, sessions shared with your team, or sessions whose owner granted you send access)`);
  }

  const isCrossUser = target.user_id.toString() !== authUserId.toString();

  // Resolve the sender to its short_id for attribution. The CLI passes whatever
  // detectCurrentSessionId found (a Claude session_id) or an explicit --from ref;
  // an unresolvable/missing sender still delivers, just without a clickable pill.
  let fromShortId = "unknown";
  let fromConversationId: Id<"conversations"> | undefined;
  if (args.from) {
    const sender = await findConversationByAnyRef(ctx, args.from, authUserId);
    if (sender) {
      fromShortId = sender.short_id ?? sender._id.toString().slice(0, 7);
      fromConversationId = sender._id;
    } else if (/^jx[a-z0-9]{5,}$/i.test(args.from.trim())) {
      fromShortId = args.from.trim().slice(0, 7);
    }
  }

  // Display name for the sender, shown when `from` has no clickable session (the
  // common case for a link collaborator). Only needed cross-user — a self-send is
  // already attributed by its own session pill.
  let fromName: string | undefined;
  if (isCrossUser) {
    const senderUser = await ctx.db.get(authUserId);
    fromName = senderUser?.name || senderUser?.github_username || undefined;
  }

  const messageId = await enqueuePendingMessage(ctx, target, authUserId, {
    content: formatSessionMessage(fromShortId, body, fromName),
    client_id: args.client_id,
    // Only a cross-user send needs the failure-feedback channel. A self-send keeps the original
    // never-drop semantics (your own busy session will get it when it's idle).
    from_conversation_id: isCrossUser ? fromConversationId : undefined,
  });

  // Immediate liveness signal so the CLI can warn "the session looks offline" right away,
  // rather than the sender only finding out via the cron's delayed notice.
  const targetLive = await conversationHasLiveSession(ctx, target._id, Date.now());

  return {
    message_id: messageId,
    to_short_id: target.short_id ?? target._id.toString().slice(0, 7),
    from_short_id: fromShortId,
    cross_user: isCrossUser,
    target_live: targetLive,
  };
}

export const sendSessionMessage = mutation({
  args: {
    to: v.string(),
    from: v.optional(v.string()),
    body: v.string(),
    client_id: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    return await performSessionSend(ctx, authUserId, args);
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
    device_id: v.optional(v.string()),
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

    if (!(await senderOrOwnerCanAct(ctx, message, authUserId))) {
      throw new Error("Unauthorized: can only update messages you sent or own");
    }

    if (args.device_id) {
      const result = await updatePendingMessageStatusForDaemon(ctx, args.message_id, authUserId, args.device_id, {
        status: args.status,
        delivered_at: args.delivered_at,
      });
      return { success: true, skipped: result.skipped };
    }

    await patchPendingMessageStatus(ctx, message, {
      status: args.status,
      delivered_at: args.delivered_at,
    });

    return { success: true };
  },
});

export const retryMessage = mutation({
  args: {
    message_id: v.id("pending_messages"),
    api_token: v.optional(v.string()),
    device_id: v.optional(v.string()),
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

    if (!(await senderOrOwnerCanAct(ctx, message, authUserId))) {
      throw new Error("Unauthorized: can only retry messages you sent or own");
    }

    if (isTerminalPendingStatus(message.status)) {
      return { success: true };
    }

    if (!(await daemonCanMutatePendingMessage(ctx, message, authUserId, args.device_id))) {
      return { success: true, skipped: true };
    }

    await rependPendingMessage(ctx, message, message.retry_count + 1);

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
    // Either party can stop it: the sender retracts their outgoing message, or the target owner
    // clears an unwanted incoming one from a teammate.
    if (!(await senderOrOwnerCanAct(ctx, message, authUserId))) {
      throw new Error("Unauthorized: can only cancel messages you sent or own");
    }

    await patchPendingMessageStatus(ctx, message, { status: "cancelled" as const });

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
      if (await rependPendingMessage(ctx, msg, 0)) resetCount++;
    }
  }

  if (resetCount > 0) {
    await ctx.db.patch(conversationId, { has_pending_messages: true });
  }

  return resetCount;
}

// Clear a conversation's has_pending_messages flag once nothing is still in flight — no
// `pending` and no `injected` message remains. Every terminal transition (delivered, cancelled)
// funnels through here so the flag, and therefore the inbox "Working" bucket, can never drift
// from the actual message state.
export async function clearHasPendingIfQuiet(
  ctx: { db: any },
  conversationId: Id<"conversations">
): Promise<void> {
  const remainingPending = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_status", (q: any) =>
      q.eq("conversation_id", conversationId).eq("status", "pending")
    )
    .first();
  if (remainingPending) return;
  const remainingInjected = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_status", (q: any) =>
      q.eq("conversation_id", conversationId).eq("status", "injected")
    )
    .first();
  if (!remainingInjected) {
    await ctx.db.patch(conversationId, { has_pending_messages: false });
  }
}

// Mark a single pending message delivered (terminal) and clear the conversation's
// has_pending_messages flag when nothing else is in flight. Shared by the content-matched
// ack inside addMessages (the reliable path — fires whenever the agent echoes the message,
// on any sync path) and available to other callers.
export async function markPendingDelivered(
  ctx: { db: any },
  message: { _id: Id<"pending_messages">; conversation_id: Id<"conversations">; status: string }
): Promise<void> {
  await patchPendingMessageStatus(ctx, message, { status: "delivered" as const, delivered_at: Date.now() });
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

// The set of pending messages THIS daemon should deliver: every still-pending row whose target
// conversation this user owns and this device may serve.
//
// We union two index scans rather than trusting owner_user_id to be set on every row:
//   - by_owner_status (owner_user_id) — finds teammate sends, where owner != sender.
//   - by_user_status (from_user_id)   — finds the user's OWN sends even if owner_user_id was never
//                                        stamped (a self-send's owner is always its sender).
// An index eq() can't match an unset optional field, so a self-send written by a path that forgot
// owner_user_id would be invisible to the owner scan alone — silently undeliverable. The legacy
// from_user_id scan is the safety net that makes delivery independent of that denormalization.
// canDaemonSeePendingMessage (which falls back owner_user_id ?? conversation.user_id) is the final
// gate on every candidate, so the union never delivers anything the owner shouldn't see.
export async function collectDeliverableForOwner(
  ctx: { db: any },
  ownerUserId: Id<"users">,
  deviceId: string
): Promise<any[]> {
  const [byOwner, bySender] = await Promise.all([
    ctx.db
      .query("pending_messages")
      .withIndex("by_owner_status", (q: any) =>
        q.eq("owner_user_id", ownerUserId).eq("status", "pending")
      )
      .collect(),
    ctx.db
      .query("pending_messages")
      .withIndex("by_user_status", (q: any) =>
        q.eq("from_user_id", ownerUserId).eq("status", "pending")
      )
      .collect(),
  ]);

  const owned = [];
  const seen = new Set<string>();
  for (const message of [...byOwner, ...bySender]) {
    const key = message._id.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const conversation = await ctx.db.get(message.conversation_id);
    if (conversation && canDaemonSeePendingMessage(message, conversation, ownerUserId, deviceId)) {
      owned.push(message);
    }
  }
  return owned;
}

export const getPendingMessagesForDaemon = query({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    return await collectDeliverableForOwner(ctx, authUserId, args.device_id);
  },
});

export const claimPendingMessageForDelivery = mutation({
  args: {
    message_id: v.id("pending_messages"),
    api_token: v.optional(v.string()),
    device_id: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    return await claimPendingMessageForDaemon(ctx, args.message_id, authUserId, args.device_id);
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

    // The owner of this conversation sees the "delivering…" indicator for ANY in-flight message
    // on it (including one a teammate sent them); the sender also sees their own outgoing one.
    const conversation = await ctx.db.get(args.conversation_id);
    const isOwner = conversation?.user_id?.toString() === authUserId.toString();
    const visible = msgs.filter(
      (m) => isOwner || m.from_user_id.toString() === authUserId.toString()
    );
    const msg = visible.find((m) => m.status === "pending")
      ?? visible.find((m) => m.status === "injected")
      ?? visible.find((m) => m.status === "failed")
      ?? visible.find((m) => m.status === "undeliverable")
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

    if (!(await senderOrOwnerCanAct(ctx, message, authUserId))) {
      throw new Error("Unauthorized: can only check status of messages you sent or own");
    }

    return {
      status: message.status,
      created_at: message.created_at,
      delivered_at: message.delivered_at,
      retry_count: message.retry_count,
    };
  },
});

// A user message is never dropped, and there is no age ceiling: a stranded message stays alive
// until it is delivered. What the cron gates on is not age but session READINESS (see
// retryStuckMessages / readyConversationIds) — it only re-pends a stray when the session is live
// and idle, so a busy/blocked/offline session just waits instead of thrashing. planStuckMessageHeal
// is the pure per-message decision once the session is known ready.
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

  if (msg.status === "injected") {
    if (age < INJECT_ACK_GRACE_MS) return { kind: "skip" };
    // Control messages have no JSONL echo to ack against; a stale "injected" one was already
    // successfully injected, so promote it to terminal "delivered" rather than re-injecting.
    if (isControlMessage(msg.content)) return { kind: "deliver_control" };
    return { kind: "repend" };
  }
  // "undeliverable" is NOT a dead-end: the daemon raises it after its gentle-retry budget is
  // spent (a useful "escalate" signal), but it is revived (once the session is idle — see the
  // cron's readiness gate) so delivery keeps moving forward with no client present. "failed" is
  // the transient sync-failure sibling.
  if (msg.status === "failed" || msg.status === "undeliverable") return { kind: "repend" };

  // "pending" is normally the daemon's live subscription to drive — but only WHILE delivery is
  // actually in flight (the first ~seconds). The retry-forever design had a single point of
  // failure here: the daemon's pending->injected write (markInjectedBestEffort) races an 8s
  // timeout and swallows failure, and this deployment drops writes under OCC load. When that
  // write is lost the row is stuck "pending" forever — the cron skipped pending entirely, and
  // getPendingMessages only re-fires the reactive subscription when the pending SET changes,
  // which a dropped write never does. So a message whose Enter was lost AND whose status write
  // dropped had no backstop at all. Revive it once it is older than any legitimate in-flight
  // delivery (and, via the cron's readiness gate, only when the session is idle and ready). This
  // can never duplicate a delivered message: anything that actually reached the agent is promoted
  // to terminal "delivered" by the content-matched ack in addMessages, so a row still "pending"
  // at this age provably never landed. We don't bump retry_count (repend resets it), so this
  // never conflates elapsed wait time with the real-attempt budget — the original "don't touch
  // pending" bug is structurally avoided.
  if (msg.status === "pending") {
    if (age < INJECT_ACK_GRACE_MS) return { kind: "skip" };
    // Leave poll-keystroke control messages to the normal flow: re-pending a keystroke risks
    // double-selecting a poll option, and they aren't the stranded-text case this backstop targets.
    if (isControlMessage(msg.content)) return { kind: "skip" };
    return { kind: "repend" };
  }
  return { kind: "skip" };
}

const HEARTBEAT_ALIVE_MS = 90 * 1000;

// The cron only revives a stranded message when its session is live AND idle — i.e. ready to
// receive it right now. A user message is NEVER dropped: if the session is busy, blocked, stopped,
// resuming, or gone, the message is left untouched and revived on a later tick once the session
// recovers (becomes idle). This readiness gate is what keeps a backlog from stampeding the daemon
// into mass resumes (storm) or re-injecting into a busy agent (thrash) — when blocked we simply
// wait; the second the session is idle, every queued message for it goes.
// Returns two sets keyed by conversation id: `live` (a daemon for it beat its heartbeat recently,
// regardless of what the agent is doing) and `ready` (live AND the agent is idle, so it can take a
// message right now). The cross-user notifier needs `live` to tell "busy" (alive but not idle —
// keep waiting) apart from "offline" (no live daemon — the remote isn't responding).
async function liveAndReadyConversationIds(
  ctx: { db: any },
  now: number
): Promise<{ ready: Set<string>; live: Set<string> }> {
  const sessions = await ctx.db
    .query("managed_sessions")
    .withIndex("by_heartbeat", (q: any) => q.gt("last_heartbeat", now - HEARTBEAT_ALIVE_MS))
    .collect();
  const ready = new Set<string>();
  const live = new Set<string>();
  for (const s of sessions) {
    if (!s.conversation_id) continue;
    live.add(s.conversation_id.toString());
    if (s.agent_status === "idle") ready.add(s.conversation_id.toString());
  }
  return { ready, live };
}

// How long a cross-user (team) message may sit undelivered before we tell the sending session.
// Comfortably past the heartbeat window (90s) so a brief daemon reconnect doesn't read as "offline".
export const CROSS_USER_NOTIFY_DEADLINE_MS = 3 * 60_000;

export type CrossUserNotify = { kind: "skip" } | { kind: "notify"; giveUp: boolean };

// Pure decision: should the sender be told this cross-user message is stuck, and should we give up?
// Fires at most once (gated on sender_notified_at). "giveUp" means the target has no live daemon —
// the remote genuinely isn't responding, so we cancel rather than let it haunt the teammate's inbox
// forever. If the target is merely busy (alive but not idle) we keep waiting and only tell the
// sender it's delayed. Self-sends (from == owner) and rows with no sender session are never notified.
export function planCrossUserNotify(
  msg: {
    status: string;
    created_at: number;
    sender_notified_at?: number;
    from_conversation_id?: Id<"conversations">;
    from_user_id: Id<"users">;
    owner_user_id?: Id<"users">;
  },
  targetLive: boolean,
  now: number
): CrossUserNotify {
  if (msg.status === "delivered" || msg.status === "cancelled") return { kind: "skip" };
  if (!msg.from_conversation_id) return { kind: "skip" }; // no sender session to notify
  if (msg.sender_notified_at) return { kind: "skip" }; // already told them once
  if (!msg.owner_user_id) return { kind: "skip" }; // legacy/unknown owner
  if (msg.from_user_id.toString() === msg.owner_user_id.toString()) return { kind: "skip" }; // self-send
  if (now - msg.created_at < CROSS_USER_NOTIFY_DEADLINE_MS) return { kind: "skip" };
  return { kind: "notify", giveUp: !targetLive };
}

// Deliver a delivery-failure / delay receipt back into the sender's own session and mark the
// original so we don't notify again. When the target is offline (giveUp) the original is cancelled.
async function notifyStuckCrossUserSend(
  ctx: { db: any },
  msg: any,
  giveUp: boolean
): Promise<void> {
  const senderConv = await ctx.db.get(msg.from_conversation_id);
  if (!senderConv) {
    // Sender's session is gone — nowhere to report; just stop re-evaluating this row.
    await ctx.db.patch(msg._id, { sender_notified_at: Date.now() });
    if (giveUp) await patchPendingMessageStatus(ctx, msg, { status: "cancelled" as const });
    return;
  }
  const targetConv = await ctx.db.get(msg.conversation_id);
  const targetLabel = targetConv?.short_id ?? msg.conversation_id.toString().slice(0, 7);
  const preview = (msg.content ?? "").replace(/<\/?session-message[^>]*>/g, "").trim().slice(0, 140);
  const body = giveUp
    ? `Your message to session ${targetLabel} could not be delivered — it has no live daemon (the session appears offline). The message was dropped, so resend it once the session is back online.\n\n> ${preview}`
    : `Your message to session ${targetLabel} hasn't been delivered yet — the session is busy. It stays queued and will be delivered automatically the moment the session goes idle; no action needed.\n\n> ${preview}`;

  // The receipt goes into the sender's OWN conversation, so from_user == owner == the sender:
  // it's a normal self-scoped message (never itself a cross-user send), and enqueue wakes the
  // sender's session so the agent notices the outcome.
  await enqueuePendingMessage(ctx, senderConv, msg.from_user_id, {
    content: formatSessionMessage("codecast", body),
  });
  await ctx.db.patch(msg._id, { sender_notified_at: Date.now() });
  if (giveUp) await patchPendingMessageStatus(ctx, msg, { status: "cancelled" as const });
}

export const retryStuckMessages = internalMutation({
  handler: async (ctx) => {
    await healAndNotifyStuckMessages(ctx, Date.now());
  },
});

// The cron's work, extracted so it can be driven deterministically in tests with a fixed `now`.
// Two jobs: (1) revive stranded messages once their session is idle (the never-drop backstop),
// and (2) tell the sending session when a cross-user message is stuck past the deadline.
export async function healAndNotifyStuckMessages(ctx: { db: any }, now: number): Promise<{
  revived: number;
  controlsAcked: number;
  notified: number;
  waiting: number;
}> {
  {
    // Scan every non-terminal state. `delivered`/`cancelled` are terminal so they're skipped.
    // `pending` is included because a dropped daemon status-write (markInjectedBestEffort) can
    // strand a never-delivered message there with no other backstop; planStuckMessageHeal only
    // revives a pending row once it's older than any legitimate in-flight delivery, so fresh
    // pending (the daemon's live work) is left untouched.
    // Read ONLY non-terminal rows via the by_status index. The previous
    // `.filter().collect()` scanned the entire pending_messages table (every
    // delivered/cancelled row in history) on every 30s run, holding a read
    // dependency on the whole table that OCC-conflicted with every addMessages
    // pending-write — a self-amplifying stampede that timed out syncs and let the
    // backlog (and thus the scan cost) grow without bound.
    const candidates: any[] = [];
    for (const status of ["pending", "injected", "failed", "undeliverable"] as const) {
      const rows = await ctx.db
        .query("pending_messages")
        .withIndex("by_status", (q: any) => q.eq("status", status))
        .collect();
      candidates.push(...rows);
    }

    const { ready, live } = await liveAndReadyConversationIds(ctx, now);

    let revived = 0;
    let controlsAcked = 0;
    let waiting = 0;
    let notified = 0;
    const reflag = new Set<Id<"conversations">>();
    for (const msg of candidates) {
      // Cross-user feedback runs regardless of the target's readiness: a teammate's message stuck
      // past the deadline should tell the sender whether it's merely delayed (target busy) or
      // failed (target offline). planCrossUserNotify no-ops on self-sends and already-notified rows.
      const crossUserNotify = planCrossUserNotify(msg, live.has(msg.conversation_id.toString()), now);
      if (crossUserNotify.kind === "notify") {
        await notifyStuckCrossUserSend(ctx, msg, crossUserNotify.giveUp);
        notified++;
        if (crossUserNotify.giveUp) continue; // cancelled — nothing more to do with this row
      }
      // Session not ready to receive (busy / blocked / stopped / gone): leave the message
      // exactly as-is — preserved, never dropped — and revive it once the session is idle.
      if (!ready.has(msg.conversation_id.toString())) {
        waiting++;
        continue;
      }
      const action = planStuckMessageHeal(msg, now);
      if (action.kind === "skip") continue;
      if (action.kind === "deliver_control") {
        await markPendingDelivered(ctx, msg);
        controlsAcked++;
        continue;
      }
      if (await rependPendingMessage(ctx, msg, 0)) {
        reflag.add(msg.conversation_id);
        revived++;
      }
    }
    for (const convId of reflag) {
      await ctx.db.patch(convId, { has_pending_messages: true });
    }

    if (revived > 0 || controlsAcked > 0 || notified > 0) {
      console.log(`retryStuckMessages: revived ${revived} for idle sessions, acked ${controlsAcked} control msg(s), notified ${notified} stuck cross-user send(s), ${waiting} waiting on a busy/offline session`);
    }
    return { revived, controlsAcked, notified, waiting };
  }
}

// Non-terminal states: a message in any of these is still "in flight" and keeps the
// conversation's has_pending_messages flag true (and the inbox card in "Working").
const NON_TERMINAL_STATUSES = ["pending", "injected", "failed", "undeliverable"] as const;

// One-time: stamp owner_user_id on rows created before the field existed, so the daemon's
// by_owner_status poll finds them. Only non-terminal rows matter (terminal ones never deliver).
// For every legacy row owner == from_user (sends were self-only then), but we read the real
// conversation owner to be exact. Idempotent — skips rows that already have owner_user_id.
export const backfillPendingOwnerUserId = internalMutation({
  args: {},
  handler: async (ctx) => {
    let stamped = 0;
    for (const status of NON_TERMINAL_STATUSES) {
      const rows = await ctx.db
        .query("pending_messages")
        .withIndex("by_status", (q: any) => q.eq("status", status))
        .collect();
      for (const row of rows) {
        if (row.owner_user_id) continue;
        const conversation = await ctx.db.get(row.conversation_id);
        const ownerId = conversation?.user_id ?? row.from_user_id;
        await ctx.db.patch(row._id, { owner_user_id: ownerId });
        stamped++;
      }
    }
    return { stamped };
  },
});

// One-time audit: bucket every non-terminal (still-in-flight) pending message by age, so we can
// see the backlog of strays before flipping on always-deliver. Read-only.
export const auditStrandedMessages = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const HOUR = 60 * 60_000;
    const buckets = { under_1h: 0, h1_to_6h: 0, h6_to_24h: 0, d1_to_7d: 0, over_7d: 0 };
    const byStatus: Record<string, number> = {};
    let total = 0;
    let oldestAgeMs = 0;
    for (const status of NON_TERMINAL_STATUSES) {
      const rows = await ctx.db
        .query("pending_messages")
        .filter((q) => q.eq(q.field("status"), status))
        .collect();
      byStatus[status] = rows.length;
      for (const r of rows) {
        total++;
        const age = now - r.created_at;
        if (age > oldestAgeMs) oldestAgeMs = age;
        if (age < HOUR) buckets.under_1h++;
        else if (age < 6 * HOUR) buckets.h1_to_6h++;
        else if (age < 24 * HOUR) buckets.h6_to_24h++;
        else if (age < 7 * 24 * HOUR) buckets.d1_to_7d++;
        else buckets.over_7d++;
      }
    }
    return { total, byStatus, buckets, oldestAgeHours: Math.round((oldestAgeMs / HOUR) * 10) / 10 };
  },
});


// Per-message diagnostic for "the cron keeps logging revived N / M waiting but nothing clears".
// Read-only. For every non-terminal message it reproduces the cron's readiness gate verdict and
// joins the consuming session(s) so we can see WHY a row won't reach terminal `delivered`:
//   - ready_per_gate true  -> the cron revives it every tick; if it never clears, the bound session
//     reads idle+live but isn't actually consuming the re-pend (false-idle / split-brain / wrong owner).
//   - ready_per_gate false -> parked by design on a busy/blocked/offline session (the "waiting" bucket).
export const diagnoseStuckMessages = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const candidates: any[] = [];
    for (const status of NON_TERMINAL_STATUSES) {
      const r = await ctx.db
        .query("pending_messages")
        .withIndex("by_status", (q: any) => q.eq("status", status))
        .collect();
      candidates.push(...r);
    }
    const out = [];
    for (const m of candidates) {
      const conv: any = await ctx.db.get(m.conversation_id);
      const sessions = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", m.conversation_id))
        .collect();
      const sess = sessions.map((s: any) => ({
        session_id: s.session_id,
        agent_status: s.agent_status ?? null,
        heartbeat_age_s: Math.round((now - s.last_heartbeat) / 1000),
        live: now - s.last_heartbeat < HEARTBEAT_ALIVE_MS,
        pid: s.pid,
      }));
      const ready = sess.some((s) => s.live && s.agent_status === "idle");
      out.push({
        msg_id: m._id,
        status: m.status,
        age_min: Math.round((now - m.created_at) / 60000),
        retry_count: m.retry_count,
        is_control: isControlMessage(m.content),
        preview: m.content.slice(0, 60),
        conversation_id: m.conversation_id,
        conv_title: conv?.title ?? null,
        conv_has_pending_flag: conv?.has_pending_messages ?? null,
        conv_owner_device_id: conv?.owner_device_id ?? null,
        conv_project_path: conv?.project_path ?? null,
        ready_per_gate: ready,
        session_count: sess.length,
        sessions: sess,
      });
    }
    out.sort((a, b) => Number(b.ready_per_gate) - Number(a.ready_per_gate) || b.age_min - a.age_min);
    return {
      count: out.length,
      revived_bucket: out.filter((m) => m.ready_per_gate).length,
      waiting_bucket: out.filter((m) => !m.ready_per_gate).length,
      messages: out,
    };
  },
});

// Kept for old operator tooling, but cancelled is now terminal and must not be revived.
export const restoreCancelledMessages = internalMutation({
  args: { min_age_ms: v.number(), dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    return { restored: 0, conversations: 0, dry_run: !!args.dry_run };
  },
});

// EXPLICIT, USER-INITIATED bulk cancel. The cardinal rule forbids the system from EVER dropping a
// user message on its own — but the user can choose to stop messages, and this is the bulk form of
// that (cancel = the same terminal state as the per-message cancelPendingMessage button). It is
// only ever invoked by hand on explicit request (e.g. "kill the really old pending messages"),
// never wired into a cron. Cancels non-terminal messages older than `older_than_ms` and clears the
// conversation flag. dry_run reports the count without mutating.
export const cancelOldPendingMessages = internalMutation({
  args: { older_than_ms: v.number(), dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.older_than_ms;
    const affectedConvs = new Set<Id<"conversations">>();
    let cancelled = 0;
    for (const status of ["pending", "injected", "failed", "undeliverable"] as const) {
      const rows = await ctx.db
        .query("pending_messages")
        .filter((q) => q.and(q.eq(q.field("status"), status), q.lt(q.field("created_at"), cutoff)))
        .collect();
      for (const r of rows) {
        affectedConvs.add(r.conversation_id);
        if (!args.dry_run) {
          await ctx.db.patch(r._id, { status: "cancelled" as const });
        }
        cancelled++;
      }
    }
    if (!args.dry_run) {
      for (const convId of affectedConvs) {
        await clearHasPendingIfQuiet(ctx, convId);
      }
    }
    return { cancelled, conversations: affectedConvs.size, dry_run: !!args.dry_run };
  },
});

// Ack: mark all "injected" messages for a conversation as "delivered"
// Called by the daemon when the user's message appears in the synced JSONL
export const ackInjectedMessages = mutation({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
    device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed");
    }

    if (!(await daemonCanMutateConversation(ctx, args.conversation_id, authUserId, args.device_id))) {
      return { acked: 0, skipped: true };
    }

    const injected = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", args.conversation_id).eq("status", "injected")
      )
      .collect();

    for (const msg of injected) {
      await markPendingDelivered(ctx, msg);
    }

    return { acked: injected.length };
  },
});

// Reset: move "injected" messages back to "pending" (e.g. after session kill)
export const resetInjectedMessages = mutation({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
    device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed");
    }

    if (!(await daemonCanMutateConversation(ctx, args.conversation_id, authUserId, args.device_id))) {
      return { reset: 0, skipped: true };
    }

    const injected = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", args.conversation_id).eq("status", "injected")
      )
      .collect();

    let reset = 0;
    for (const msg of injected) {
      if (await rependPendingMessage(ctx, msg, msg.retry_count + 1)) reset++;
    }

    if (reset > 0) {
      await ctx.db.patch(args.conversation_id, { has_pending_messages: true });
    }

    return { reset };
  },
});
