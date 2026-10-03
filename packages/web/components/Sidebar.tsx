import { SlackLogo } from "./SlackLogo";
import { MIRROR_STATE_LABEL } from "@codecast/convex/convex/lib/slackMirror";
import { useCallsAvailable, useTeamFeature, useWorkspaceFeature } from "../lib/teamFeatures";
import Link from "next/link";
import { agentName, useRootAgent } from "../hooks/useSyncAnchors";
import { AnchorAvatar } from "./anchor/AnchorIdentity";
import { usePathname, useRouter } from "next/navigation";
import { lazy, Suspense, useState, useMemo, useCallback, useRef, memo } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { AvatarImg } from "../lib/avatarCache";
import { useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { cleanTitle } from "../lib/conversationProcessor";
import { visitTimeAgo } from "../lib/recentVisits";
import { getLabelColor } from "../lib/labelColors";
import { shouldShowSession } from "../lib/sessionFilters";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useCollectionRows } from "../hooks/useCollectionRows";
import { useNeedsInputCount } from "../hooks/useNeedsInputCount";
import { useDecisionQueue } from "../hooks/useDecisionQueue";
import { waitingOnPerson } from "../lib/decisionQueue";
import { chatUnreadTotals, useChatRail, useChatMembers, supersededChannelId } from "../hooks/useChatSync";
import { useOpenDm } from "../hooks/useOpenDm";
import { useThreadUnread } from "../hooks/useThreadsSync";
import { ChannelContextMenu } from "./chat/ChannelMenu";
import { useChannelMenu } from "../hooks/useChannelMenu";
import { channelDisplayName, chatViewRoomKey, dmCounterpart, memberName, suggestedDmMembers } from "../lib/chatViews";
import { memberAvatarUrl } from "../lib/liveEntities";
import { dmOtherIds } from "@codecast/shared/chat";
import { CommentAvatar } from "./comments/CommentAvatar";
import { readPins, isPinned, isThreadsPin, pinApp, togglePin, type SidebarPin } from "../lib/sidebarPins";
import { useConvexSync } from "../hooks/useConvexSync";
import { useSyncProjects } from "../hooks/useSyncProjects";
import { useSyncSavedViews } from "../hooks/useSyncSavedViews";
import { activeViewId, currentViewId, VIEW_ID_KEY } from "../lib/savedViews";
import { projectDotClass } from "../lib/projectColors";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { toast } from "sonner";
import { ContextMenu, CtxItem, useContextMenu } from "./ui/context-menu";
import { MessagesSquare, FolderKanban, Layers, Users, UserMinus, Hash, MoreHorizontal, Pin, PinOff, BellOff, Lock, SquarePen, Phone, PhoneCall, Monitor, Smartphone } from "lucide-react";
import { NATIVE_APP_COPY, NATIVE_APP_LINKS, nativeAppOffer, trackNativeAppClick } from "../lib/nativeApps";
import { useSyncTeams } from "../hooks/useSyncTeams";
import { AppPopOutButton } from "./desktop/AppPopOutButton";
import type { DesktopApp } from "../lib/desktopApps";
import { WorkbenchSection } from "./WorkbenchSection";
import { RailHeading, SectionRow, NavCount, NeedsInputCount, InboxNavRow, type SectionRowSpec } from "./sidebar/navPrimitives";
import { ChatNavSectionView, FeedNavRowView, QuestionsNavRowView, SidebarNavView, ThreadsNavRowView } from "./sidebar/SidebarNav";
import { paneDragProps, railRowTone } from "../lib/railRow";
import { usePoppedOut } from "../hooks/usePoppedOut";
import { inActiveWorkspace } from "../lib/workspaceScope";
import { useWorkspaceCollection } from "../hooks/useWorkspaceCollection";

const CreateTaskModal = lazy(() =>
  import("./CreateTaskModal").then((module) => ({ default: module.CreateTaskModal })),
);
const CreateDocModal = lazy(() =>
  import("./CreateDocModal").then((module) => ({ default: module.CreateDocModal })),
);
const CreateChannelModal = lazy(() =>
  import("./CreateChannelModal").then((module) => ({ default: module.CreateChannelModal })),
);
const NewMessageModal = lazy(() =>
  import("./chat/NewMessageModal").then((module) => ({ default: module.NewMessageModal })),
);
const OccupancyChip = lazy(() =>
  import("./calls/OccupancyChip").then((module) => ({ default: module.OccupancyChip })),
);
const LiveNowRail = lazy(() =>
  import("./calls/LiveNow").then((module) => ({ default: module.LiveNowRail })),
);

const api = _api as any;

interface SidebarProps {
  // The active workspace filter, derived from the activity-feed tab's `?dir=` by
  // DashboardLayout (the feed lives at /team/activity). Drives the "Workspaces"
  // highlight; clicking a workspace navigates there with the param toggled.
  directoryFilter?: string | null;
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
  isNarrow?: boolean;
  /** Which groups to draw. The Work window's own rail is the pinned rail
   *  and the Work group (lib/desktopApps); the main window draws them all. */
  scope?: "work";
}

/** Stable empty bag: a fresh {} here would rewake every reader on each render. */
const NO_SECTION_PINS: Record<string, boolean> = Object.freeze({});

function getShortPath(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  if (parts.length === 0) return projectPath;
  return parts[parts.length - 1];
}

// The "needs input" count is the only thing in the Sidebar that depends on the
// whole sessions map, which gets a fresh identity on every ~1s heartbeat.
// Isolating it here means a heartbeat re-renders just this 20px badge instead of
// the entire Sidebar (favorites, bookmarks, recents). Mirrors ActiveAgentsBadge
// in DashboardLayout. Only mounted in the non-narrow rail, so no work when narrow.
const NeedsInputCountBadge = memo(function NeedsInputCountBadge() {
  const needsInputCount = useNeedsInputCount();
  return <NeedsInputCount n={needsInputCount} />;
});

// The decision queue's row. Same isolation rule as the badge above: the count
// changes whenever any agent asks or gets answered, and that must re-render one
// row, not the rail. Hidden entirely at zero — an empty queue should take up no
// attention, which is the whole premise of the feature.
const QuestionsNavRow = memo(function QuestionsNavRow({
  isActive,
  isNarrow,
  onMobileClose,
}: {
  isActive: boolean;
  isNarrow: boolean;
  onMobileClose?: () => void;
}) {
  // Count what the QUEUE holds, not just the authored `cast decide` rows: the
  // queue also carries sessions parked on an AskUserQuestion or permission
  // prompt. Counting only decisions hid this row at zero while the queue still
  // had work — removing the only way in. One hook defines "pending" for both.
  // Minus the rows a lead holds under a grant: those are the lead's to clear.
  const pending = waitingOnPerson(useDecisionQueue()).length;
  if (pending === 0) return null;
  return <QuestionsNavRowView isActive={isActive} isNarrow={isNarrow} onMobileClose={onMobileClose} pending={pending} />;
});

