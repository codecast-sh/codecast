import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, ChevronDown, ChevronRight, ExternalLink, Hash, Lock, MessagesSquare, Users } from "lucide-react";
import { useInboxStore, type ChatThreadInboxRow } from "../../store/inboxStore";
import type { ChatAttachment } from "../../store/chatSlice";
import {
  useChatMembers,
  useThreadInboxCards,
  useThreadMessages,
  useThreadSync,
  useThreadsInboxSync,
  type ThreadInboxCard,
} from "../../hooks/useChatSync";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { buildChatTimeline } from "@codecast/shared/chat";
import { channelDisplayName, memberName } from "../../lib/chatViews";
import { setChatFocus, clearChatFocus } from "../../lib/chatFocus";
import { CommentAvatar } from "../comments/CommentAvatar";
import { ChatMessage, ChatNewDivider } from "./ChatMessage";
import { ChatComposer } from "./ChatComposer";
import type { ChatMessageView } from "./chatTypes";
import "./chat.css";

// The Threads inbox: every conversation the viewer is in, on one page —
// Slack's Threads view. Each card is one thread: the room it lives in, its
// root message, and a one-line rollup of the replies. Expanding a card opens
// the whole thread IN PLACE, composer included, so a person walks their
// threads top to bottom without ever leaving the page.
//
// READS FOLLOW THE PAGE'S OWN LAW: expanding a thread while the reader is
// actually present (tab active, window focused) marks it read; arrival,
// hydration and background sync never do. The unread rule inside an expanded
// thread is FROZEN at expansion, exactly like the channel freezes its rule at
// entry — otherwise the mark-read write would erase the boundary mid-read.

