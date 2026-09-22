import { useCallback, useMemo } from "react";
import { Hash, Lock, Users } from "lucide-react";
import { authorGroupKey, buildChatTimeline } from "@codecast/shared/chat";
import { useInboxStore, type ThreadInboxRow } from "../../../store/inboxStore";
import type { ChatAttachment } from "../../../store/chatSlice";
import { useThreadMessages, useThreadSync } from "../../../hooks/useChatSync";
import { channelDisplayName } from "../../../lib/chatViews";
import { holdChatFocus } from "../../../lib/chatFocus";
import { replyPreview, type CardPreview, type ThreadCardModel } from "../../../lib/threadCards";
import { ChatMessage, ChatNewDivider } from "../../chat/ChatMessage";
import { ChatComposer } from "../../chat/ChatComposer";
import type { ChatMessageView } from "../../chat/chatTypes";
import { useTailPin } from "../cardWindow";
import { useThreadsPage } from "../threadsContext";

import { useWatchEffect } from "../../../hooks/useWatchEffect";
// The chat kind: a channel thread the viewer is in. The row names the room
// and previews the newest reply; open, the root message and the whole thread
// IN PLACE, composer included — the thread panel's content inlined, so a
// person walks their threads top to bottom without leaving the page. The DM
// kind reuses the timeline rows below.

function rowOf(card: ThreadCardModel): ThreadInboxRow {
  return card.source as ThreadInboxRow;
}

/** The room's glyph: DM, private room, or channel. */
export function RoomIcon({ channel }: { channel: { kind?: string; isPrivate?: boolean } | undefined }) {
  if (channel?.kind === "dm") return <Users className="w-3 h-3" />;
  if (channel?.isPrivate) return <Lock className="w-3 h-3" />;
  return <Hash className="w-3 h-3" />;
}

/** The kind tile's glyph: the room's own icon, so lock and hash still carry
 *  meaning. */
export function ChatGlyph({ card }: { card: ThreadCardModel }) {
  const { chatCards } = useThreadsPage();
  return <RoomIcon channel={chatCards.get(rowOf(card).root_key)?.channel} />;
}

/** The row's label: the room name. */
export function ChatLabel({ card }: { card: ThreadCardModel }) {
  const { chatCards, members } = useThreadsPage();
  const channel = chatCards.get(rowOf(card).root_key)?.channel;
  return <>{channel ? channelDisplayName(channel, members) : "channel"}</>;
}

export function useChatPreview(card: ThreadCardModel): CardPreview | null {
  const { nameOf } = useThreadsPage();
  return replyPreview(rowOf(card).last_reply, nameOf);
}

/** The open card for a room the server will not show this viewer (left it,
 *  never a member, dead link). The card came from a rail or inbox row that
 *  predates the refusal; chat.sendMessage would refuse a post here, so the
 *  card offers none. Shared by the chat and DM kinds. */
export function ThreadUnavailableNote() {
  return (
    <div className="th-card-open">
      <div className="th-card-note">This conversation isn&apos;t available anymore.</div>
    </div>
  );
}

/** A chat timeline inside a card: the unread rule, grouped rows, the usual
 *  message actions. Shared by the chat and DM kinds. */
export function ChatTimelineRows({
  messages,
  channelId,
  frozenReadAt,
  inThread,
}: {
  messages: ChatMessageView[];
  channelId: string;
  frozenReadAt: number;
  inThread?: boolean;
}) {
  const { now, viewerId, handles } = useThreadsPage();
  const rows = useMemo(
    () =>
      buildChatTimeline(
        messages.map((m: ChatMessageView) => ({
          id: m.id,
          authorId: m.author.id,
          groupKey: authorGroupKey(m.author),
          createdAt: m.createdAt,
          pendingAgent: m.agentStatus === "thinking" || m.agentStatus === "streaming",
          deleted: !!m.deletedAt,
          standalone: !!m.call,
          view: m,
        })),
        { now, lastReadAt: frozenReadAt, viewerId, withoutDays: true },
      ),
    [messages, now, frozenReadAt, viewerId],
  );
  const react = useCallback((id: string, emoji: string) => {
    useInboxStore.getState().toggleChatReaction(id, emoji);
  }, []);
  const edit = useCallback((id: string, content: string) => {
    useInboxStore.getState().editChatMessage(id, content);
  }, []);
  const del = useCallback((id: string) => {
    useInboxStore.getState().deleteChatMessage(id);
  }, []);
  const retry = useCallback((id: string) => {
    useInboxStore.getState().retryChatSend(id);
  }, []);
  // Pinned to the tail so the newest message is what the capped region shows.
  const pinRef = useTailPin(messages.length ? `${messages[messages.length - 1].id}|${messages.length}` : "");
  return (
    <div ref={pinRef} className="th-card-replies">
      {rows.map((row) =>
        row.kind === "new" ? (
          <ChatNewDivider key={row.key} />
        ) : row.kind === "message" ? (
          <ChatMessage
            key={row.key}
            message={(row.message as any).view}
            channelId={channelId}
            knownHandles={handles.known}
            selfHandles={handles.self}
            handleNames={handles.names}
            now={now}
            mine={(row.message as any).view.author.id === viewerId}
            grouped={row.grouped}
            inThread={inThread}
            onReact={react}
            onEdit={edit}
            onDelete={del}
            onRetrySend={retry}
          />
        ) : null,
      )}
    </div>
  );
}

