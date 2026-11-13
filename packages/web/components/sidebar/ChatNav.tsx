"use client";

import { memo } from "react";
import { useRouter } from "next/navigation";
import { BellOff, Hash, Lock, MoreHorizontal, Pin, PinOff, Plus, SquarePen, Users } from "lucide-react";
import { CommentAvatar } from "../comments/CommentAvatar";
import { ChannelContextMenu } from "../chat/ChannelMenu";
import { AppPopOutButton } from "../desktop/AppPopOutButton";
import { useInboxStore } from "../../store/inboxStore";
import type { ChatRailChannel } from "../../store/chatSlice";
import { chatUnreadTotals, useChatRail, useChatMembers, supersededChannelId } from "../../hooks/useChatSync";
import { useOpenDm } from "../../hooks/useOpenDm";
import { useChannelMenu } from "../../hooks/useChannelMenu";
import { channelDisplayName, dmCounterpart, memberName, suggestedDmMembers, type ChatMember } from "../../lib/chatViews";
import { memberAvatarUrl } from "../../lib/liveEntities";
import { readPins, isThreadsPin, togglePin } from "../../lib/sidebarPins";
import { RailHeading, SectionRow, type SectionRowSpec } from "./navPrimitives";
import { ChatNavSectionView } from "./SidebarNav";
import { channelSignals } from "../../lib/chatRowSignals";

/** Every room the viewer has, as rail rows, split the way both chat lists use
 *  them: the rooms pinned to the top of the sidebar, the channels, the DMs, and
 *  teammates without a DM yet (dimmer, one click from becoming one). The chat
 *  page's rail draws suggestions with the same helper, so the lists agree. */
function useChatNavRows(pathname: string | null, onMobileClose?: () => void) {
  const rail = useChatRail();
  const router = useRouter();
  // Signature-gated roster (useChatMembers), not the raw array: these rows are
  // always mounted, and teamMembers re-pushes on presence heartbeats that
  // change nothing a rail row shows.
  const { members: teamMembers, viewerId: viewer } = useChatMembers();
  const openDm = useOpenDm();
  // The app's one context-menu system: one instance for the whole list, rows
  // open it from the ⋯ button and from right-click alike.
  const channelMenu = useChannelMenu();
  // Pin ids resolved to LIVE channel ids: a channel pinned while it was an
  // optimistic stub keeps the stub id in the pin, and the rail rows carry the
  // server id — the client_id forwarding (same as useSupersededChannelId)
  // reconnects them.
  const pinnedLiveIds = useInboxStore((s) =>
    readPins(s)
      .filter((p) => p.kind === "channel" && !isThreadsPin(p))
      .map((p) => supersededChannelId(s.chatChannels as any, p.id) ?? p.id)
      .join(","),
  ).split(",");

  const toRow = (c: ChatRailChannel): SectionRowSpec => {
    const counterpart = dmCounterpart(c, teamMembers);
    const pinned = pinnedLiveIds.includes(c.id);
    return {
      id: c.id,
      name: channelDisplayName(c, teamMembers),
      icon: c.muted
        ? <BellOff className="w-3 h-3 flex-shrink-0 opacity-50" aria-label="Muted" />
        : c.kind === "dm"
          ? counterpart
            ? <CommentAvatar name={memberName(counterpart)} image={counterpart.image || counterpart.github_avatar_url} size={14} letters={1} />
            : <Users className="w-3 h-3 flex-shrink-0 opacity-60" />
          : c.isPrivate ? <Lock className="w-3 h-3 flex-shrink-0 opacity-60" />
          : <Hash className="w-3 h-3 flex-shrink-0 opacity-60" />,
      active: pathname === `/chat/${c.id}`,
      ...channelSignals(c, String(viewer), teamMembers),
      actions: [
        {
          key: "pin",
          title: pinned ? "Unpin from top" : "Pin to top of sidebar",
          icon: pinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />,
          onClick: () => togglePin("channel", c.id, channelDisplayName(c, teamMembers)),
        },
        {
          key: "manage",
          title: "Channel settings",
          icon: <MoreHorizontal className="w-3 h-3" />,
          onClick: (e?: React.MouseEvent) => {
            if (e) channelMenu.open(e, { channelId: c.id, notifyLevel: c.notifyLevel });
          },
        },
      ],
      onSelect: () => {
        router.push(`/chat/${c.id}`);
        onMobileClose?.();
      },
      onContextMenu: (e: React.MouseEvent) =>
        channelMenu.open(e, { channelId: c.id, notifyLevel: c.notifyLevel }),
    };
  };

  const unpinned = rail.filter((c) => !pinnedLiveIds.includes(c.id));
  const pinnedRooms = pinnedLiveIds.flatMap((id) => rail.find((c) => c.id === id) ?? []);
  const suggested = suggestedDmMembers(
    rail.filter((c) => c.kind === "dm"),
    teamMembers,
    viewer,
    5,
  ).map((m): SectionRowSpec => ({
    id: `suggest-${m._id}`,
    name: memberName(m),
    title: `Message ${memberName(m)}`,
    icon: (
      <span className="opacity-70">
        <CommentAvatar name={memberName(m)} image={memberAvatarUrl(m)} size={14} letters={1} />
      </span>
    ),
    active: false,
    dim: true,
    // The affordance appears where a real row's actions do: a pencil on hover
    // says "click starts a conversation" without shouting on every row.
    trailing: <SquarePen className="w-3 h-3 text-sol-text-dim opacity-0 group-hover/v:opacity-100 flex-shrink-0" aria-hidden="true" />,
    onSelect: () => {
      openDm([String(m._id)]);
      onMobileClose?.();
    },
  }));

  return {
    rail,
    unpinned,
    toRow,
    pinned: pinnedRooms.map(toRow),
    channels: unpinned.filter((c) => c.kind !== "dm").map(toRow),
    dms: unpinned.filter((c) => c.kind === "dm").map(toRow),
    suggested,
    channelMenu,
  };
}

