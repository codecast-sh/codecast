import { useCallback, useMemo } from "react";
import { Hash, Lock, Users } from "lucide-react";
import { buildChatTimeline } from "@codecast/shared/chat";
import { useInboxStore, type ThreadInboxRow } from "../../../store/inboxStore";
import type { ChatAttachment } from "../../../store/chatSlice";
import { useThreadMessages, useThreadSync } from "../../../hooks/useChatSync";
import { channelDisplayName } from "../../../lib/chatViews";
import { holdChatFocus } from "../../../lib/chatFocus";
import { summaryCount, type ThreadCardModel } from "../../../lib/threadCards";
import { CommentAvatar } from "../../comments/CommentAvatar";
import { ChatMessage, ChatNewDivider } from "../../chat/ChatMessage";
import { ChatComposer } from "../../chat/ChatComposer";
import type { ChatMessageView } from "../../chat/chatTypes";
import { useTailPin } from "../cardWindow";
import { useThreadsPage } from "../threadsContext";

import { useWatchEffect } from "../../../hooks/useWatchEffect";
// The chat kind: a channel thread the viewer is in. The collapsed card shows
// the room, the root message and a one-line rollup of the replies; expanded,
// the whole thread IN PLACE, composer included — the thread panel's content
// inlined, so a person walks their threads top to bottom without leaving the
// page. The DM kind reuses the timeline rows below.

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

/** The card head's object label: the room name. */
export function ChatLabel({ card }: { card: ThreadCardModel }) {
  const { chatCards, members } = useThreadsPage();
  const channel = chatCards.get(rowOf(card).root_key)?.channel;
  return <>{channel ? channelDisplayName(channel, members) : "channel"}</>;
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
  // Pinned to the tail so the newest message is what the capped region shows —
  // the read law's sentinel below this region assumes exactly that.
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

/** Collapsed body: the root message (or a ghost while the cache is cold) and,
 *  when not expanded, the reply rollup — faces, count, last reply preview. */
export function ChatRoot({ card, expanded }: { card: ThreadCardModel; expanded: boolean }) {
  const entry = rowOf(card);
  const { chatCards, now, viewerId, handles, nameOf, toggle } = useThreadsPage();
  const root = chatCards.get(entry.root_key)?.root ?? null;
  const replyCount = root?.replyCount ?? 0;
  const lastReply = entry.last_reply;
  return (
    <>
      {root ? (
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
      )}
      {!expanded && (
        <button type="button" className="th-card-summary" onClick={() => toggle(card)}>
          {(root?.replyFaces ?? []).slice(0, 4).map((f) => (
            <span key={f.id} className="th-card-face">
              <CommentAvatar name={f.name} image={f.avatarUrl} size={16} letters={1} />
            </span>
          ))}
          <span className="th-card-count">{summaryCount(replyCount, "reply", "replies")}</span>
          {lastReply && (
            <span className="th-card-preview">
              <span className="th-card-preview-name">{lastReply.author_name ?? nameOf(String(lastReply.user_id ?? ""))}:</span>{" "}
              {lastReply.preview}
            </span>
          )}
        </button>
      )}
    </>
  );
}

/** The expanded half: the live thread and its composer. Its own component so
 *  the thread subscription and the read-mark effect mount only for the one
 *  open card. */
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

  // The read law: presence + the card's newest content actually in the
  // viewport (`seen`, witnessed by the shell's tail sentinel). Never while
  // the thread query is still answering (DM's own gate): on a cold cache the
  // body renders empty and short, so the sentinel is trivially in view with
  // the newest message never rendered. Re-marks when new replies land while
  // the reader is still looking (last_activity_at moves); a card expanded
  // below the fold stays unread.
  useWatchEffect(() => {
    if (!seen || sync.loading) return;
    if (entry.last_read_at >= entry.last_activity_at && entry.unread === 0) return;
    useInboxStore.getState().markThreadRead("chat", rootId);
  }, [seen, sync.loading, rootId, entry.last_activity_at, entry.last_read_at, entry.unread]);

  // The thread on the reader's screen is being read: its own arrivals must not
  // toast at them. A hold, not the page's single slot — several cards can be
  // on screen at once, and releasing this one must not erase another's.
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
