import { memo } from "react";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { Hash, Lock, Plus, BellOff, Users, SquarePen } from "lucide-react";
import type { ChatChannelView } from "./chatTypes";
import { OccupancyChip } from "../calls/OccupancyChip";
import { CommentAvatar } from "../comments/CommentAvatar";
import {
  channelDisplayName,
  chatViewRoomKey,
  dmCounterpart,
  memberName,
  suggestedDmMembers,
  type ChatMember,
} from "../../lib/chatViews";
import { useInboxStore } from "../../store/inboxStore";
import { memberAvatarUrl } from "../../lib/liveEntities";
import "./chat.css";

// The channel rail.
//
// Three states have to be distinguishable at a glance without reading numbers:
// read (dim), unread (full strength and semibold), and mentioning you (a red
// count). Unread is carried by weight rather than colour because colour is
// already busy marking the active channel — using it for both makes neither
// legible.
//
// Two sections, one row shape. Channels wear a hash (or a lock), direct
// messages wear the person's face — the icon IS the distinction, the row's
// unread grammar stays identical.

function RailRow({
  c,
  active,
  members,
  viewer,
  onSelect,
  onChannelContextMenu,
}: {
  c: ChatChannelView;
  active: boolean;
  members: ChatMember[];
  viewer: string;
  onSelect: (channelId: string) => void;
  onChannelContextMenu?: (e: React.MouseEvent, channel: ChatChannelView) => void;
}) {
  const unread = (c.unreadCount ?? 0) > 0;
  const mentions = c.mentionCount ?? 0;
  const isDm = c.kind === "dm";
  const name = channelDisplayName(c, members);
  const counterpart = dmCounterpart(c, members);
  const cls = [
    "ch-chan",
    active ? "ch-chan-active" : "",
    // An active channel is being read, so it never also shouts unread.
    unread && !active ? "ch-chan-unread" : "",
    c.muted ? "ch-chan-muted" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      key={c.id}
      type="button"
      className={cls}
      onClick={() => onSelect(c.id)}
      onContextMenu={onChannelContextMenu ? (e) => onChannelContextMenu(e, c) : undefined}
      aria-current={active ? "page" : undefined}
      title={c.topic || (isDm ? name : `#${name}`)}
    >
      <span className="ch-chan-hash" aria-hidden="true">
        {isDm ? (
          counterpart ? (
            <CommentAvatar
              name={memberName(counterpart)}
              image={memberAvatarUrl(counterpart)}
              size={15}
              letters={1}
            />
          ) : (
            <Users className="w-3 h-3" />
          )
        ) : c.isPrivate ? (
          <Lock className="w-3 h-3" />
        ) : (
          <Hash className="w-3 h-3" />
        )}
      </span>
      <span className="ch-chan-name">{name}</span>
      <OccupancyChip roomKey={chatViewRoomKey(c, viewer, members)} className="shrink-0" />
      {c.muted && <BellOff className="w-3 h-3 shrink-0 opacity-70" aria-label="Muted" />}
      {mentions > 0 ? (
        <span className="ch-chan-badge" aria-label={`${mentions} mentions`}>
          {mentions > 99 ? "99+" : mentions}
        </span>
      ) : (
        // A muted channel with unread messages gets a dot, not a count:
        // you asked not to be counted at, but the room is still alive.
        unread && !active && c.muted && <span className="ch-chan-dot" aria-label="Unread" />
      )}
    </button>
  );
}

export const ChatChannelRail = memo(function ChatChannelRail({
  channels,
  activeChannelId,
  onSelect,
  onCreate,
  onNewMessage,
  onOpenDm,
  onChannelContextMenu,
}: {
  channels: ChatChannelView[];
  activeChannelId?: string;
  onSelect: (channelId: string) => void;
  onCreate?: () => void;
  /** Opens the new-message modal. */
  onNewMessage?: () => void;
  /** A suggested teammate was clicked — open (or create) the 1:1 room. */
  onOpenDm?: (memberId: string) => void;
  /** Right-click on a row — opens the shared channel menu. */
  onChannelContextMenu?: (e: React.MouseEvent, channel: ChatChannelView) => void;
}) {
  const members = useInboxStore((s) => s.teamMembers) as ChatMember[];
  const viewer = useInboxStore((s) => (s as any).currentUser?._id ?? "");
  const rooms = channels.filter((c) => c.kind !== "dm");
  const dms = channels.filter((c) => c.kind === "dm");
  // The section never opens empty: teammates without an open room are listed
  // right below the real conversations, dimmer, one click from becoming one.
  const suggested = onOpenDm ? suggestedDmMembers(dms, members, viewer) : [];
  const headTitlebarRef = useTitlebarHead<HTMLDivElement>();
  return (
    <nav className="ch-rail" aria-label="Channels">
      <div ref={headTitlebarRef} className="ch-rail-head">
        <span className="ch-rail-title">Channels</span>
        {onCreate && (
          <button type="button" className="ch-rail-add" title="New channel" onClick={onCreate}>
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="ch-rail-list">
        {rooms.map((c) => (
          <RailRow
            key={c.id}
            c={c}
            active={c.id === activeChannelId}
            members={members}
            viewer={String(viewer)}
            onSelect={onSelect}
            onChannelContextMenu={onChannelContextMenu}
          />
        ))}
      </div>
      <div className="ch-rail-head ch-rail-head-dms">
        <span className="ch-rail-title">Direct messages</span>
        {onNewMessage && (
          <button type="button" className="ch-rail-add" title="New message" onClick={onNewMessage}>
            <SquarePen className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="ch-rail-list">
        {dms.map((c) => (
          <RailRow
            key={c.id}
            c={c}
            active={c.id === activeChannelId}
            members={members}
            viewer={String(viewer)}
            onSelect={onSelect}
            onChannelContextMenu={onChannelContextMenu}
          />
        ))}
        {suggested.map((m) => (
          <button
            key={String(m._id)}
            type="button"
            className="ch-chan ch-chan-suggest"
            title={`Message ${memberName(m)}`}
            onClick={() => onOpenDm!(String(m._id))}
          >
            <span className="ch-chan-hash" aria-hidden="true">
              <CommentAvatar
                name={memberName(m)}
                image={memberAvatarUrl(m)}
                size={15}
                letters={1}
              />
            </span>
            <span className="ch-chan-name">{memberName(m)}</span>
          </button>
        ))}
        {dms.length === 0 && suggested.length === 0 && (
          <div className="ch-rail-empty-dms">Messages with teammates land here.</div>
        )}
      </div>
    </nav>
  );
});