/** Unread rooms listed under a door-style Chat row before the rest fold into "N more". */
const UNREAD_LISTED_MAX = 6;

/** Unread the way the Chat badge counts it: a mention always, chatter unless muted. */
function isUnreadRoom(c: ChatRailChannel): boolean {
  return (c.mentionCount ?? 0) > 0 || ((c.unreadCount ?? 0) > 0 && !c.muted);
}

// Chat's sidebar row. Isolated for the same reason NeedsInputCountBadge is: the
// unread numbers move whenever anyone on the team says anything, and that must
// re-render one row rather than the whole rail.
//
// The rule the rail already follows, applied one level up: unread is WEIGHT plus
// a dot, and only a mention gets a number. A count of ordinary chatter teaches
// people to ignore counts, and then the one that matters is invisible inside it.
//
// With `onDrill`, the row is a door: the room list is a level of its own
// (ChatDrillList), so the row lists nothing and opening it goes in.
export const ChatNavRow = memo(function ChatNavRow({
  isActive,
  isNarrow,
  pathname,
  pinsShown,
  expanded,
  onToggle,
  onDrill,
  onMobileClose,
}: {
  isActive: boolean;
  isNarrow: boolean;
  pathname: string | null;
  /** The pinned rail is on screen with its channel pins, so those carry their
   *  own unread signals and the Chat row leaves them out of its totals. */
  pinsShown: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDrill?: () => void;
  onMobileClose?: () => void;
}) {
  const rows = useChatNavRows(pathname, onMobileClose);
  const visible = pinsShown ? rows.unpinned : rows.rail;
  // A door lists nothing but what moved: the rooms with unread messages sit
  // under Chat, so reading one is a click, not a trip into the room list. The
  // room you are reading stays listed until you leave it, so opening a row
  // doesn't make it vanish under the pointer.
  const unread = onDrill
    ? visible
        .filter((c) => isUnreadRoom(c) || pathname === `/chat/${c.id}`)
        .sort((a, b) => Number((b.mentionCount ?? 0) > 0) - Number((a.mentionCount ?? 0) > 0))
    : [];
  const listed = unread.slice(0, UNREAD_LISTED_MAX);
  const listedIds = new Set(listed.map((c) => c.id));
  // Count what no row on screen already shows: a pinned room badges its pinned
  // row, a listed room badges itself, and repeating either on Chat points at
  // nothing new. What's left is the overflow past the list.
  const { channels, mentions } = chatUnreadTotals(visible.filter((c) => !listedIds.has(c.id)));
  const overflow = unread.length - listed.length;
  return (
    <>
      <ChatNavSectionView
        isActive={isActive}
        isNarrow={isNarrow}
        onMobileClose={onMobileClose}
        channels={channels}
        mentions={mentions}
        // Channels first, then direct messages: the icon carries the
        // distinction (a hash is a room, a face is a person), so the sublist
        // needs no group headers. A pinned room already has its row up top.
        items={
          onDrill
            ? [
                ...listed.map(rows.toRow),
                ...(overflow > 0
                  ? [{
                      id: "chat-unread-more",
                      name: `${overflow} more`,
                      title: "Every room with unread messages",
                      icon: <MoreHorizontal className="w-3 h-3 flex-shrink-0 opacity-60" />,
                      dim: true,
                      onSelect: () => onDrill(),
                    } satisfies SectionRowSpec]
                  : []),
              ]
            : [...rows.channels, ...rows.dms, ...rows.suggested]
        }
        alwaysOpen={!!onDrill}
        headerAction={<AppPopOutButton app="chat" className="mr-1" />}
        expanded={expanded}
        onToggle={onToggle}
        onDrill={onDrill}
      />
      <ChannelContextMenu state={rows.channelMenu} />
    </>
  );
});

/** Chat's own level of the sidebar: every room, full height, grouped. */
export const ChatDrillList = memo(function ChatDrillList({
  pathname,
  onMobileClose,
}: {
  pathname: string | null;
  onMobileClose?: () => void;
}) {
  const rows = useChatNavRows(pathname, onMobileClose);
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  const group = (label: string, list: SectionRowSpec[], action?: React.ReactNode) =>
    list.length > 0 || action ? (
      <>
        <RailHeading label={label} isNarrow={false} action={action} />
        <div className="mb-1">
          {list.map((row) => <SectionRow key={row.id} row={row} className="pl-2" />)}
        </div>
      </>
    ) : null;
  return (
    <>
      {group("Pinned", rows.pinned)}
      {group(
        "Channels",
        rows.channels,
        <button
          type="button"
          onClick={() => openCreateModal("chat")}
          className="p-0.5 -my-0.5 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight"
          title="New channel"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>,
      )}
      {group("Direct messages", [...rows.dms, ...rows.suggested])}
      <ChannelContextMenu state={rows.channelMenu} />
    </>
  );
});
