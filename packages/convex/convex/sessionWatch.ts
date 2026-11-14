// Subscribing to a session, and muting one. The setting is one row per
// (person, conversation) in entity_subscriptions, its `notify` field:
//   "all"          every assistant reply pings, coalesced per WATCH_BATCH_MS,
//                  plus every open question or permission prompt
//   "needs_input"  every time the session lands waiting on a person
//   "muted"        nothing about this session pings this person
// Broader mutes (project, folder, teammate) live on the users row; how they
// combine is lib/sessionWatch.ts.
import { internalMutation, mutation, query } from "./functions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthenticatedUserId } from "./pendingMessages";
import { canAccessConversation } from "./lib/access";
import { resolveConversationRef } from "./conversations";
import { deliverSessionNotification } from "./lib/sessionNotify";
import { enqueuePush } from "./pushRouter";
import type { SessionNotifySetting } from "./lib/sessionWatch";

export const WATCH_BATCH_MS = 20_000;
const LIST_CAP = 1000;

const LEVEL = v.union(v.literal("default"), v.literal("all"), v.literal("needs_input"), v.literal("muted"));

export type SessionNotifyRow = { _id: string; conversation_id: string; level: SessionNotifySetting; updated_at: number };

/** The store key for a session's setting: the same on the optimistic row and the synced one. */
export function sessionNotifyKey(conversationId: string): string {
  return `sn:${conversationId}`;
}

function project(row: Doc<"entity_subscriptions">): SessionNotifyRow {
  return {
    _id: sessionNotifyKey(row.entity_id),
    conversation_id: row.entity_id,
    level: row.notify as SessionNotifySetting,
    updated_at: row.notify_at ?? row.created_at,
  };
}

export const listMine = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SessionNotifyRow[]> => {
    const userId = await getAuthenticatedUserId(ctx as any, args.api_token);
    if (!userId) return [];
    const rows = await ctx.db
      .query("entity_subscriptions")
      .withIndex("by_user", (q: any) => q.eq("user_id", userId).eq("entity_type", "conversation"))
      .order("desc")
      .take(LIST_CAP);
    return rows.filter((r) => !!r.notify).map(project);
  },
});

export async function setSessionNotifyFor(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationRef: string,
  level: "default" | SessionNotifySetting,
): Promise<{ conversation_id: string; level: "default" | SessionNotifySetting }> {
  const conversation = await resolveConversationRef(ctx, conversationRef, userId);
  if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) {
    throw new Error("Conversation not found");
  }
  const entityId = conversation._id.toString();
  const existing = await ctx.db
    .query("entity_subscriptions")
    .withIndex("by_user_entity", (q: any) =>
      q.eq("user_id", userId).eq("entity_type", "conversation").eq("entity_id", entityId),
    )
    .first();
  const result = { conversation_id: entityId, level };
  if (level === "default") {
    if (!existing?.notify) return result;
    // A row this setting created goes; one that predates it (a comment, a
    // mention) keeps its thread following and only loses the setting.
    if (existing.notify_created) await ctx.db.delete(existing._id);
    else await ctx.db.patch(existing._id, { notify: undefined, notify_at: undefined });
    return result;
  }
  const now = Date.now();
  if (existing) {
    const patch: Record<string, unknown> = { notify: level, notify_at: now };
    // Subscribing is attention: it follows the thread again.
    if (level !== "muted" && existing.muted) patch.muted = false;
    await ctx.db.patch(existing._id, patch);
    return result;
  }
  await ctx.db.insert("entity_subscriptions", {
    user_id: userId,
    entity_type: "conversation",
    entity_id: entityId,
    reason: "watching",
    via: "human",
    notify: level,
    notify_at: now,
    notify_created: true,
    // A mute filed here must not enroll the person in the comment fan-out.
    muted: level === "muted",
    created_at: now,
  });
  return result;
}

export const setLevel = mutation({
  args: { api_token: v.optional(v.string()), conversation_id: v.string(), level: LEVEL },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx as any, args.api_token);
    if (!userId) throw new Error("Unauthorized");
    return await setSessionNotifyFor(ctx, userId, args.conversation_id, args.level);
  },
});

async function watchersOf(ctx: { db: any }, conversationId: Id<"conversations">, levels: SessionNotifySetting[]) {
  const rows = await ctx.db
    .query("entity_subscriptions")
    .withIndex("by_entity", (q: any) => q.eq("entity_type", "conversation").eq("entity_id", conversationId.toString()))
    .collect();
  return rows.filter((r: any) => levels.includes(r.notify));
}

