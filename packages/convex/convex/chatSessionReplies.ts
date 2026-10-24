// A session's "thinking" row in team chat.
//
// When a chat line is handed to a session (a reply on a thread it started, an
// @mention of it or of its role, a line in a room it is a member of), the
// person who sent it should see at once that the session has it. So every
// such delivery opens one row, written as that session, exactly where its
// answer will land: in the thread it was asked in, or at channel level for a
// channel-level line in a room. The client renders any row with
// `agent_status: "thinking"` as "<name> is thinking", the same row the
// anchor's placeholder uses.
//
// The row closes three ways, whichever comes first:
//  1. The session posts in that same place (sendMessage calls
//     closeSessionReplyOnAnswer): its answer is the reply, the row goes.
//  2. The session's turn ends after it was handed the line (managedSessions
//     calls closeSessionRepliesAfterTurn): it read the line and chose not to
//     answer there. A turn that ends while the line is still queued behind it
//     leaves the row alone, because the line has not been read yet.
//  3. A periodic check finds the session no longer running (dead daemon, a
//     delivery that failed). While the agent is active the row stays, up to
//     SESSION_REPLY_MAX_MS, so a long turn keeps showing that it is working.
//
// A closed row is a tombstone (`deleted_at`, `agent_status: "passed"`), never a
// delete: chat reaches clients as a delta overlay, which cannot carry a delete,
// and a client still holding the live row would show "thinking" forever. The
// client drops these tombstones the way it drops a canceled voice burst.

import { internalMutation } from "./functions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { ACTIVE_AGENT_STATUSES } from "@codecast/shared/contracts";
import { resolveActor } from "./lib/actor";
import { nextChatStamp, patchChat } from "./lib/chatRows";
import { chatWaitClientId, parseChatWaitClientId } from "./lib/chatWakeIds";
import { oneLine } from "./chatText";

/** How often an open row checks that its session is still running. */
export const SESSION_REPLY_CHECK_MS = 30 * 60_000;
/** The longest a row may say "thinking", however long the agent stays busy. */
export const SESSION_REPLY_MAX_MS = 6 * 60 * 60_000;

// A wake the session has not consumed yet: its turn ending says nothing about it.
const UNREAD_WAKE = new Set(["pending", "injected", "held"]);

async function openRows(ctx: MutationCtx, sessionId: string): Promise<Doc<"chat_messages">[]> {
  return await ctx.db
    .query("chat_messages")
    .withIndex("by_origin_session_status", (q: any) =>
      q.eq("origin_session_id", sessionId).eq("agent_status", "thinking"))
    .take(50);
}

const samePlace = (row: Doc<"chat_messages">, channelId: Id<"chat_channels">, threadRootId: Id<"chat_messages"> | undefined) =>
  String(row.channel_id) === String(channelId) && String(row.thread_root_id ?? "") === String(threadRootId ?? "");

async function closeRow(ctx: MutationCtx, row: Doc<"chat_messages">): Promise<void> {
  await patchChat(ctx, row._id, { agent_status: "passed", deleted_at: Date.now(), agent_deadline_at: undefined });
}

/** Open (or refresh) the session's thinking row for a wake just queued into
 *  it. `wakeId` is the pending_messages row the delivery wrote; null (the
 *  delivery did not happen) opens nothing. */
