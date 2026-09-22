import { useCallback, useMemo } from "react";
import { Users } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { selectChannelReadMarker, type ChatAttachment, type ChatRailChannel } from "../../../store/chatSlice";
import { useChannelMessages, useChannelMessagesSync } from "../../../hooks/useChatSync";
import { channelDisplayName, dmCounterpart, memberName } from "../../../lib/chatViews";
import { holdChatFocus } from "../../../lib/chatFocus";
import type { CardPreview, ThreadCardModel } from "../../../lib/threadCards";
import { CommentAvatar } from "../../comments/CommentAvatar";
import { ChatComposer } from "../../chat/ChatComposer";
import { ChatTimelineRows, ThreadUnavailableNote } from "./ChatThreadKind";
import { useThreadsPage } from "../threadsContext";

import { useWatchEffect } from "../../../hooks/useWatchEffect";
// The DM kind: a direct message room from the chat rail (a multi-person DM is
// a DM too). The row is the rail row's story — who, and the last line; open,
// the newest messages of the room and its composer, the channel page's read
// law applied: the room is marked read while the reader is present with the
// row open, and re-marked as new ones land.

/** How many of the room's newest messages an open row shows. */
const DM_WINDOW = 20;

function channelOf(card: ThreadCardModel): ChatRailChannel {
  return card.source as ChatRailChannel;
}

/** The kind tile's glyph: the counterpart's face, or the group mark. */
export function DmGlyph({ card }: { card: ThreadCardModel }) {
  const { members } = useThreadsPage();
  const counterpart = dmCounterpart(channelOf(card), members);
  return counterpart ? (
    <CommentAvatar name={memberName(counterpart)} image={(counterpart as any).image ?? (counterpart as any).github_avatar_url} size={14} letters={1} />
  ) : (
    <Users className="w-3 h-3" />
  );
}

export function DmLabel({ card }: { card: ThreadCardModel }) {
  const { members } = useThreadsPage();
  return <>{channelDisplayName(channelOf(card), members)}</>;
}

/** The rail carries the room's last line, already attributed. */
export function useDmPreview(card: ThreadCardModel): CardPreview | null {
  const channel = channelOf(card);
  if (channel.knownEmpty) return { text: "No messages yet" };
  return channel.lastMessagePreview ? { text: channel.lastMessagePreview } : null;
}

export function DmExpanded({
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
  const channel = channelOf(card);
  const channelId = channel.id;
  const { members } = useThreadsPage();
  const feed = useChannelMessagesSync(channelId);
  const all = useChannelMessages(channelId);
  const messages = useMemo(() => (all.length > DM_WINDOW ? all.slice(-DM_WINDOW) : all), [all]);
  const newestId = messages.length ? messages[messages.length - 1].id : undefined;

  // The channel page's own rule: present with the room open = read. The
  // marker is the newest message in the ROOM, replies included, so a badge a
  // thread reply raised clears too. Re-marks as messages land (newestId
  // moves). Never for a room the server refuses: the mark would only come
  // back as "Channel not found", and the note below is what this row shows.
  useWatchEffect(() => {
    if (!seen || feed.loading || feed.unavailable) return;
    const state = useInboxStore.getState();
    const marker = selectChannelReadMarker(state as any, channelId);
    state.markChannelRead(channelId, marker?._id);
  }, [seen, channelId, newestId, feed.loading, feed.unavailable, channel.unreadCount]);

  useWatchEffect(() => {
    if (!seen) return;
    return holdChatFocus({ channelId });
  }, [seen, channelId]);

  const send = useCallback(
    (content: string, attachments?: ChatAttachment[]) => {
      useInboxStore.getState().sendChatMessage(channelId, content, { attachments });
    },
    [channelId],
  );

  if (feed.unavailable) return <ThreadUnavailableNote />;

  return (
    <div className="th-card-open">
      {messages.length === 0 && !feed.loading ? (
        <div className="th-card-note">Nothing here yet. Say hello.</div>
      ) : (
        <ChatTimelineRows messages={messages} channelId={channelId} frozenReadAt={frozenReadAt} />
      )}
      <ChatComposer
        channelId={channelId}
        teamId={channel.teamId}
        placeholder={`Message ${channelDisplayName(channel, members)}`}
        onSend={send}
        compact
        autoFocus={focusComposer}
      />
    </div>
  );
}
