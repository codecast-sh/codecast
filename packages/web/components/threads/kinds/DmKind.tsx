import { useCallback, useMemo } from "react";
import { Users } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import type { ChatAttachment, ChatRailChannel } from "../../../store/chatSlice";
import { useChannelMessages, useChannelMessagesSync, useReadWhileSeen } from "../../../hooks/useChatSync";
import { channelDisplayName, dmCounterpart, memberName } from "../../../lib/chatViews";
import type { ThreadCardModel } from "../../../lib/threadCards";
import { CommentAvatar } from "../../comments/CommentAvatar";
import { ChatComposer } from "../../chat/ChatComposer";
import { ChatTimelineRows, ThreadUnavailableNote } from "./ChatThreadKind";
import { useThreadsPage } from "../threadsContext";
import { EarlierButton } from "../readerFold";
import { useReaderFold } from "../../../hooks/useReaderFold";

// The DM kind: a direct message room from the chat rail (a multi-person DM is
// a DM too). The row is the rail row's story — who, and the last line; open,
// the newest messages of the room and its composer, the channel page's read
// law applied: the room is marked read while the reader is present with the
// row open, and re-marked as new ones land.

/** How many of the room's newest messages a row holds; the fold shows what is new. */
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
  const fold = useReaderFold(messages, (m) => m.createdAt, frozenReadAt);

  // The channel page's own rule: present with the row open = read.
  useReadWhileSeen(channelId, seen, feed, `${newestId}|${channel.unreadCount}`);

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
        <>
          <EarlierButton count={fold.hidden} noun="message" onClick={fold.showAll} />
          <ChatTimelineRows messages={fold.visible} channelId={channelId} frozenReadAt={frozenReadAt} />
        </>
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
