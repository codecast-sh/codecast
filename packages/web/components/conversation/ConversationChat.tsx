import { memo, useCallback, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, MessageSquare } from "lucide-react";
import { dmKeyFor } from "@codecast/shared/chat";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { holdConversationChatPeople } from "../../hooks/useConversationChatPeople";
import { findDmChannelId, type ChatAttachment } from "../../store/chatSlice";
import { useChannelMessages, useChannelMessagesSync, useChatMembers, useChatRail, useReadWhileSeen } from "../../hooks/useChatSync";
import { useTypingMembers } from "../../hooks/useChatTyping";
import { useOpenChatPath } from "../../hooks/useOpenDm";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { memberName, type ChatMember } from "../../lib/chatViews";
import { ViewerFaces } from "../presence/ViewerFaces";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { ChatMessageList } from "../chat/ChatMessageList";
import { ChatComposer } from "../chat/ChatComposer";
import "../chat/chat.css";
import "./conversationChat.css";

// The people on a conversation, talking beside it. When teammates have the
// same session open, the composer's people row carries a chip for the team
// chat room of exactly that group: your DM when it is one other person, the
// group DM when it is more. It is the same room the chat page shows, not a
// copy. Collapsed, the chip shows their faces, what is unread and when they
// are typing; a message from them opens it (without taking the keyboard from
// the session's composer); open, it is the room's own list and composer.

function firstNames(people: ChatMember[]): string {
  const first = (m: ChatMember) => memberName(m).split(/\s+/)[0];
  if (people.length === 1) return memberName(people[0]);
  if (people.length === 2) return `${first(people[0])} and ${first(people[1])}`;
  return `${first(people[0])}, ${first(people[1])} and ${people.length - 2} more`;
}