/** The open row's first line: the root message the thread hangs on (or a
 *  ghost while the cache is cold). */
export function ChatMeta({ card }: { card: ThreadCardModel }) {
  const entry = rowOf(card);
  const { chatCards, now, viewerId, handles } = useThreadsPage();
  const root = chatCards.get(entry.root_key)?.root ?? null;
  return root ? (
    <div className="th-card-root">
      <ChatMessage
        message={root}
        channelId={String(entry.channel_id ?? "")}
        knownHandles={handles.known}
        selfHandles={handles.self}
        handleNames={handles.names}
        now={now}
        mine={root.author.id === viewerId}
        inThread
      />
    </div>
  ) : (
    <div className="th-card-root th-card-ghost" aria-hidden="true">
      <div className="ch-skel-line ch-skel-head" />
      <div className="ch-skel-line" style={{ width: "62%" }} />
    </div>
  );
}

/** The open half: the live thread and its composer. Its own component so
 *  the thread subscription and the read-mark effect mount only for the one
 *  open row. */
export function ChatExpanded({
  card,
  seen,
  frozenReadAt,
  focusComposer,
}: {
  card: ThreadCardModel;
  present: boolean;
  seen: boolean;
  frozenReadAt: number;
  focusComposer: boolean;
}) {
  const entry = rowOf(card);
  const rootId = entry.root_key;
  const channelId = String(entry.channel_id ?? "");
  const { chatCards, members } = useThreadsPage();
  const channel = chatCards.get(rootId)?.channel;
  const roomName = channel ? channelDisplayName(channel, members) : "channel";
  const sync = useThreadSync(rootId);
  const thread = useThreadMessages(rootId);

  // The read law: the row is open and the reader is here (`seen`), and the
  // thread query has answered — on a cold cache the body renders empty with
  // the newest message never shown. Re-marks when new replies land while the
  // reader is still looking (last_activity_at moves).
  useWatchEffect(() => {
    if (!seen || sync.loading) return;
    if (entry.last_read_at >= entry.last_activity_at && entry.unread === 0) return;
    useInboxStore.getState().markThreadRead("chat", rootId);
  }, [seen, sync.loading, rootId, entry.last_activity_at, entry.last_read_at, entry.unread]);

  // The thread on the reader's screen is being read: its own arrivals must not
  // toast at them.
  useWatchEffect(() => {
    if (!seen) return;
    return holdChatFocus({ channelId, threadRootId: rootId });
  }, [seen, channelId, rootId]);

  const send = useCallback(
    (content: string, attachments?: ChatAttachment[], opts?: { broadcast?: boolean }) => {
      useInboxStore.getState().sendChatMessage(channelId, content, {
        threadRootId: rootId,
        attachments,
        broadcast: opts?.broadcast,
      });
    },
    [channelId, rootId],
  );

  if (sync.unavailable) return <ThreadUnavailableNote />;

  return (
    <div className="th-card-open">
      <ChatTimelineRows messages={thread.replies} channelId={channelId} frozenReadAt={frozenReadAt} inThread />
      <ChatComposer
        channelId={channelId}
        threadRootId={rootId}
        teamId={channel?.teamId}
        // A DM's channel IS the conversation — "also send to #room" only makes
        // sense where the thread panel and the room are different audiences.
        channelName={channel?.kind === "dm" ? undefined : roomName}
        placeholder={channel?.kind === "dm" ? `Reply to ${roomName}…` : `Reply in #${roomName}…`}
        onSend={send}
        compact
        autoFocus={focusComposer}
      />
    </div>
  );
}