// The Threads inbox's row: every conversation you are in, across chat, session
// comments and tasks. Always rendered — it is not chat UI, so no feature gate.
// Isolated like the rows around it: the count moves whenever anyone replies
// anywhere, and that must re-render one row, not the rail. The count is CYAN
// (replies in your threads are addressed to you, but nobody typed your name);
// the narrow rail keeps only a dot.
const ThreadsNavRow = memo(function ThreadsNavRow({
  isActive,
  isNarrow,
  onMobileClose,
}: {
  isActive: boolean;
  isNarrow: boolean;
  onMobileClose?: () => void;
}) {
  const unread = useThreadUnread();
  return <ThreadsNavRowView isActive={isActive} isNarrow={isNarrow} onMobileClose={onMobileClose} unread={unread} />;
});

// Chat's sidebar row. Isolated for the same reason NeedsInputCountBadge is: the
// unread numbers move whenever anyone on the team says anything, and that must
// re-render one row rather than the whole rail.
//
// The rule the rail already follows, applied one level up: unread is WEIGHT plus
// a dot, and only a mention gets a number. A count of ordinary chatter teaches
// people to ignore counts, and then the one that matters is invisible inside it.
/** The live signals a chat row wears wherever it lives — the Chat sublist and
 *  the pinned rail spread this same pair, so the rules can't drift: a huddle
 *  you can walk into first, then a mention count, then the unread dot.
 *
 *  The huddle chip goes in `control` and the counts in `trailing`, because the
 *  two answer to different rules on hover. The counts are information and give
 *  the row's width to the hover actions; the chip is the join button, and
 *  hiding it on hover meant the pointer wiped it out on the way to clicking
 *  it — the one gesture on the row you could never complete with a mouse. */
function channelSignals(
  channel: import("../store/chatSlice").ChatRailChannel,
  viewer: string,
  teamMembers: import("../lib/chatViews").ChatMember[],
): { control: React.ReactNode; trailing: React.ReactNode } {
  return {
    control: (
      <Suspense fallback={null}>
        <OccupancyChip roomKey={chatViewRoomKey(channel, viewer, teamMembers)} className="flex-shrink-0" />
      </Suspense>
    ),
    trailing: (
      <span className="flex items-center gap-1.5">
        {/* A mirrored channel wears the Slack mark as its label: its name is
            the Slack channel's name, so the mark says where the name is from. */}
        {channel.slack && (
          <SlackLogo
            className="nav-slack-mark w-2.5 h-2.5 flex-shrink-0"
            muted={channel.slack.state !== "live"}
            title={`${MIRROR_STATE_LABEL[channel.slack.state]} · #${channel.slack.name}`}
          />
        )}
        {(channel.mentionCount ?? 0) > 0 ? (
          <NavCount n={channel.mentionCount ?? 0} tone="bg-sol-red text-white" small kind="mention" />
        ) : (channel.unreadCount ?? 0) > 0 ? (
          <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan flex-shrink-0" aria-label="Unread" />
        ) : null}
      </span>
    ),
  };
}