function age(now: number, ts: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The expanded half of a card. Its own component so the live thread
 *  subscription and the read-mark effect mount only for the one open thread. */
function ExpandedThread({
  entry,
  channelName,
  teamId,
  viewerId,
  knownHandles,
  selfHandles,
  present,
  now,
  frozenReadAt,
}: {
  entry: ChatThreadInboxRow;
  channelName: string;
  teamId?: string;
  viewerId: string;
  knownHandles?: Set<string>;
  selfHandles?: Set<string>;
  present: boolean;
  now: number;
  frozenReadAt: number;
}) {
  const rootId = entry.root_id;
  useThreadSync(rootId);
  const thread = useThreadMessages(rootId);

  // Reading is presence + the thread being open, the same statement the
  // channel makes by reporting "newest on screen". Re-marks when new replies
  // land while the reader is still looking (last_activity_at moves).
  useEffect(() => {
    if (!present) return;
    if (entry.last_read_at >= entry.last_activity_at && entry.unread === 0) return;
    useInboxStore.getState().markThreadRead(rootId);
  }, [present, rootId, entry.last_activity_at, entry.last_read_at, entry.unread]);

  // The open thread is being read: its own arrivals must not toast at the
  // reader (lib/chatFocus is the toast layer's source of truth).
  useEffect(() => {
    if (!present) return;
    setChatFocus({ channelId: entry.channel_id, threadRootId: rootId });
    return () => clearChatFocus();
  }, [present, entry.channel_id, rootId]);

  const rows = useMemo(
    () =>
      buildChatTimeline(
        thread.replies.map((m: ChatMessageView) => ({
          id: m.id,
          authorId: m.author.id,
          createdAt: m.createdAt,
          pendingAgent: m.agentStatus === "thinking" || m.agentStatus === "streaming",
          deleted: !!m.deletedAt,
          view: m,
        })),
        { now, lastReadAt: frozenReadAt, viewerId, withoutDays: true },
      ),
    [thread.replies, now, frozenReadAt, viewerId],
  );

  const send = useCallback(
    (content: string, attachments?: ChatAttachment[]) => {
      useInboxStore.getState().sendChatMessage(entry.channel_id, content, {
        threadRootId: rootId,
        attachments,
      });
    },
    [entry.channel_id, rootId],
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

  return (
    <div className="ch-tcard-open">
      <div className="ch-tcard-replies">
        {rows.map((row) =>
          row.kind === "new" ? (
            <ChatNewDivider key={row.key} />
          ) : row.kind === "message" ? (
            <ChatMessage
              key={row.key}
              message={(row.message as any).view}
              channelId={entry.channel_id}
              knownHandles={knownHandles}
              selfHandles={selfHandles}
              now={now}
              mine={(row.message as any).view.author.id === viewerId}
              grouped={row.grouped}
              inThread
              onReact={react}
              onEdit={edit}
              onDelete={del}
              onRetrySend={retry}
            />
          ) : null,
        )}
      </div>
      <ChatComposer
        channelId={entry.channel_id}
        threadRootId={rootId}
        teamId={teamId}
        placeholder={`Reply in #${channelName}…`}
        onSend={send}
        compact
        autoFocus
      />
    </div>
  );
}

const ThreadCard = memo(function ThreadCard({
  card,
  expanded,
  frozenReadAt,
  viewerId,
  knownHandles,
  selfHandles,
  present,
  now,
  members,
  nameOf,
  onToggle,
}: {
  card: ThreadInboxCard;
  expanded: boolean;
  /** The unread boundary as it stood when the card was expanded. */
  frozenReadAt: number;
  viewerId: string;
  knownHandles?: Set<string>;
  selfHandles?: Set<string>;
  present: boolean;
  now: number;
  /** The live roster (useChatMembers), so a renamed teammate renames the room. */
  members: any[];
  nameOf: (userId: string) => string;
  onToggle: (rootId: string) => void;
}) {
  const router = useRouter();
  const { entry, root, channel } = card;
  const roomName = channel ? channelDisplayName(channel, members) : "channel";
  const isDm = channel?.kind === "dm";
  const unread = entry.unread > 0;

  const openInChannel = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      router.push(`/chat/${entry.channel_id}?m=${entry.root_id}`);
    },
    [router, entry.channel_id, entry.root_id],
  );

  const replyCount = root?.replyCount ?? 0;
  const lastReply = entry.last_reply;

  return (
    <section className={`ch-tcard ${unread ? "ch-tcard-unread" : ""} ${expanded ? "ch-tcard-expanded" : ""}`}>
      <button type="button" className="ch-tcard-head" onClick={() => onToggle(entry.root_id)}>
        <span className="ch-tcard-chan">
          <span className="ch-tcard-chanicon" aria-hidden="true">
            {isDm ? <Users className="w-3 h-3" /> : channel?.isPrivate ? <Lock className="w-3 h-3" /> : <Hash className="w-3 h-3" />}
          </span>
          {roomName}
        </span>
        {unread && (
          <span className="ch-tcard-badge" aria-label={`${entry.unread} new replies`}>
            {entry.unread}{entry.unread_capped ? "+" : ""} new
          </span>
        )}
        <span className="ch-tcard-spacer" />
        <span className="ch-tcard-age" title={new Date(entry.last_activity_at).toLocaleString()}>
          {age(now, entry.last_activity_at)}
        </span>
        <span
          className="ch-tool ch-tcard-tool"
          role="button"
          tabIndex={0}
          title="Open in channel"
          onClick={openInChannel}
          onKeyDown={(e) => { if (e.key === "Enter") openInChannel(e as any); }}
        >
          <ExternalLink className="w-3 h-3" />
        </span>
        <span className="ch-tcard-caret" aria-hidden="true">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </button>

      {root ? (
        <div className="ch-tcard-root">
          <ChatMessage
            message={root}
            channelId={entry.channel_id}
            knownHandles={knownHandles}
            selfHandles={selfHandles}
            now={now}
            mine={root.author.id === viewerId}
            inThread
          />
        </div>
      ) : (
        <div className="ch-tcard-root ch-tcard-ghost" aria-hidden="true">
          <div className="ch-skel-line ch-skel-head" />
          <div className="ch-skel-line" style={{ width: "62%" }} />
        </div>
      )}

      {expanded ? (
        <ExpandedThread
          entry={entry}
          channelName={channel?.kind === "dm" ? roomName : channel?.name ?? "channel"}
          teamId={channel?.teamId}
          viewerId={viewerId}
          knownHandles={knownHandles}
          selfHandles={selfHandles}
          present={present}
          now={now}
          frozenReadAt={frozenReadAt}
        />
      ) : (
        <button type="button" className="ch-tcard-summary" onClick={() => onToggle(entry.root_id)}>
          {(root?.replyFaces ?? []).slice(0, 4).map((f) => (
            <span key={f.id} className="ch-tcard-face">
              <CommentAvatar name={f.name} image={f.avatarUrl} size={16} letters={1} />
            </span>
          ))}
          <span className="ch-tcard-count">
            {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : "View thread"}
          </span>
          {lastReply && (
            <span className="ch-tcard-preview">
              <span className="ch-tcard-preview-name">{nameOf(lastReply.user_id)}:</span>{" "}
              {lastReply.preview}
            </span>
          )}
        </button>
      )}
    </section>
  );
});

