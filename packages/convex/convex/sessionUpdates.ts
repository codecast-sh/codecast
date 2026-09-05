import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import {
  formatSessionUpdateBatch,
  SESSION_UPDATE_WINDOW_MS,
  SESSION_UPDATE_MAX_HOLD_MS,
  SESSION_UPDATE_MAX_MEMBERS,
  SESSION_UPDATE_MAX_BATCH_BYTES,
  SESSION_UPDATE_MAX_BODY_BYTES,
  type SessionUpdateMember,
} from "@codecast/shared/contracts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./functions";
import { findConversationByAnyRef, findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { canSendProductMessage, enqueuePendingMessage, getAuthenticatedUserId } from "./pendingMessages";

const MAX_QUEUED_ITEMS = 128;
const MAX_QUEUED_BYTES = 256 * 1024;
const LIVE_HEARTBEAT_MS = 90_000;
const RECOVERY_PAGE_SIZE = 64;
const encoder = new TextEncoder();

type Update = Doc<"session_updates">;
type ReceiptArgs = { update_id: Id<"session_updates">; api_token?: string };
type QueueArgs = { to: string; from: string; body: string; client_id: string; api_token?: string };
type RecoveryArgs = { cursor?: string; cutoff?: number };

export type SessionUpdateReceipt = {
  update_id: Id<"session_updates">;
  client_id: string;
  to_short_id: string;
  from_short_id: string;
  state: Update["state"];
  queued_at: number;
  flush_by: number;
  pending_message_id?: Id<"pending_messages">;
  pending_status?: Doc<"pending_messages">["status"];
  delivery_status?: string;
  echo_message_id?: Id<"messages">;
  delivered_at?: number;
  reason?: string;
  members_count?: number;
  cancellation?: "cancelled" | "already_cancelled" | "too_late" | "not_queued";
};

function member(row: Update): SessionUpdateMember {
  return { id: row._id, from: row.from_short_id, sent_at: row.created_at, body: row.body };
}

function batchId(row: Update): string {
  return `session-update:${row._id}`;
}

function batchBytes(id: string, members: SessionUpdateMember[]): number {
  return encoder.encode(formatSessionUpdateBatch(id, members)).byteLength;
}

function queued(ctx: QueryCtx, conversationId: Id<"conversations">) {
  return ctx.db.query("session_updates")
    .withIndex("by_conversation_state_created", (q) =>
      q.eq("conversation_id", conversationId).eq("state", "queued"))
    .order("asc");
}

async function authenticated(ctx: QueryCtx, token?: string): Promise<Id<"users">> {
  const userId = await getAuthenticatedUserId(ctx, token);
  if (!userId) throw new Error("Authentication failed: invalid token or session");
  return userId;
}

async function ownedUpdate(ctx: QueryCtx, args: ReceiptArgs): Promise<Update> {
  const userId = await authenticated(ctx, args.api_token);
  const row = await ctx.db.get(args.update_id);
  if (!row || row.from_user_id !== userId) throw new Error("Update not found");
  return row;
}

async function receipt(ctx: QueryCtx, row: Update): Promise<SessionUpdateReceipt> {
  const result: SessionUpdateReceipt = {
    update_id: row._id,
    client_id: row.client_id,
    to_short_id: row.to_short_id,
    from_short_id: row.from_short_id,
    state: row.state,
    queued_at: row.created_at,
    flush_by: row.hard_deadline,
    ...(row.reason ? { reason: row.reason } : {}),
  };
  if (!row.pending_message_id) return result;
  const pending = await ctx.db.get(row.pending_message_id);
  result.pending_message_id = row.pending_message_id;
  if (!pending) return { ...result, delivery_status: "unknown", reason: "Pending delivery record is unavailable" };
  const siblings = await ctx.db.query("session_updates")
    .withIndex("by_pending_message", (q) => q.eq("pending_message_id", row.pending_message_id))
    .take(SESSION_UPDATE_MAX_MEMBERS);
  return {
    ...result,
    members_count: siblings.length,
    pending_status: pending.status,
    delivery_status: pending.delivery_status ?? pending.status,
    ...(pending.echo_message_id ? { echo_message_id: pending.echo_message_id } : {}),
    ...(pending.delivered_at !== undefined ? { delivered_at: pending.delivered_at } : {}),
    ...(pending.delivery_disposition_reason ? { reason: pending.delivery_disposition_reason } : {}),
  };
}

export const queueUpdate: RegisteredMutation<"public", QueueArgs, Promise<SessionUpdateReceipt>> = mutation({
  args: { to: v.string(), from: v.string(), body: v.string(), client_id: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SessionUpdateReceipt> => {
    const userId = await authenticated(ctx, args.api_token);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.client_id)) {
      throw new Error("client_id must be a stable UUID");
    }
    const clientId = args.client_id;
    const toRef = args.to.trim();
    const fromRef = args.from.trim();
    const existing = await ctx.db.query("session_updates")
      .withIndex("by_user_client_id", (q) => q.eq("from_user_id", userId).eq("client_id", clientId))
      .unique();
    if (existing) {
      if (existing.to_ref !== toRef || existing.from_ref !== fromRef || existing.body !== args.body) {
        throw new Error("Request ID already belongs to a different update");
      }
      return receipt(ctx, existing);
    }
    if (!args.body.trim()) throw new Error("Update body is empty");
    if (encoder.encode(args.body).byteLength > SESSION_UPDATE_MAX_BODY_BYTES) {
      throw new Error(`Update body exceeds ${SESSION_UPDATE_MAX_BODY_BYTES} bytes`);
    }
    const source = await findConversationByAnyRef(ctx, fromRef, userId);
    if (!source) throw new Error("Sender session not found or not owned by you");
    const target = await findConversationByAnyRefWhere(ctx, toRef,
      (conversation) => canSendProductMessage(ctx, userId, conversation));
    if (!target) throw new Error("Target session not found or send access denied");
    const waiting = await queued(ctx, target._id).take(MAX_QUEUED_ITEMS);
    if (waiting.length >= MAX_QUEUED_ITEMS) throw new Error("Target update queue is full (128 items)");
    const now = Date.now();
    const id = await ctx.db.insert("session_updates", {
      conversation_id: target._id,
      owner_user_id: target.user_id,
      from_user_id: userId,
      from_conversation_id: source._id,
      from_short_id: source.short_id ?? String(source._id).slice(0, 7),
      to_short_id: target.short_id ?? String(target._id).slice(0, 7),
      to_ref: toRef,
      from_ref: fromRef,
      client_id: clientId,
      body: args.body,
      created_at: now,
      soft_deadline: now + SESSION_UPDATE_WINDOW_MS,
      hard_deadline: now + SESSION_UPDATE_MAX_HOLD_MS,
      state: "queued",
      encoded_bytes: 0,
    });
    const row = (await ctx.db.get(id))!;
    const size = batchBytes(batchId(row), [member(row)]);
    if (size > SESSION_UPDATE_MAX_BATCH_BYTES) throw new Error("Encoded update cannot fit in one batch");
    if (waiting.reduce((sum, update) => sum + update.encoded_bytes, size) > MAX_QUEUED_BYTES) {
      throw new Error("Target update queue is full (256 KiB)");
    }
    await ctx.db.patch(id, { encoded_bytes: size });
    if (waiting.length === 0) {
      await ctx.scheduler.runAfter(SESSION_UPDATE_WINDOW_MS, internal.sessionUpdates.flushConversation, { conversation_id: target._id });
    }
    return receipt(ctx, row);
  },
});