// The needs-input check calls this once it knows the session is waiting.
// Subscribers asked for every time, so none of the owner's quiet rules
// (pinned, spawned, schedule runs, machine turns, the digest) apply; a dead
// process is not a question, so "stopped"/"unresponsive" ring nobody.
// "all" subscribers already heard the reply itself from the activity batch, so
// they ring here only for a question or a permission prompt. Returns who was
// told, so the owner path below skips them.
export async function notifyNeedsInputWatchers(
  ctx: MutationCtx,
  conv: Doc<"conversations">,
  args: { kind: string; key: string; title: string; message: string },
): Promise<Set<string>> {
  const told = new Set<string>();
  if (args.kind === "stopped" || args.kind === "unresponsive") return told;
  const hard = args.kind === "awaiting_input" || args.kind === "permission_blocked";
  const watchers = await watchersOf(ctx, conv._id, hard ? ["needs_input", "all"] : ["needs_input"]);
  if (watchers.length === 0) return told;
  if (conv.watch_notified_key === args.key) {
    for (const w of watchers) told.add(w.user_id.toString());
    return told;
  }
  await ctx.db.patch(conv._id, { watch_notified_key: args.key });
  const type = args.kind === "permission_blocked" ? "permission_request" : "session_idle";
  const title = args.kind === "permission_blocked" ? `${args.title} · needs permission` : args.title;
  for (const w of watchers) {
    if (!(await canAccessConversation(ctx, w.user_id, conv))) continue;
    if (await deliverSessionNotification(ctx, w.user_id, conv._id, type, title, args.message, { watched: true })) {
      told.add(w.user_id.toString());
    }
  }
  return told;
}

// Called by the message writers when assistant text lands. Opens a batch when
// none is open and someone subscribed to every message; the flush covers
// everything that landed in the meantime.
export async function noteWatchedActivity(ctx: MutationCtx, conv: Doc<"conversations">): Promise<void> {
  const now = Date.now();
  const due = conv.watch_flush_due_at;
  if (due && due > now) return;
  const watchers = await watchersOf(ctx, conv._id, ["all"]);
  if (watchers.length === 0) return;
  await ctx.db.patch(conv._id, {
    watch_flush_due_at: now + WATCH_BATCH_MS,
    ...(conv.watch_flushed_at ? {} : { watch_flushed_at: now - 60_000 }),
  });
  await ctx.scheduler.runAfter(WATCH_BATCH_MS, internal.sessionWatch.flushWatchedActivity, { conversation_id: conv._id });
}

function preview(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export async function performWatchedActivityFlush(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
): Promise<{ notified: number; count: number }> {
  const conv = await ctx.db.get(conversationId);
  if (!conv) return { notified: 0, count: 0 };
  const since = conv.watch_flushed_at ?? Date.now() - 60_000;
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conversationId).gt("timestamp", since))
    .order("asc")
    .take(200);
  const replies = recent.filter((m: any) => m.role === "assistant" && m.content?.trim());
  const last = recent[recent.length - 1];
  await ctx.db.patch(conversationId, {
    watch_flush_due_at: undefined,
    watch_flushed_at: last?.timestamp ?? since,
  });
  if (replies.length === 0) return { notified: 0, count: 0 };

  const title = conv.title?.trim() || conv.project_path?.split("/").pop() || "Session";
  const body = preview(replies[replies.length - 1].content ?? "");
  const subtitle = replies.length > 1 ? `${replies.length} new messages` : undefined;
  const now = Date.now();
  let notified = 0;
  for (const w of await watchersOf(ctx, conversationId, ["all"])) {
    const user = await ctx.db.get(w.user_id);
    if (!user || !(await canAccessConversation(ctx, w.user_id, conv))) continue;
    // One row per session in the bell: the newest batch replaces the last.
    const prior = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_conversation", (q: any) =>
        q.eq("recipient_user_id", w.user_id).eq("conversation_id", conversationId),
      )
      .collect();
    for (const n of prior) if (n.type === "session_activity") await ctx.db.delete(n._id);
    const notifId = await ctx.db.insert("notifications", {
      recipient_user_id: w.user_id,
      type: "session_activity",
      conversation_id: conversationId,
      message: subtitle ? `${subtitle}: ${body}` : body,
      read: false,
      created_at: now,
    });
    notified++;
    await enqueuePush(ctx, {
      user,
      notification_id: notifId,
      type: "session_activity",
      title,
      subtitle,
      body,
      data: { conversationId, type: "session_activity" },
    });
  }
  return { notified, count: replies.length };
}

export const flushWatchedActivity = internalMutation({
  args: { conversation_id: v.id("conversations") },
  handler: (ctx, args) => performWatchedActivityFlush(ctx, args.conversation_id),
});