export async function openSessionReply(
  ctx: MutationCtx,
  opts: {
    channel: Doc<"chat_channels">;
    threadRootId?: Id<"chat_messages">;
    wakeId: Id<"pending_messages"> | null;
  },
): Promise<Id<"chat_messages"> | null> {
  if (!opts.wakeId) return null;
  const wake = await ctx.db.get(opts.wakeId);
  // A held note is read on the session's next turn, not now: nothing is thinking.
  if (!wake?.client_id || wake.status === "held" || !UNREAD_WAKE.has(wake.status)) return null;
  const conversation = await ctx.db.get(wake.conversation_id);
  if (!conversation) return null;
  const sessionId = String(conversation._id);
  const clientId = chatWaitClientId(wake.client_id);
  const now = Date.now();

  // One row per session per place: a second line into the same thread while
  // the first is unanswered moves the row's wait onto the newer line.
  const existing = (await openRows(ctx, sessionId)).find((row) => samePlace(row, opts.channel._id, opts.threadRootId));
  if (existing) {
    await patchChat(ctx, existing._id, { client_id: clientId, agent_deadline_at: now + SESSION_REPLY_CHECK_MS });
    return existing._id;
  }

  // Written as the session would write its answer: a role's standing session
  // as the role's bot, any other session as its person with the session's
  // identity on the row. A private session's title stays off the row.
  const actor = await resolveActor(ctx, conversation.user_id, conversation);
  const asRole = actor.kind === "role" && !!actor.anchor;
  const id = await ctx.db.insert("chat_messages", {
    team_id: opts.channel.team_id,
    channel_id: opts.channel._id,
    thread_root_id: opts.threadRootId,
    user_id: actor.user_id,
    author_kind: asRole ? "agent" : "user",
    agent_status: "thinking",
    agent_deadline_at: now + SESSION_REPLY_CHECK_MS,
    content: "",
    client_id: clientId,
    origin: "agent",
    origin_session_id: sessionId,
    origin_session_title: conversation.title && !conversation.is_private ? oneLine(conversation.title, 80) : undefined,
    origin_agent_type: conversation.agent_type,
    created_at: await nextChatStamp(ctx, opts.channel._id),
    updated_at: now,
  });
  await ctx.scheduler.runAfter(SESSION_REPLY_CHECK_MS, internal.chatSessionReplies.checkSessionReply, { message_id: id });
  return id;
}

/** The session just posted `answer`: its thinking row in that place is done. */
export async function closeSessionReplyOnAnswer(ctx: MutationCtx, answer: Doc<"chat_messages">): Promise<void> {
  if (!answer.origin_session_id || answer.agent_status === "thinking") return;
  for (const row of await openRows(ctx, answer.origin_session_id)) {
    if (samePlace(row, answer.channel_id, answer.thread_root_id)) await closeRow(ctx, row);
  }
}

// Whether the line a row waits on is still queued for the session. A merged
// wake lives on in the row it was merged into.
async function wakeUnread(ctx: MutationCtx, conversationId: Id<"conversations">, row: Doc<"chat_messages">): Promise<boolean> {
  const key = parseChatWaitClientId(row.client_id);
  if (!key) return false;
  let wake: Doc<"pending_messages"> | null = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_client_id", (q: any) => q.eq("conversation_id", conversationId).eq("client_id", key))
    .first();
  for (let hop = 0; wake?.merged_into && hop < 5; hop++) wake = await ctx.db.get(wake.merged_into);
  return !!wake && UNREAD_WAKE.has(wake.status);
}

/** A turn of the session just ended. Every row whose line it had already been
 *  handed closes: the session read it and did not answer there. */
export async function closeSessionRepliesAfterTurn(ctx: MutationCtx, conversationId: Id<"conversations">): Promise<void> {
  for (const row of await openRows(ctx, String(conversationId))) {
    if (!(await wakeUnread(ctx, conversationId, row))) await closeRow(ctx, row);
  }
}

async function agentActive(ctx: MutationCtx, conversationId: Id<"conversations">): Promise<boolean> {
  const session = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .first();
  return ACTIVE_AGENT_STATUSES.has(session?.agent_status ?? "");
}

export const checkSessionReply = internalMutation({
  args: { message_id: v.id("chat_messages") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.message_id);
    if (!row || row.deleted_at || row.agent_status !== "thinking" || !row.origin_session_id) return;
    const now = Date.now();
    // A newer line moved the deadline: check again then.
    if ((row.agent_deadline_at ?? 0) > now) {
      await ctx.scheduler.runAfter(row.agent_deadline_at! - now, internal.chatSessionReplies.checkSessionReply, args);
      return;
    }
    const conversationId = ctx.db.normalizeId("conversations", row.origin_session_id);
    if (conversationId && now - row.created_at < SESSION_REPLY_MAX_MS && (await agentActive(ctx, conversationId))) {
      await patchChat(ctx, row._id, { agent_deadline_at: now + SESSION_REPLY_CHECK_MS });
      await ctx.scheduler.runAfter(SESSION_REPLY_CHECK_MS, internal.chatSessionReplies.checkSessionReply, args);
      return;
    }
    await closeRow(ctx, row);
  },
});
