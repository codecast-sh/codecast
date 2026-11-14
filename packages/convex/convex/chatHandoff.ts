// Hand to agent: a person starts a fresh session from a chat thread. Rides
// dispatch.createSession with linked_object { type: "chat_thread" }; this binds
// the thread root to the session, briefs it with the thread, and opens its
// thinking row there.

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { loadChannel } from "./chat";
import { collectChatExcerpt } from "./chatExcerpt";
import { closeSessionRepliesIn, openSessionReply } from "./chatSessionReplies";
import { oneLine } from "./chatText";
import { buildThreadHandoff } from "./chatWakePrompts";
import { patchChat } from "./lib/chatRows";
import { chatRelayClientId } from "./lib/chatWakeIds";
import { displayName } from "./lib/displayNames";
import { enqueuePendingMessage } from "./pendingMessages";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";

export const HAND_THREAD_LIMIT = 40;

export function mayHandTo(userId: Id<"users">, conversation: Pick<Doc<"conversations">, "user_id" | "author_user_id">): boolean {
  return String(conversation.user_id) === String(userId) || String(conversation.author_user_id ?? "") === String(userId);
}

export async function handableThread(ctx: MutationCtx, userId: Id<"users">, messageRef: string) {
  const messageId = ctx.db.normalizeId("chat_messages", messageRef);
  const message = messageId ? await ctx.db.get(messageId) : null;
  if (!message || message.deleted_at) throw new Error("That message is not available");
  const channel = await loadChannel(ctx, userId, message.channel_id);
  if (channel.archived_at) throw new Error("This channel is archived");
  if (channel.kind === "community") throw new Error("Threads in a community room cannot be handed to an agent");
  const root = message.thread_root_id ? await ctx.db.get(message.thread_root_id) : message;
  if (!root || root.deleted_at) throw new Error("That thread was deleted");
  return { message, channel, root };
}

export const handIsPrivate = (channel: Pick<Doc<"chat_channels">, "kind">) => channel.kind === "private" || channel.kind === "dm";

const holderOf = (root: Doc<"chat_messages">) => root.bound_session_id ?? (root.origin === "agent" ? root.origin_session_id : undefined);

export const HAND_HOLD_IDLE_MS = 24 * 60 * 60_000;

/** A session still holds a thread while it is alive and has worked on something in the last day. */
export function holdsThread(conv: Pick<Doc<"conversations">, "inbox_killed_at" | "status" | "updated_at">, now = Date.now()): boolean {
  return !conv.inbox_killed_at && conv.status === "active" && now - (conv.updated_at ?? 0) < HAND_HOLD_IDLE_MS;
}

export async function assertMayBind(ctx: MutationCtx, userId: Id<"users">, root: Doc<"chat_messages">, sessionId?: string) {
  const holder = holderOf(root);
  if (!holder || holder === sessionId) return;
  if (root.origin !== "agent" && String(root.user_id) === String(userId)) return;
  const conv = await findConversationByAnyRefWhere(ctx, holder, () => true);
  const alive = conv && (root.bound_session_id ? holdsThread(conv) : !conv.inbox_killed_at);
  if (!alive || mayHandTo(userId, conv)) return;
  throw new Error("This thread is already handed to someone else's session");
}

export async function handThreadToSession(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversation: Doc<"conversations">,
  messageRef: string,
): Promise<Id<"chat_messages">> {
  if (!mayHandTo(userId, conversation)) throw new Error("Unauthorized");
  const { message, channel, root } = await handableThread(ctx, userId, messageRef);

  const sessionId = String(conversation._id);
  await assertMayBind(ctx, userId, root, sessionId);
  if (root.bound_session_id !== sessionId) {
    const prior = holderOf(root);
    if (prior && prior !== sessionId) await closeSessionRepliesIn(ctx, prior, channel._id, root._id);
    await patchChat(ctx, root._id, { bound_session_id: sessionId });
  }

  const askerName = oneLine(displayName(await ctx.db.get(userId)), 60);
  const { entries, channelEntries } = await collectChatExcerpt(ctx, {
    channel,
    root,
    message,
    senderName: askerName,
    threadRootId: root._id,
    isSelf: (row) => row.origin_session_id === sessionId,
    threadLimit: HAND_THREAD_LIMIT,
  });
  const team = await ctx.db.get(channel.team_id);
  const wakeId = await enqueuePendingMessage(ctx, conversation, userId, {
    content: buildThreadHandoff({
      channelName: channel.name,
      channelKind: channel.kind,
      channelTopic: channel.topic,
      channelId: channel._id,
      teamName: oneLine((team as any)?.name ?? "team", 60),
      threadRootId: root._id,
      askerName,
      handed: { name: message.user_id === userId ? askerName : oneLine(displayName(await ctx.db.get(message.user_id)), 60), content: message.content },
      entries,
      channelEntries,
      nonce: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    }),
    client_id: chatRelayClientId(String(message._id)),
    human: true,
  });
  // A session started from a thread reads the room it was started from (chatAccess).
  await openSessionReply(ctx, { channel, threadRootId: root._id, wakeId, grant: "room" });
  return root._id;
}