export const ConversationChat = memo(function ConversationChat({
  conversationId,
  people,
}: {
  conversationId: string;
  people: ChatMember[];
}) {
  const ids = people.map((p) => String(p._id));
  const idsKey = ids.join(",");
  const st = useTrackedStore([activeTeamIdOf, (s) => s.currentUser?._id]);
  const teamId = activeTeamIdOf(st);
  const me = st.currentUser?._id ? String(st.currentUser._id) : "";
  const dmKey = teamId && me ? dmKeyFor(teamId, [me, ...ids]) : null;
  const found = useInboxStore((s) => (dmKey ? findDmChannelId(s.chatChannels, dmKey) : null));
  const room = useChatRail().find((c) => c.id === found);
  const unread = room?.unreadCount ?? 0;
  const typists = useTypingMembers(found ?? undefined);

  const [open, setOpen] = useState(false);
  // Opened by an arriving message rather than a click: the session's
  // composer keeps the keyboard.
  const quietRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [channelId, setChannelId] = useState<string | null>(null);

  const show = useCallback((next: boolean, quiet = false) => {
    quietRef.current = quiet;
    setOpen(next);
  }, []);

  // Open holds the group; closing lets it follow who is here again.
  useWatchEffect(() => {
    holdConversationChatPeople(conversationId, open ? ids : null);
    return () => holdConversationChatPeople(conversationId, null);
  }, [conversationId, open, idsKey]);

  // The room for this group: the one the chat already holds, or, on first
  // open, the one openDmChannel makes (a stub the server row supersedes).
  useWatchEffect(() => {
    if (found) { setChannelId(found); return; }
    if (open && teamId && ids.length) setChannelId(useInboxStore.getState().openDmChannel(ids, teamId));
    else setChannelId(null);
  }, [found, open, teamId, idsKey]);

  // A new line from them opens the dock. The first value seen is history.
  const inboundAt = room?.lastInboundAt ?? 0;
  const seenInbound = useRef<number | null>(null);
  useWatchEffect(() => {
    if (seenInbound.current === null) { seenInbound.current = inboundAt; return; }
    if (inboundAt > seenInbound.current) {
      seenInbound.current = inboundAt;
      if (!open && unread > 0) show(true, true);
    }
  }, [inboundAt]);

  if (!dmKey || people.length === 0) return null;
  const label = firstNames(people);
  return (
    <Popover open={open} onOpenChange={(next) => show(next)}>
      <PopoverAnchor asChild>
        <button
          type="button"
          data-cc-chat-chip={unread > 0 ? "unread" : typists.length ? "typing" : "idle"}
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => show(!open)}
          title={`Chat with ${label}`}
          className="cc-chat-chip"
        >
          <ViewerFaces members={people} size={16} />
          {typists.length > 0 && !open ? (
            <span className="ch-typing-dots cc-chat-dots" aria-label={`${label} typing`}><span /><span /><span /></span>
          ) : (
            <MessageSquare className="cc-chat-icon" />
          )}
          {unread > 0 && <span className="cc-chat-badge">{unread > 99 ? "99+" : unread}</span>}
        </button>
      </PopoverAnchor>
      <PopoverContent
        ref={panelRef}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="cc-chat-panel"
        aria-label={`Chat with ${label}`}
        onOpenAutoFocus={(e) => { if (quietRef.current) e.preventDefault(); }}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // A chat stays open while you work in the session; only its own
        // collapse, or Escape from inside it, closes it.
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => { if (!panelRef.current?.contains(document.activeElement)) e.preventDefault(); }}
      >
        {channelId && (
          <Room
            channelId={channelId}
            teamId={teamId}
            people={people}
            label={label}
            autoFocus={!quietRef.current}
            onCollapse={() => show(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
});

const CLOCK_MS = 30_000;

function Room({
  channelId,
  teamId,
  people,
  label,
  autoFocus,
  onCollapse,
}: {
  channelId: string;
  teamId?: string;
  people: ChatMember[];
  label: string;
  autoFocus: boolean;
  onCollapse: () => void;
}) {
  const feed = useChannelMessagesSync(channelId);
  const messages = useChannelMessages(channelId, feed.floor);
  const { viewerId, handles } = useChatMembers();
  const now = useCoarseNow(CLOCK_MS);
  const openChat = useOpenChatPath();
  const newestId = messages.at(-1)?.id;
  // Read when the newest line is on screen, the way the chat page reads.
  const [atBottom, setAtBottom] = useState(false);
  useReadWhileSeen(channelId, atBottom, feed, newestId);
  const send = useCallback((content: string, attachments?: ChatAttachment[]) => {
    useInboxStore.getState().sendChatMessage(channelId, content, { attachments });
  }, [channelId]);

  return (
    <div className="cc-chat-room">
      <div className="cc-chat-head">
        <ViewerFaces members={people} size={20} />
        <span className="cc-chat-title">{label}</span>
        <button type="button" className="cc-chat-tool" title="Open in Chat" onClick={() => openChat(`/chat/${channelId}`)}>
          <ArrowUpRight className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="cc-chat-tool" title="Collapse" onClick={onCollapse}>
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </div>
      {messages.length === 0 && !feed.loading ? (
        <div className="cc-chat-empty">
          <ViewerFaces members={people} size={28} />
        </div>
      ) : (
        <ChatMessageList
          messages={messages}
          viewerId={viewerId}
          channelId={channelId}
          permalinkChannelId={channelId}
          knownHandles={handles.known}
          selfHandles={handles.self}
          handleNames={handles.names}
          now={now}
          hasMoreAbove={feed.hasMoreAbove}
          isLoadingOlder={feed.isLoadingOlder}
          onLoadOlder={feed.loadOlder}
          onReachedBottom={() => setAtBottom(true)}
          canReportRead
          inThread
          onReact={(id, emoji) => useInboxStore.getState().toggleChatReaction(id, emoji)}
          onEdit={(id, content) => useInboxStore.getState().editChatMessage(id, content)}
          onDelete={(id) => useInboxStore.getState().deleteChatMessage(id)}
          onRetrySend={(id) => useInboxStore.getState().retryChatSend(id)}
        />
      )}
      <ChatComposer
        channelId={channelId}
        teamId={teamId}
        placeholder={`Message ${label}`}
        onSend={send}
        autoFocus={autoFocus}
        compact
      />
    </div>
  );
}