export const getUpdateStatus: RegisteredQuery<"public", ReceiptArgs, Promise<SessionUpdateReceipt>> = query({
  args: { update_id: v.id("session_updates"), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SessionUpdateReceipt> => receipt(ctx, await ownedUpdate(ctx, args)),
});

export const cancelUpdate: RegisteredMutation<"public", ReceiptArgs, Promise<SessionUpdateReceipt>> = mutation({
  args: { update_id: v.id("session_updates"), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SessionUpdateReceipt> => {
    const row = await ownedUpdate(ctx, args);
    if (row.state !== "queued") {
      return { ...await receipt(ctx, row), cancellation: row.state === "enqueued" ? "too_late" : row.state === "cancelled" ? "already_cancelled" : "not_queued" };
    }
    await ctx.db.patch(row._id, { state: "cancelled" });
    await scheduleNext(ctx, row.conversation_id);
    return { ...await receipt(ctx, { ...row, state: "cancelled" }), cancellation: "cancelled" };
  },
});

async function scheduleNext(ctx: MutationCtx, conversationId: Id<"conversations">): Promise<void> {
  const next = await queued(ctx, conversationId).first();
  if (next) {
    await ctx.scheduler.runAfter(Math.max(0, next.soft_deadline - Date.now()),
      internal.sessionUpdates.flushConversation, { conversation_id: conversationId });
  }
}

async function activelyWorking(ctx: QueryCtx, target: Doc<"conversations">, now: number): Promise<boolean> {
  if (target.status === "completed" || target.inbox_killed_at) return false;
  const sessions = await ctx.db.query("managed_sessions")
    .withIndex("by_conversation_id", (q) => q.eq("conversation_id", target._id))
    .take(16);
  return sessions.some((session) => session.user_id === target.user_id
    && !session.hibernated_at && session.pid > 0
    && session.last_heartbeat > now - LIVE_HEARTBEAT_MS
    && (session.agent_status === "working" || session.agent_status === "thinking"));
}

export const flushConversation: RegisteredMutation<"internal", { conversation_id: Id<"conversations"> }, Promise<void>> = internalMutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<void> => {
    const rows = await queued(ctx, args.conversation_id).take(SESSION_UPDATE_MAX_MEMBERS);
    const oldest = rows[0];
    if (!oldest) return;
    const now = Date.now();
    const target = await ctx.db.get(args.conversation_id);
    const busy = now < oldest.hard_deadline && target && await activelyWorking(ctx, target, now);
    const nextCheck = now < oldest.soft_deadline ? oldest.soft_deadline
      : busy ? Math.min(now + SESSION_UPDATE_WINDOW_MS, oldest.hard_deadline) : now;
    if (nextCheck > now) {
      await ctx.scheduler.runAfter(nextCheck - now, internal.sessionUpdates.flushConversation, args);
      return;
    }
    const selected: Update[] = [];
    for (const row of rows) {
      if (row.from_user_id !== oldest.from_user_id) break;
      const source = await ctx.db.get(row.from_conversation_id);
      const reason = !source || source.user_id !== row.from_user_id ? "Sender session no longer owned by sender"
        : !target || target.user_id !== row.owner_user_id ? "Target session or owner changed"
        : !await canSendProductMessage(ctx, row.from_user_id, target) ? "Target send access revoked" : undefined;
      if (reason) {
        await ctx.db.patch(row._id, { state: "rejected", reason });
        continue;
      }
      const size = batchBytes(batchId(selected[0] ?? row), [...selected, row].map(member));
      if (size > SESSION_UPDATE_MAX_BATCH_BYTES) {
        if (selected.length > 0) break;
        await ctx.db.patch(row._id, { state: "rejected", reason: "Encoded update no longer fits in a batch" });
        continue;
      }
      selected.push(row);
    }
    if (selected.length > 0 && target) {
      const first = selected[0];
      const id = batchId(first);
      const content = formatSessionUpdateBatch(id, selected.map(member));
      const fromConversationId = first.from_user_id !== target.user_id ? first.from_conversation_id : undefined;
      const existing = await ctx.db.query("pending_messages")
        .withIndex("by_conversation_client_id", (q) => q.eq("conversation_id", target._id).eq("client_id", id))
        .first();
      if (existing && (existing.content !== content || existing.from_user_id !== first.from_user_id
        || existing.owner_user_id !== target.user_id || existing.from_conversation_id !== fromConversationId
        || existing.origin !== undefined || existing.image_storage_id !== undefined || existing.image_storage_ids !== undefined)) {
        for (const row of selected) {
          await ctx.db.patch(row._id, { state: "rejected", reason: "Batch delivery identifier conflicts with another message" });
        }
        await scheduleNext(ctx, args.conversation_id);
        return;
      }
      const pendingId = await enqueuePendingMessage(ctx, target, first.from_user_id, {
        content,
        client_id: id,
        ...(fromConversationId ? { from_conversation_id: fromConversationId } : {}),
      });
      for (const row of selected) {
        await ctx.db.patch(row._id, { state: "enqueued", pending_message_id: pendingId });
      }
    }
    await scheduleNext(ctx, args.conversation_id);
  },
});

export const recoverDueUpdates: RegisteredMutation<"internal", RecoveryArgs, Promise<void>> = internalMutation({
  args: { cursor: v.optional(v.string()), cutoff: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const cutoff = args.cutoff ?? Date.now();
    const page = await ctx.db.query("session_updates")
      .withIndex("by_state_deadline", (q) => q.eq("state", "queued").lte("hard_deadline", cutoff))
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: RECOVERY_PAGE_SIZE });
    for (const conversationId of new Set(page.page.map((row) => row.conversation_id))) {
      await ctx.scheduler.runAfter(0, internal.sessionUpdates.flushConversation, { conversation_id: conversationId });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.sessionUpdates.recoverDueUpdates, { cursor: page.continueCursor, cutoff });
    }
  },
});
