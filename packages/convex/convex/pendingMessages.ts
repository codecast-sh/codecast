import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { findConversationByAnyRef } from "./conversationSessionLookup";

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

export function canDaemonSeePendingMessage(
  message: { from_user_id: Id<"users">; status: string },
  conversation: { user_id: Id<"users">; owner_device_id?: string },
  userId: Id<"users">,
  deviceId: string
): boolean {
  if (message.from_user_id.toString() !== userId.toString()) return false;
  if (conversation.user_id.toString() !== userId.toString()) return false;
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
  message: { conversation_id: Id<"conversations">; from_user_id: Id<"users"> },
  userId: Id<"users">,
  deviceId?: string
): Promise<boolean> {
  if (!deviceId) return true;
  if (message.from_user_id.toString() !== userId.toString()) return false;
  const conversation = await ctx.db.get(message.conversation_id);
  if (!conversation || conversation.user_id.toString() !== userId.toString()) return false;
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
export function formatSessionMessage(fromShortId: string, body: string): string {
  return `<session-message from="${fromShortId}">\n${body}\n</session-message>`;
}

// Send a message from one of the user's sessions to another. The text is injected
// into the target session as a normal user turn (via the existing pending_messages
// rail), wrapped so both the agent and the UI can attribute it to the sender.
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

    const body = (args.body ?? "").trim();
    if (!body) throw new Error("Message body is empty");

    const target = await findConversationByAnyRef(ctx, args.to, authUserId);
    if (!target) {
      throw new Error(`No session found for "${args.to}" (you can only message your own sessions)`);
    }

    // Resolve the sender to its short_id for attribution. The CLI passes whatever
    // detectCurrentSessionId found (a Claude session_id) or an explicit --from ref;
    // an unresolvable/missing sender still delivers, just without a clickable pill.
    let fromShortId = "unknown";
    if (args.from) {
      const sender = await findConversationByAnyRef(ctx, args.from, authUserId);
      if (sender) fromShortId = sender.short_id ?? sender._id.toString().slice(0, 7);
      else if (/^jx[a-z0-9]{5,}$/i.test(args.from.trim())) fromShortId = args.from.trim().slice(0, 7);
    }

    const messageId = await enqueuePendingMessage(ctx, target, authUserId, {
      content: formatSessionMessage(fromShortId, body),
      client_id: args.client_id,
    });

    return {
      message_id: messageId,
      to_short_id: target.short_id ?? target._id.toString().slice(0, 7),
      from_short_id: fromShortId,
    };
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

    if (message.from_user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only update your own messages");
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

    if (message.from_user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only retry your own messages");
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
    if (message.from_user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only cancel your own messages");
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

    const messages = await ctx.db
      .query("pending_messages")
      .withIndex("by_user_status", (q) =>
        q.eq("from_user_id", authUserId).eq("status", "pending")
      )
      .collect();

    const owned = [];
    for (const message of messages) {
      const conversation = await ctx.db.get(message.conversation_id);
      if (conversation && canDaemonSeePendingMessage(message, conversation, authUserId, args.device_id)) {
        owned.push(message);
      }
    }
    return owned;
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
async function readyConversationIds(ctx: { db: any }, now: number): Promise<Set<string>> {
  const live = await ctx.db
    .query("managed_sessions")
    .withIndex("by_heartbeat", (q: any) => q.gt("last_heartbeat", now - HEARTBEAT_ALIVE_MS))
    .collect();
  const ready = new Set<string>();
  for (const s of live) {
    if (s.conversation_id && s.agent_status === "idle") {
      ready.add(s.conversation_id.toString());
    }
  }
  return ready;
}

export const retryStuckMessages = internalMutation({
  handler: async (ctx) => {
    const now = Date.now();

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

    const ready = await readyConversationIds(ctx, now);

    let revived = 0;
    let controlsAcked = 0;
    let waiting = 0;
    const reflag = new Set<Id<"conversations">>();
    for (const msg of candidates) {
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

    if (revived > 0 || controlsAcked > 0) {
      console.log(`retryStuckMessages: revived ${revived} for idle sessions, acked ${controlsAcked} control msg(s), ${waiting} waiting on a busy/offline session`);
    }
  },
});

// Non-terminal states: a message in any of these is still "in flight" and keeps the
// conversation's has_pending_messages flag true (and the inbox card in "Working").
const NON_TERMINAL_STATUSES = ["pending", "injected", "failed", "undeliverable"] as const;

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