export function ChatThreadsView({ present }: { present: boolean }) {
  const feed = useThreadsInboxSync();
  const cards = useThreadInboxCards();
  const { members, byId, viewerId, handles } = useChatMembers();
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;
  const headTitlebarRef = useTitlebarHead<HTMLElement>();
  // One shared clock for the whole page (the channel page's own rule: honest
  // relative times without a re-render per row per second).
  const now = useCoarseNow(30_000);

  // One thread open at a time — the page is a queue to walk, and a second open
  // thread would steal the composer's draft focus story. The unread boundary is
  // captured at expansion so marking read cannot erase it mid-read.
  const [open, setOpen] = useState<{ rootId: string; frozenReadAt: number } | null>(null);
  const toggle = useCallback(
    (rootId: string) => {
      setOpen((prev) => {
        if (prev?.rootId === rootId) return null;
        const entry = useInboxStore.getState().chatThreadInbox[rootId];
        return { rootId, frozenReadAt: entry?.last_read_at ?? 0 };
      });
    },
    [],
  );

  const unreadCount = useMemo(
    () => cards.reduce((n, c) => n + (c.entry.unread > 0 ? 1 : 0), 0),
    [cards],
  );
  const markAll = useCallback(() => {
    useInboxStore.getState().markAllThreadsRead(teamId);
  }, [teamId]);

  const nameOf = useCallback(
    (userId: string) => memberName(byId.get(String(userId))),
    [byId],
  );

  const showSkeleton = cards.length === 0 && feed.loading;
  const showEmpty = cards.length === 0 && !feed.loading && !feed.error;

  return (
    <>
      <header ref={headTitlebarRef} className="ch-head">
        <span className="ch-head-name">
          <span className="ch-head-hash" aria-hidden="true">
            <MessagesSquare className="w-3 h-3 inline-block" />
          </span>
          Threads
        </span>
        <span className="ch-head-topic">
          {unreadCount > 0
            ? `${unreadCount} ${unreadCount === 1 ? "thread" : "threads"} with new replies`
            : "Every conversation you're in, one page"}
        </span>
        {unreadCount > 0 && (
          <button type="button" className="ch-tcard-markall" onClick={markAll} title="Mark every thread read">
            <CheckCheck className="w-3 h-3" />
            Mark all read
          </button>
        )}
      </header>

      {showSkeleton ? (
        <div className="ch-skeleton" role="status" aria-label="Loading threads">
          {[0, 1, 2].map((i) => (
            <div className="ch-skel-row" key={i}>
              <div className="ch-skel-avatar" />
              <div className="ch-skel-lines">
                <div className="ch-skel-line ch-skel-head" />
                <div className="ch-skel-line" style={{ width: `${70 - i * 12}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : showEmpty ? (
        <div className="ch-empty">
          <div className="ch-empty-icon" aria-hidden="true">
            <MessagesSquare className="w-5 h-5" />
          </div>
          <div className="ch-empty-title">No threads yet</div>
          <div className="ch-empty-sub">
            Reply to a message — or get a reply on yours — and the conversation lands here.
          </div>
        </div>
      ) : (
        <div className="ch-threads-scroll">
          {cards.map((card) => (
            <ThreadCard
              key={card.entry.root_id}
              card={card}
              expanded={open?.rootId === card.entry.root_id}
              frozenReadAt={open?.rootId === card.entry.root_id ? open.frozenReadAt : 0}
              viewerId={viewerId}
              knownHandles={handles.known}
              selfHandles={handles.self}
              present={present}
              now={now}
              members={members}
              nameOf={nameOf}
              onToggle={toggle}
            />
          ))}
          {feed.hasMore && (
            <button
              type="button"
              className="ch-tcard-older"
              onClick={feed.loadOlder}
              disabled={feed.isLoadingOlder}
            >
              {feed.isLoadingOlder ? "Loading…" : "Show older threads"}
            </button>
          )}
        </div>
      )}
    </>
  );
}