const ChatNavRow = memo(function ChatNavRow({
  isActive,
  isNarrow,
  pathname,
  pinsShown,
  expanded,
  onToggle,
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
  onMobileClose?: () => void;
}) {
  const rail = useChatRail();
  const router = useRouter();
  // Signature-gated roster (useChatMembers), not the raw array: this row is
  // always mounted and memo-isolated, and teamMembers re-pushes on presence
  // heartbeats that change nothing a rail row shows.
  const { members: teamMembers, viewerId: viewer } = useChatMembers();
  const openDm = useOpenDm();
  // The app's one context-menu system: one instance for the whole list, rows
  // open it from the ⋯ button and from right-click alike.
  const channelMenu = useChannelMenu();
  // Same rule the saved-view rows follow: the pin action names the state it
  // would change, so a pinned channel offers "Unpin" right where it was pinned.
  const pinnedKeys = useInboxStore((s) => readPins(s).map((x) => `${x.kind}:${x.id}`).join(","));
  const isChannelPinned = (id: string) => pinnedKeys.split(",").includes(`channel:${id}`);
  // Pin ids resolved to LIVE channel ids: a channel pinned while it was an
  // optimistic stub keeps the stub id in the pin, and the rail rows carry the
  // server id — the client_id forwarding (same as useSupersededChannelId)
  // reconnects them so the pinned row still dedupes out of this sublist.
  const pinnedLiveIds = useInboxStore((s) =>
    readPins(s)
      .filter((p) => p.kind === "channel" && !isThreadsPin(p))
      .map((p) => supersededChannelId(s.chatChannels as any, p.id) ?? p.id)
      .join(","),
  );
  const pinnedLiveIdSet = pinnedLiveIds.split(",");

  // Channels first, then direct messages — each half keeps its own activity
  // order. The icon carries the distinction: a hash is a room, a face is a
  // person, so the rail needs no group headers to read at a glance. A pinned
  // channel already has a row in the Pinned rail up top; listing it here too
  // would duplicate it, so the sublist skips it.
  const ordered = [...rail.filter((c) => c.kind !== "dm"), ...rail.filter((c) => c.kind === "dm")]
    .filter((c) => !pinnedLiveIdSet.includes(c.id));
  // Count what the pins don't already show: a pinned DM's mentions badge its
  // pinned row, and repeating them on Chat points at a list that hides them.
  const { channels, mentions } = chatUnreadTotals(pinsShown ? ordered : rail);
  const items = ordered.map((c) => {
    const counterpart = dmCounterpart(c, teamMembers);
    const dmIcon = counterpart ? (
      <CommentAvatar
        name={memberName(counterpart)}
        image={counterpart.image || counterpart.github_avatar_url}
        size={14}
        letters={1}
      />
    ) : (
      <Users className="w-3 h-3 flex-shrink-0 opacity-60" />
    );
    return {
    id: c.id,
    name: channelDisplayName(c, teamMembers),
    icon: c.muted
      ? <BellOff className="w-3 h-3 flex-shrink-0 opacity-50" aria-label="Muted" />
      : c.kind === "dm" ? dmIcon
      : c.isPrivate ? <Lock className="w-3 h-3 flex-shrink-0 opacity-60" />
      : <Hash className="w-3 h-3 flex-shrink-0 opacity-60" />,
    active: pathname === `/chat/${c.id}`,
    ...channelSignals(c, String(viewer), teamMembers),
    actions: [
      {
        key: "pin",
        title: isChannelPinned(c.id) ? "Unpin from top" : "Pin to top of sidebar",
        icon: isChannelPinned(c.id) ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />,
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
  });

  // The DM half of the rail never runs dry: teammates without an open room sit
  // below the real conversations, dimmer, one click from becoming one. Same
  // helper as the chat page's rail, so the two lists cannot disagree.
  const suggestedItems = suggestedDmMembers(
    rail.filter((c) => c.kind === "dm"),
    teamMembers,
    viewer,
    5,
  ).map((m) => ({
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

  return (
    <>
      <ChatNavSectionView
        isActive={isActive}
        isNarrow={isNarrow}
        onMobileClose={onMobileClose}
        channels={channels}
        mentions={mentions}
        items={[...items, ...suggestedItems]}
        headerAction={<AppPopOutButton app="chat" className="mr-1" />}
        expanded={expanded}
        onToggle={onToggle}
      />
      <ChannelContextMenu state={channelMenu} />
    </>
  );
});

// Calls' sidebar row. Isolated like ChatNavRow: presence heartbeats move
// teammates' `in_room_key` constantly, and that must re-render one row, not
// the rail. The live signal reads the same store fields the avatar strip
// reads — no extra query, and honest the moment anyone joins a room.
const CallsNavRow = memo(function CallsNavRow({
  isActive,
  isNarrow,
  onMobileClose,
}: {
  isActive: boolean;
  isNarrow: boolean;
  onMobileClose?: () => void;
}) {
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  // Distinct occupied rooms across the roster, plus the room I'm in myself
  // (my own heartbeat may not have landed in the roster yet). Primitive
  // return, so presence churn that changes nothing re-renders nobody.
  const liveRooms = useInboxStore((s) => {
    const keys = new Set<string>();
    // The authoritative list (calls.getLiveRooms) plus the strip's view of it:
    // the union keeps the dot honest before the query has landed, and adds the
    // rooms only the server list knows about (a teammate outside my strip, a
    // huddle whose occupants hide their room key).
    for (const r of (s as any).liveRooms ?? []) keys.add(r.room_key);
    for (const m of s.teamMembers ?? []) if (m?.in_room_key) keys.add(m.in_room_key);
    if (s.call?.roomKey) keys.add(s.call.roomKey);
    return keys.size;
  });
  // Calls live in the Chat window while there is one: this row is a door.
  const away = usePoppedOut("chat");
  return (
    <div
      className={`group/calls flex items-center border-l-2 transition-colors motion-reduce:transition-none ${railRowTone(isActive && !away)}${away ? " opacity-55 hover:opacity-90" : ""}`}
    >
      <Link
        href="/calls"
        onClick={onMobileClose}
        {...paneDragProps("/calls", "Calls")}
        data-nav-row
        className={`flex-1 flex items-center ${isNarrow ? "justify-center" : "gap-3"} px-4 py-2.5 min-w-0`}
        title={away ? "Calls: opens in the Chat window" : "Calls — live huddles and transcripts"}
      >
        <span className="relative flex-shrink-0">
          <Phone className="w-5 h-5" strokeWidth={1.5} />
          {/* Narrow rail is icon-only, so the live signal rides the icon. */}
          {isNarrow && liveRooms > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-green opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-sol-green" />
            </span>
          )}
        </span>
        {!isNarrow && (
          <>
            <span>Calls</span>
            {liveRooms > 0 && (
              <span className="relative flex h-2 w-2" aria-label="Live huddle">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-green opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-sol-green" />
              </span>
            )}
          </>
        )}
      </Link>
      {/* Start a huddle from where you'd look for one — same modal as the
          palette's "Start Huddle", revealed on hover like the rail's other
          row actions. */}
      {!isNarrow && (
        <button
          onClick={() => openCreateModal("huddle")}
          className="p-1 mr-2 rounded text-sol-text-dim opacity-0 group-hover/calls:opacity-100 hover:text-sol-green transition-opacity"
          title="Start huddle"
        >
          <PhoneCall className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
});

// The rail of pinned subsection rows — projects, saved views, channels —
// resolved LIVE from the store so renames follow, with the pin-time label as
// the fallback for objects the cache no longer holds.
function PinnedRail({
  onNavigate,
  applyView,
  activeViewIds,
  scope,
}: {
  onNavigate: (href: string) => void;
  applyView: (view: any) => void;
  /** An app's own window shows only that app's pins (pinApp). */
  scope?: DesktopApp;
  /** Ids of the currently applied saved views (tasks page, docs page) — a
   *  pinned view lights up exactly when its section row would. */
  activeViewIds: Array<string | undefined>;
}) {
  const pathname = usePathname();
  const pins = useInboxStore((s) => readPins(s));
  const threadsUnread = useThreadUnread();
  // The counted rail: a pinned channel is that channel's ONLY row (the Chat
  // sublist skips pinned ids), so its unread signals must ride the pin.
  const chatRail = useChatRail();
  const projects = useInboxStore((s) => s.projects);
  const savedViews = useInboxStore((s) => (s as any).savedViews);
  const chatChannels = useInboxStore((s) => s.chatChannels);
  // Identity-stable roster: the raw teamMembers array re-pushes every few
  // seconds on teammates' recent_session_* churn.
  const { members: teamMembers, viewerId: viewer } = useChatMembers();
  // A pinned channel is chat UI: gone with the feature (the pin itself is
  // kept, so turning chat back on restores it). The Threads pin is a VIEW even
  // in its legacy channel-kind form (isThreadsPin), so it survives chat off.
  const chatOn = useTeamFeature("chat");
  // Right-click on a pin: a channel opens its full channel menu (which carries
  // Unpin), every other pin a menu with just Unpin.
  const channelMenu = useChannelMenu();
  const pinMenu = useContextMenu<SidebarPin>();
  const visiblePins = (chatOn ? pins : pins.filter((p) => isThreadsPin(p) || p.kind !== "channel"))
    .filter((p) => !scope || pinApp(p) === scope);
  if (visiblePins.length === 0) return null;

  // The icon already names the kind (a hash IS the channel marker), so the
  // label is just the name — never "# #team".
  const resolve = (pin: SidebarPin): SectionRowSpec => {
    const base = {
      id: `${pin.kind}:${pin.id}`,
      actions: [{
        key: "unpin",
        title: "Unpin",
        icon: <PinOff className="w-3 h-3" />,
        onClick: () => togglePin(pin.kind, pin.id, pin.label),
      }],
      onContextMenu: (e: React.MouseEvent) => pinMenu.open(e, pin),
    };
    // The Threads page, whichever kind the pin was stored under: its own
    // icon, and the same cyan count the rail's Threads row wears.
    if (isThreadsPin(pin)) {
      return {
        ...base,
        name: "Threads",
        path: "/threads",
        icon: <MessagesSquare className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />,
        trailing:
          threadsUnread > 0 ? <NavCount n={threadsUnread} tone="bg-sol-cyan text-sol-bg" small /> : null,
        active: pathname === "/threads",
        onSelect: () => onNavigate("/threads"),
      };
    }
    if (pin.kind === "project") {
      const p = (projects as any)?.[pin.id];
      return {
        ...base,
        name: p?.title ?? pin.label,
        path: `/projects/${pin.id}`,
        icon: <FolderKanban className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />,
        active: pathname === `/projects/${pin.id}` || !!pathname?.startsWith(`/projects/${pin.id}/`),
        onSelect: () => onNavigate(`/projects/${pin.id}`),
      };
    }
    if (pin.kind === "channel") {
      // A pin taken while the channel was an optimistic stub holds the stub id;
      // the server row keeps it as client_id, which forwards to the real id.
      const id = supersededChannelId(chatChannels as any, pin.id) ?? pin.id;
      // The rail entry carries what the Chat sublist row would have shown —
      // name, mute state, unread counts — so the pin wears the same signals.
      const live = chatRail.find((r) => r.id === id);
      const c = (chatChannels as any)?.[id];
      const isDm = (live?.kind ?? c?.kind) === "dm";
      const counterpart = live && isDm ? dmCounterpart(live, teamMembers) : undefined;
      const dmName = isDm && !live
        ? channelDisplayName(
            { name: "", kind: "dm", dmMemberIds: dmOtherIds(c?.dm_key, viewer) },
            teamMembers,
          )
        : undefined;
      return {
        ...base,
        name: live
          ? channelDisplayName(live, teamMembers)
          : dmName ?? (c?.name || pin.label.replace(/^#/, "")),
        path: `/chat/${id}`,
        icon: live?.muted
          ? <BellOff className="w-3 h-3 flex-shrink-0 text-sol-text-dim" aria-label="Muted" />
          : counterpart
          ? <CommentAvatar
              name={memberName(counterpart)}
              image={counterpart.image || counterpart.github_avatar_url}
              size={14}
              letters={1}
            />
          : isDm
          ? <Users className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />
          : live?.isPrivate
          ? <Lock className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />
          : <Hash className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />,
        ...(live ? channelSignals(live, String(viewer), teamMembers) : {}),
        // The URL can hold either id — the stub from an old link, the real one
        // from a fresh navigation — and both mean this row.
        active: pathname === `/chat/${id}` || pathname === `/chat/${pin.id}`,
        onSelect: () => onNavigate(`/chat/${id}`),
        onContextMenu: (e: React.MouseEvent) =>
          channelMenu.open(e, { channelId: id, notifyLevel: live?.notifyLevel ?? "mentions" }),
      };
    }
    const rows: any[] = Array.isArray(savedViews) ? savedViews : Object.values(savedViews ?? {});
    const v = rows.find((r: any) => String(r?._id) === pin.id);
    return {
      ...base,
      name: v?.name ?? pin.label,
      icon: <Layers className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />,
      active: activeViewIds.includes(pin.id),
      // A view pin replays the SAME apply the section row runs — one codepath,
      // so a pinned view can never drift from its source row's behavior.
      onSelect: () => (v ? applyView(v) : undefined),
    };
  };

  return (
    <div className="mb-1">
      <RailHeading label="Pinned" isNarrow={false} />
      {visiblePins.map((pin) => {
        const row = resolve(pin);
        return <SectionRow key={row.id} row={row} className="mx-2 rounded" />;
      })}
      <ChannelContextMenu state={channelMenu} />
      <ContextMenu state={pinMenu}>
        {(p) => (
          <CtxItem icon={PinOff} onSelect={() => togglePin(p.kind, p.id, p.label)}>
            Unpin from top
          </CtxItem>
        )}
      </ContextMenu>
    </div>
  );
}

// The session fields the directory rail groups by; anything else on the row
// (heartbeats, streaming counters) doesn't wake the sidebar.
// updated_at is quantized to the minute: the raw stamp ticks on every heartbeat
// and streamed token of every live session, and each tick woke the whole
// Sidebar (measured 13 renders / 25s at idle). Recency order in this list only
// needs minute resolution.
const sidebarSessionSig = (r: any) => `${r.git_root ?? ""}|${r.project_path ?? ""}|${Math.floor((r.updated_at ?? 0) / 60_000)}`;
const byUpdatedDesc = (a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

export function Sidebar({ directoryFilter, isMobileOpen = false, onMobileClose, isNarrow = false, scope }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isInbox = pathname === "/conversation" || pathname?.startsWith("/conversation/") || pathname === "/inbox" || pathname?.startsWith("/inbox/");
  const isSessions = pathname?.startsWith("/sessions");
  const isOrg = pathname === "/org" || pathname?.startsWith("/org/");
  const isRootAgent = pathname === "/anchor";
  // The workspace's agent is its root role (org-staffing.md S22): the rail
  // shows it by its name and face, and the entry opens its page.
  const rootAgent = useRootAgent();
  const isWindows = pathname?.startsWith("/windows");
  const isTeamActivity = pathname === "/team/activity" || pathname?.startsWith("/team/activity");
  const isChat = pathname === "/chat" || pathname?.startsWith("/chat/");
  const isCalls = pathname === "/calls" || pathname?.startsWith("/calls/");
  // Per-team opt-in: no chat row (and no create-channel modal) unless the
  // active team turned chat on.
  // The org feature is per team, default off: with it off the Org row and
  // the workspace agent row do not exist, like chat.
  const orgOn = useWorkspaceFeature("org");
  const changesOn = useTeamFeature("changes");
  const chatOn = useTeamFeature("chat");
  const callsOn = useCallsAvailable();
  const isTasks = pathname === "/tasks" || pathname?.startsWith("/tasks/");
  const isInitiatives = pathname === "/initiatives" || pathname?.startsWith("/initiatives/");
  const isProjects = pathname === "/projects" || pathname?.startsWith("/projects/");
  const isPlans = pathname === "/plans" || pathname?.startsWith("/plans/");
  const isDocs = pathname === "/docs" || pathname?.startsWith("/docs/");
  const isVault = pathname === "/files" || pathname?.startsWith("/files/") ||
    pathname === "/vault" || pathname?.startsWith("/vault/"); // /vault = pre-rename alias
  const isPages = pathname === "/pages" || pathname?.startsWith("/pages/") ||
    pathname === "/artifacts" || pathname?.startsWith("/artifacts/"); // /artifacts = pre-rename alias
  // One Workflows entry, at /routines (the-line.md L10); /workflows is the older address of the same page.
  const isWorkflows = pathname === "/workflows" || pathname?.startsWith("/workflows/") ||
    pathname === "/routines" || pathname?.startsWith("/routines/");
  const isTriggers = pathname === "/triggers" || pathname?.startsWith("/triggers/") ||
    pathname === "/schedules" || pathname?.startsWith("/schedules/"); // /schedules = pre-rename alias
  const { user: currentUser } = useCurrentUser();
  // Only the create-task modal reads the roster here; don't wake the Sidebar
  // on roster churn while it is closed.
  const teamMembers = useInboxStore((s) => (s.createModal ? s.teamMembers : null));
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const teamsQuery = useSyncTeams();
  const teams = useInboxStore((s) => s.teams);
  const activeTeam = (teamsQuery ?? teams)?.find((t: any) => t?._id === activeTeamId);
  // A badge, not the surface: a server failure (e.g. the backend's syscall
  // budget under load) must degrade the count, never unmount the Sidebar.
  // The query feeds the store (below); the badge renders from the store.
  const { data: teamUnreadCountQuery } = useQueryNoThrow(
    api.conversations.getTeamUnreadCount,
    // isConvexId: a just-created team holds an optimistic stub id until the
    // server echoes, and a stub is not an Id<"teams">.
    activeTeamId && isConvexId(String(activeTeamId)) ? { teamId: activeTeamId } : "skip"
  );
  const teamUnreadCount = useInboxStore((s) => s.teamUnreadCount);
  const createModal = useInboxStore((s) => s.createModal);
  const createModalDefaults = useInboxStore((s) => s.createModalDefaults);
  const closeCreateModal = useInboxStore((s) => s.closeCreateModal);
  const openCompose = useInboxStore((s) => s.openCompose);
  const hasUsedDesktop = useInboxStore((s) => s.clientState.dismissed?.has_used_desktop ?? false);
  // The footer offers the native app for this device (lib/nativeApps); the Mac
  // offer stops once the user runs the desktop app, the iOS one when the phone
  // is the device you're already holding is the point, so it stays.
  const nativeApp = nativeAppOffer();
  const offerNativeApp = nativeApp !== null && !(nativeApp === "mac" && hasUsedDesktop);

  const favoritesQuery = useQueryNoThrow(api.conversations.listFavorites, {}).data;
  // Read bookmarks straight from the store (synced globally in useSyncInboxSessions)
  // so an optimistic add/remove shows here instantly, with no round-trip.
  const bookmarks = useInboxStore((s) => s.bookmarks);
  const [showAllBookmarks, setShowAllBookmarks] = useState(false);
  const convex = useConvex();
  const prefetchedBookmarksRef = useRef<Set<string>>(new Set());
  // Warm the Convex cache with the EXACT window + meta the conversation view
  // requests on click (getMessagesAroundTimestamp with the same 50/50 bounds,
  // plus the header meta), so opening a bookmark jumps to the message with no
  // load spinner. Fires on hover; deduped per bookmark.
  const prefetchBookmark = useCallback((bm: any) => {
    if (!bm?.message_timestamp || prefetchedBookmarksRef.current.has(bm._id)) return;
    prefetchedBookmarksRef.current.add(bm._id);
    convex
      .query(api.conversations.getMessagesAroundTimestamp, {
        conversation_id: bm.conversation_id,
        center_timestamp: bm.message_timestamp,
        limit_before: 50,
        limit_after: 50,
      })
      .catch(() => prefetchedBookmarksRef.current.delete(bm._id));
    convex.query(api.conversations.getConversationWithMeta, { conversation_id: bm.conversation_id }).catch(() => {});
  }, [convex]);
  // Precache the visible bookmarks up front (not just on hover) so the very
  // first click — or keyboard activation — opens straight to the message
  // window with no spinner. Deduped per bookmark, so list churn re-runs are free.
  useWatchEffect(() => {
    const visible = showAllBookmarks ? bookmarks : bookmarks.slice(0, 8);
    for (const bm of visible) prefetchBookmark(bm);
  }, [bookmarks, showAllBookmarks, prefetchBookmark]);
  const toggleBookmark = useInboxStore((s) => s.toggleBookmark);
  const openConversationId = useInboxStore((s) => s.currentSessionId);
  // Saved views live on the server now, so a shared one shows up here for every
  // member of the team — see convex/savedViews.ts.
  useSyncSavedViews();
  const savedViewRows = useInboxStore((s) => s.savedViews);
  const savedViews = useMemo(
    () => Object.values(savedViewRows ?? {})
      .filter((v: any) => inActiveWorkspace(v, activeTeamId))
      // Yours first, then teammates' shared ones; alphabetical within each, so
      // the rail is stable rather than reordering as people edit their views.
      .sort((a: any, b: any) =>
        Number(!!b.is_mine) - Number(!!a.is_mine) || (a.name || "").localeCompare(b.name || "")),
    [savedViewRows, activeTeamId]
  );
  const deleteSavedView = useInboxStore((s) => s.deleteSavedView);
  const updateSavedView = useInboxStore((s) => s.updateSavedView);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  // Saved views nest under their page's nav row instead of a separate section.
  const taskViews = useMemo(() => savedViews.filter((v: any) => v.page === "tasks"), [savedViews]);
  const docViews = useMemo(() => savedViews.filter((v: any) => v.page === "docs" || v.page === "plans"), [savedViews]);

  // Which view the list is currently arranged as — a view is a set of prefs, not
  // a route, so "selected" is a comparison against the live prefs (lib/savedViews).
  const taskPrefs = useInboxStore((s) => s.clientState.ui?.task_view);
  const docPrefs = useInboxStore((s) => s.clientState.ui?.doc_view);
  // The stamped view wins: it stays right while you edit filters, where
  // matching would go blank. Matching is the fallback for a list that simply
  // happens to be arranged like a view you never opened.
  const activeTaskViewId = useMemo(
    () => (isTasks
      ? currentViewId(taskPrefs) ?? activeViewId(taskViews.map((v: any) => ({ id: v._id, prefs: v.prefs })), taskPrefs)
      : undefined),
    [isTasks, taskViews, taskPrefs]
  );
  const activeDocViewId = useMemo(
    () => (isDocs
      ? currentViewId(docPrefs) ?? activeViewId(docViews.map((v: any) => ({ id: v._id, prefs: v.prefs })), docPrefs)
      : undefined),
    [isDocs, docViews, docPrefs]
  );
  // They reveal when you open that page (navigation is the default); the chevron
  // pins a section open or closed regardless of which page you're on. A pin is a
  // durable preference, not a gesture: it lives in the ui bag, so it survives
  // reload and is captured by a saved layout with the rest of the chrome.
  const viewSectionOverride = useInboxStore((s) => s.clientState.ui?.nav_sections) ?? NO_SECTION_PINS;
  const setViewSectionOverride = useCallback(
    (next: (cur: Record<string, boolean>) => Record<string, boolean>) => {
      const cur = useInboxStore.getState().clientState.ui?.nav_sections ?? NO_SECTION_PINS;
      updateClientUI({ nav_sections: next(cur) });
    },
    [updateClientUI],
  );
  const applyView = useCallback((view: any) => {
    const pagePrefsKey = view.page === "tasks" ? "task_view" : view.page === "docs" ? "doc_view" : "plan_view";
    // Stamp which view this is, so the page can still name it after you change
    // a filter — the moment matching alone stops being able to answer.
    updateClientUI({ [pagePrefsKey]: { ...(view.prefs ?? {}), [VIEW_ID_KEY]: view._id } });
    router.push(`/${view.page}`);
    onMobileClose?.();
  }, [updateClientUI, router, onMobileClose]);

  // "kind:id" keys of current pins — one subscription serves every section's
  // pin/unpin affordance and keeps the memos honest about pin state. Declared
  // before viewItems: its dep array reads `pinned` during render.
  const pinnedKeys = useInboxStore((s) => readPins(s).map((x) => `${x.kind}:${x.id}`).join(","));
  const pinned = useCallback((key: string) => pinnedKeys.split(",").includes(key), [pinnedKeys]);

  const viewItems = useCallback((views: any[], activeId?: string) => views.map((v: any) => ({
    id: v._id,
    name: v.name,
    active: v._id === activeId,
    icon: <Layers className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />,
    // A shared view is marked, and a teammate's says whose it is — otherwise a
    // rail of everyone's views is a list of names with no owners.
    trailing: v.shared ? (
      <span
        className="flex items-center flex-shrink-0 mr-0.5"
        title={v.is_mine ? "Shared with your team" : `Shared by ${v.owner_name ?? "a teammate"}`}
      >
        {v.is_mine || !v.owner_image ? (
          <Users className="w-3 h-3 text-sol-text-dim" />
        ) : (
          <AvatarImg
            src={v.owner_image}
            alt={v.owner_name ?? ""}
            className="w-3.5 h-3.5 rounded-full"
            fallback={<Users className="w-3 h-3 text-sol-text-dim" />}
          />
        )}
      </span>
    ) : undefined,
    // Only the author can share or delete: silently rewriting a view other
    // people rely on is what makes shared views untrustworthy.
    actions: [
      {
        key: "pin",
        title: pinned(`view:${v._id}`) ? "Unpin from top" : "Pin to top of sidebar",
        icon: pinned(`view:${v._id}`) ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />,
        onClick: () => togglePin("view", v._id, v.name || "View"),
      },
      ...(v.is_mine === false ? [] : [
      {
        key: "share",
        title: v.shared ? "Stop sharing with your team" : "Share with your team",
        icon: v.shared ? <UserMinus className="w-3 h-3" /> : <Users className="w-3 h-3" />,
        onClick: () => {
          if (!activeTeamId && !v.shared) {
            toast.error("Pick a team first", { description: "A shared view needs a team to share with." });
            return;
          }
          updateSavedView(v._id, { shared: !v.shared, team_id: v.team_id ?? activeTeamId });
          toast.success(v.shared ? `"${v.name}" is private again` : `"${v.name}" shared with your team`);
        },
      },
      {
        key: "remove",
        title: "Remove saved view",
        icon: (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ),
        onClick: () => deleteSavedView(v._id),
      },
    ]),
    ],
    onSelect: () => applyView(v),
  })), [applyView, deleteSavedView, updateSavedView, activeTeamId, pinned]);
  const taskViewItems = useMemo(() => viewItems(taskViews, activeTaskViewId), [viewItems, taskViews, activeTaskViewId]);
  const docViewItems = useMemo(() => viewItems(docViews, activeDocViewId), [viewItems, docViews, activeDocViewId]);

  // The projects themselves nest under the Projects row, so a project is one
  // click from anywhere — the whole point of putting it at the top of the rail.
  // Active work first, then alphabetical; finished projects sink but stay reachable.
  useSyncProjects();
  // store.projects is a cross-workspace cache (sync never prunes on team
  // switch); the hook is the one sanctioned reader that re-asserts the
  // active workspace.
  const wsProjects = useWorkspaceCollection<any>("projects");
  const projectItems = useMemo(() => {
    const order: Record<string, number> = { active: 0, planning: 1, paused: 2, done: 3 };
    return [...wsProjects]
      .sort((a: any, b: any) =>
        (order[a.status] ?? 9) - (order[b.status] ?? 9) || (a.title || "").localeCompare(b.title || ""))
      .map((p: any) => ({
        active: pathname === `/projects/${p._id}` || !!pathname?.startsWith(`/projects/${p._id}/`),
        id: p._id,
        name: p.title,
        icon: <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${projectDotClass(p)}`} />,
        actions: [
          {
            key: "pin",
            title: pinned(`project:${p._id}`) ? "Unpin from top" : "Pin to top of sidebar",
            icon: pinned(`project:${p._id}`) ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />,
            onClick: () => togglePin("project", p._id, p.title || "Project"),
          },
        ],
        onSelect: () => { router.push(`/projects/${p._id}`); onMobileClose?.(); },
      }));
    // pathname is a dep: without it the highlight is computed once and never
    // moves as you navigate between projects.
  }, [wsProjects, router, onMobileClose, pathname, pinned]);

  useConvexSync(teamUnreadCountQuery, useCallback((d: any) => useInboxStore.getState().syncTable("teamUnreadCount", d), []));
  useConvexSync(favoritesQuery, useCallback((d: any) => useInboxStore.getState().syncTable("favorites", d), []));
  // Local-first: the workspace/directory rail derives from the viewer's own
  // sessions already in the store (the inbox sync + persisted cache), not a
  // second listConversations subscription — which painted the rail silently
  // EMPTY for a beat on every cold boot. Wakes only on the fields the rail
  // groups by (path, recency); the 100 most recent, like the old query.
  const sidebarViewerId = useInboxStore((st) => (st.currentUser?._id ? String(st.currentUser._id) : ""));
  const sidebarOwnSessionWhere = useCallback(
    (row: any) => !!row?._id && String(row.user_id ?? "") === sidebarViewerId,
    [sidebarViewerId],
  );
  const ownSessions = useCollectionRows<any>("sessions", {
    where: sidebarOwnSessionWhere,
    sig: sidebarSessionSig,
    sort: byUpdatedDesc,
  });
  const conversations = useMemo(() => ownSessions.slice(0, 100), [ownSessions]);

  const handleDirectoryClick = (dir: string) => {
    const newDir = directoryFilter === dir ? null : dir;
    // Workspace filtering is personal-scoped: it matches your own sessions by the
    // path's leaf, so it only makes sense on the "my" feed (the team feed would send
    // a machine-local absolute path to the server and match nothing). Hence filter=my.
    const params = new URLSearchParams({ filter: "my" });
    if (newDir) params.set("dir", newDir);
    const target = `/team/activity?${params.toString()}`;
    // Already on the feed → replace (just retune the filter, no history entry);
    // otherwise push so we navigate to it. The feed reads these params from the URL.
    if (pathname?.startsWith("/team/activity")) {
      router.replace(target);
    } else {
      router.push(target);
    }
    onMobileClose?.();
  };

  type ConversationItem = NonNullable<typeof conversations>[number];

  const filteredConversations = useMemo(() =>
    conversations?.filter((c: ConversationItem) => shouldShowSession(c)) ?? [],
    [conversations]
  );

  const computedDirectories = useMemo(() => {
    const stripWorktreeSuffix = (p: string): string => {
      const patterns = [
        /\/\.conductor\/[^/]+$/,
        /\/\.codecast\/worktrees\/[^/]+$/,
      ];
      for (const re of patterns) {
        const stripped = p.replace(re, '');
        if (stripped !== p) return stripped;
      }
      return p;
    };

    const normalizeToRoot = (path: string): string | null => {
      const cleaned = stripWorktreeSuffix(path);
      if (/^\/(tmp|var|private\/tmp)\//.test(cleaned)) return null;
      const parts = cleaned.split('/');
      const srcIndex = parts.findIndex(p => p === 'src' || p === 'projects' || p === 'repos' || p === 'code');
      if (srcIndex >= 0 && srcIndex < parts.length - 1) {
        return parts.slice(0, srcIndex + 2).join('/');
      }
      return cleaned;
    };

    const deriveGitRoot = (c: ConversationItem): string | null => {
      const rawPath = c.git_root || c.project_path;
      if (!rawPath) return null;
      return normalizeToRoot(rawPath);
    };

    const dirStats = new Map<string, { updatedAt: number; count: number }>();
    for (const c of filteredConversations) {
      const dir = deriveGitRoot(c);
      if (dir) {
        const existing = dirStats.get(dir);
        if (existing) {
          existing.count++;
          if (c.updated_at > existing.updatedAt) existing.updatedAt = c.updated_at;
        } else {
          dirStats.set(dir, { updatedAt: c.updated_at, count: 1 });
        }
      }
    }
    const byName = new Map<string, { path: string; updatedAt: number; count: number }>();
    for (const [path, stats] of dirStats) {
      const name = path.split('/').filter(Boolean).pop() || path;
      const existing = byName.get(name);
      const preferSrc = path.includes('/src/') && (!existing || !existing.path.includes('/src/'));
      const existingIsSrc = existing?.path.includes('/src/') && !path.includes('/src/');
      if (!existing || preferSrc || (stats.updatedAt > (existing?.updatedAt ?? 0) && !existingIsSrc)) {
        byName.set(name, { path, updatedAt: Math.max(stats.updatedAt, existing?.updatedAt ?? 0), count: stats.count + (existing?.count ?? 0) });
      } else {
        byName.set(name, { ...existing!, updatedAt: Math.max(stats.updatedAt, existing.updatedAt), count: existing.count + stats.count });
      }
    }
    return Array.from(byName.values())
      .sort((a, b) => b.count - a.count || b.updatedAt - a.updatedAt)
      .map(v => v.path);
  }, [filteredConversations]);

  const sidebarContent = (
    <>
      <div className="flex-1 flex flex-col min-h-0">
        {!isNarrow && (
          <PinnedRail
            onNavigate={(href) => { router.push(href); onMobileClose?.(); }}
            applyView={applyView}
            activeViewIds={[activeTaskViewId, activeDocViewId]}
            scope={scope}
          />
        )}
        <SidebarNavView
          isNarrow={isNarrow}
          scope={scope}
          onMobileClose={onMobileClose}
          inbox={
            <InboxNavRow
              active={isInbox}
              isNarrow={isNarrow}
              badge={<NeedsInputCountBadge />}
              onClick={() => {
                useInboxStore.getState().setShowFavorites(false);
                if (isInbox) {
                  useInboxStore.getState().setShowMySessions(true);
                  useInboxStore.getState().clearSelection();
                }
                router.push("/inbox");
              }}
            />
          }
          threads={
            <ThreadsNavRow
              isActive={pathname === "/threads"}
              isNarrow={isNarrow}
              onMobileClose={onMobileClose}
            />
          }
          feed={activeTeam && <FeedNavRowView team={activeTeam} isActive={!!isTeamActivity} isNarrow={isNarrow} unread={teamUnreadCount} />}
          questions={
            <QuestionsNavRow
              isActive={pathname === "/questions"}
              isNarrow={isNarrow}
              onMobileClose={onMobileClose}
            />
          }
          chat={chatOn && <ChatNavRow
            isActive={!!isChat}
            isNarrow={isNarrow}
            pathname={pathname}
            pinsShown={!isNarrow && !scope}
            expanded={viewSectionOverride.chat ?? !!isChat}
            onToggle={() => setViewSectionOverride((v) => ({ ...v, chat: !(v.chat ?? !!isChat) }))}
            onMobileClose={onMobileClose}
          />}
          calls={callsOn && (<>
            <CallsNavRow
              isActive={!!isCalls}
              isNarrow={isNarrow}
              onMobileClose={onMobileClose}
            />
            {/* The huddles running right now, one row each — an occupied room
                is a door you can walk through from here. Renders nothing when
                none is live. */}
            <Suspense fallback={null}>
              <LiveNowRail isNarrow={isNarrow} onNavigate={onMobileClose} />
            </Suspense>
          </>)}
          workAction={<AppPopOutButton app="work" />}
          active={{
            initiatives: !!isInitiatives,
            projects: isProjects,
            tasks: isTasks,
            docs: isDocs || isPlans,
            code: pathname === "/repo" || /^\/(repo|commit|pr)\//.test(pathname || ""),
            files: isVault,
            pages: isPages,
            sessions: !!isSessions,
            workflows: isWorkflows,
            line: pathname === "/line",
            triggers: isTriggers,
            org: !!isOrg,
            changes: pathname === "/changes",
            rootAgent: isRootAgent,
            windows: !!isWindows,
          }}
          projects={{ items: projectItems, expanded: viewSectionOverride.projects ?? isProjects, onToggle: () => setViewSectionOverride((o) => ({ ...o, projects: !(o.projects ?? isProjects) })) }}
          tasks={{ items: taskViewItems, expanded: viewSectionOverride.tasks ?? isTasks, onToggle: () => setViewSectionOverride((o) => ({ ...o, tasks: !(o.tasks ?? isTasks) })) }}
          docs={{ items: docViewItems, expanded: viewSectionOverride.docs ?? (isDocs || isPlans), onToggle: () => setViewSectionOverride((o) => ({ ...o, docs: !(o.docs ?? (isDocs || isPlans)) })) }}
          orgOn={orgOn}
          changesOn={changesOn}
          agent={{
            label: rootAgent ? agentName(rootAgent) : "Workspace agent",
            title: rootAgent ? `${agentName(rootAgent)}, the workspace's agent` : "Set up the workspace's agent",
            icon: <AnchorAvatar anchor={rootAgent} size={20} className="flex-shrink-0" />,
          }}
        />

        {scope === "work" ? null : (<>

        {!isNarrow && bookmarks && bookmarks.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2 flex items-center">
              <span>Bookmarks</span>
              <span className="ml-auto inline-flex items-center justify-center min-w-[17px] h-[15px] px-1 rounded-full bg-sol-bg-highlight/70 text-[10px] tabular-nums text-sol-text-dim/50 normal-case font-normal">{bookmarks.length}</span>
            </div>
            <div className="space-y-1">
              {(showAllBookmarks ? bookmarks : bookmarks.slice(0, 8)).map((bm: any, i: number, arr: any[]) => {
                const isOpen = bm.conversation_id === openConversationId;
                // Adjacent bookmarks from the same conversation drop the repeated
                // conversation line — the row above already named it.
                const sameConvAsPrev = i > 0 && arr[i - 1].conversation_id === bm.conversation_id;
                const named = !!bm.name;
                const primary = bm.name || bm.message_preview || "";
                const convTitle = cleanTitle(bm.conversation_title || "New Session");
                const isUser = bm.message_role === "user";
                // Each workspace gets a stable hashed color so the eye can sort by project.
                const proj = bm.project_path ? getShortPath(bm.project_path) : "";
                const projColor = proj ? getLabelColor(proj) : null;
                return (
                  <div key={bm._id} className="group relative px-1.5" onMouseEnter={() => prefetchBookmark(bm)} onFocus={() => prefetchBookmark(bm)}>
                    <button
                      onClick={() => {
                        const store = useInboxStore.getState();
                        // Pair navigation + scroll target atomically so the inbox's
                        // pendingNavigateId watcher resolves them together (separate sets
                        // raced the cache-hit watcher, pinning scroll to the previous conv).
                        store.requestNavigate(bm.conversation_id, { scrollToMessageId: bm.message_id, scrollToMessageTimestamp: bm.message_timestamp });
                        const activeTab = store.tabs.find((t: any) => t.id === store.activeTabId);
                        if (activeTab) store.updateTab(activeTab.id, { path: "/inbox" });
                        if (!store.tabs.length) router.push("/inbox");
                        onMobileClose?.();
                      }}
                      title={primary || convTitle}
                      aria-label={`Open bookmark ${named ? `"${bm.name}"` : "message"} in ${convTitle}`}
                      className={`flex items-stretch gap-2.5 w-full pl-2 pr-2.5 py-1.5 rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sol-cyan/60 ${
                        isOpen ? "bg-sol-cyan/10" : "hover:bg-sol-bg-highlight/50"
                      }`}
                    >
                      {/* A saved excerpt, so a quote-bar spine: role-colored, cyan while its conversation is open.
                          Held at a visible base opacity so it anchors each row, not just on hover. */}
                      <span
                        aria-hidden
                        className={`flex-shrink-0 w-[3px] self-stretch rounded-full transition-colors ${
                          isOpen ? "bg-sol-cyan/80" : isUser ? "bg-sol-blue/45 group-hover:bg-sol-blue/80" : "bg-sol-violet/45 group-hover:bg-sol-violet/80"
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          {/* Headline: full-contrast and weighted up for deliberately-named bookmarks so
                              curated entries out-rank auto-captured previews at a glance. */}
                          <span className={`min-w-0 flex-1 truncate text-[13px] leading-snug text-sol-text-muted group-hover:text-sol-text-secondary transition-colors ${named ? "font-semibold" : "font-normal"}`}>
                            {named && (
                              <svg aria-hidden viewBox="0 0 24 24" className="inline-block w-2.5 h-2.5 mr-1 -mt-px align-middle text-sol-yellow/90" fill="currentColor">
                                <path d="M6 3a2 2 0 0 0-2 2v15.5a.5.5 0 0 0 .79.407L12 16l7.21 4.907A.5.5 0 0 0 20 20.5V5a2 2 0 0 0-2-2H6z" />
                              </svg>
                            )}
                            {primary || <span className="italic font-normal text-sol-text-dim/60">No preview</span>}
                          </span>
                          <span
                            className="flex-shrink-0 text-[9.5px] tabular-nums text-[color-mix(in_srgb,var(--sol-text-dim)_28%,transparent)] group-hover:text-sol-text-dim transition-colors"
                            title={new Date(bm.created_at).toLocaleString()}
                          >
                            {visitTimeAgo(bm.created_at)}
                          </span>
                        </span>
                        {!sameConvAsPrev && (
                          // Source line: deliberately recessed (dimmest text) so it reads as context, not a
                          // second headline; the project dot carries the only color so the eye groups by project.
                          <span className="flex items-center gap-1.5 mt-[3px] min-w-0">
                            {projColor && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 opacity-75 ${projColor.dot}`} title={proj} />}
                            <span className="min-w-0 truncate text-[10px] text-[color-mix(in_srgb,var(--sol-text-dim)_38%,transparent)] leading-tight group-hover:text-sol-text-dim transition-colors">
                              {convTitle}
                            </span>
                          </span>
                        )}
                      </span>
                    </button>
                    {/* Remove floats over the timestamp on hover so the row never reflows. */}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleBookmark(bm.conversation_id, bm.message_id); }}
                      className="absolute right-3 top-1.5 p-0.5 rounded opacity-0 group-hover:opacity-100 bg-sol-bg-highlight text-sol-text-dim hover:text-sol-red transition-opacity"
                      title="Remove bookmark"
                      aria-label="Remove bookmark"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}
              {bookmarks.length > 8 && (
                <button
                  onClick={() => setShowAllBookmarks(v => !v)}
                  className="w-full mt-1 px-4 py-1 flex items-center gap-1 text-[10.5px] text-sol-text-dim/70 hover:text-sol-text transition-colors"
                >
                  <svg className={`w-2.5 h-2.5 transition-transform ${showAllBookmarks ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                  {showAllBookmarks ? "Show fewer" : `${bookmarks.length - 8} more`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Saved layouts (store/workbench.ts): name the current arrangement,
            switch to it, update it in place. Lives down here with the other
            environment-level sections — it configures the frame, not the work. */}
        <WorkbenchSection isNarrow={isNarrow} onMobileClose={onMobileClose} />

        {!isNarrow && computedDirectories.length > 0 && (
          <div data-rail-group="workspaces" className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2 flex items-center justify-between">
              <span>Workspaces</span>
              <button
                onClick={() => openCompose()}
                className="text-sol-text-dim hover:text-sol-yellow transition-colors"
                title="New session"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </div>
            <div className="space-y-0.5">
              {computedDirectories.slice(0, 8).map((dir) => (
                <button
                  key={dir}
                  onClick={() => handleDirectoryClick(dir)}
                  className={`w-full flex items-center gap-2 px-4 py-1.5 transition-colors motion-reduce:transition-none text-left text-sm ${
                    directoryFilter === dir
                      ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                      : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
                  }`}
                  title={dir}
                >
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="truncate">{getShortPath(dir)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        </>)}
      </div>
    </>
  );

  return (
    <nav
      data-sv-nav
      className={`
        h-full w-full pb-3 sm:pb-4 flex flex-col bg-sol-bg-alt select-none
        ${isMobileOpen ? 'shadow-xl' : 'hidden md:flex'}
      `}
    >
      <div data-sidebar-scroll className="flex-1 overflow-y-auto scrollbar-auto pt-3 sm:pt-4">
        {sidebarContent}
      </div>
      {offerNativeApp && nativeApp && !isNarrow && (
        <a
          href={NATIVE_APP_LINKS[nativeApp]}
          target={nativeApp === "ios" ? "_blank" : undefined}
          rel={nativeApp === "ios" ? "noopener noreferrer" : undefined}
          onClick={() => trackNativeAppClick(nativeApp, "sidebar")}
          className="flex items-center gap-2 px-3 py-2 mt-2 text-sm text-sol-text-dim hover:text-sol-cyan transition-colors border-t border-sol-border/30 pt-3"
        >
          {nativeApp === "mac" ? <Monitor className="w-4 h-4 flex-shrink-0" /> : <Smartphone className="w-4 h-4 flex-shrink-0" />}
          <span>{NATIVE_APP_COPY[nativeApp].cta}</span>
        </a>
      )}
      <Suspense fallback={null}>
        {createModal === "task" && (
          <CreateTaskModal onClose={() => closeCreateModal()} teamMembers={teamMembers ?? []} currentUser={currentUser} defaults={createModalDefaults} />
        )}
        {createModal === "plan" && (
          <CreateDocModal onClose={() => closeCreateModal()} initialType="plan" />
        )}
        {createModal === "chat" && chatOn && (
          <CreateChannelModal
            onClose={() => closeCreateModal()}
            // The stub id is what the rail already shows; the tab path follows the
            // supersede when the server row lands (rekeyId).
            onCreated={(channelId) => router.push(`/chat/${channelId}`)}
          />
        )}
        {/* "New huddle" is the new-message field with a huddle intent: the
            same people/rooms search, ending in a ring instead of a room. */}
        {createModal === "huddle" && callsOn && (
          <NewMessageModal intent="huddle" onClose={() => closeCreateModal()} />
        )}
      </Suspense>
    </nav>
  );
}
