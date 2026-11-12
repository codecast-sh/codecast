import { usePathname } from "next/navigation";
import { MessagesSquare, FolderKanban, Layers, Users, Hash, PinOff, BellOff, Lock } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useTeamFeature } from "../../lib/teamFeatures";
import { useChatRail, useChatMembers, supersededChannelId } from "../../hooks/useChatSync";
import { useThreadUnread } from "../../hooks/useThreadsSync";
import { ChannelContextMenu } from "../chat/ChannelMenu";
import { useChannelMenu } from "../../hooks/useChannelMenu";
import { channelDisplayName, dmCounterpart, memberName } from "../../lib/chatViews";
import { dmOtherIds } from "@codecast/shared/chat";
import { CommentAvatar } from "../comments/CommentAvatar";
import { readPins, isThreadsPin, pinApp, togglePin, type SidebarPin } from "../../lib/sidebarPins";
import { ContextMenu, CtxItem, useContextMenu } from "../ui/context-menu";
import type { DesktopApp } from "../../lib/desktopApps";
import { RailHeading, SectionRow, NavCount, type SectionRowSpec } from "./navPrimitives";
import { channelSignals } from "../../lib/chatRowSignals";

/** True when the pathname is this project's board. The board's address is the
 *  project's pj- ref; an older link or pin may still carry its Convex id. */
function isOnProjectBoard(pathname: string | null | undefined, p: { short_id?: string; _id?: string }): boolean {
  return [p.short_id, p._id].some((ref) => !!ref && (pathname === `/projects/${ref}` || !!pathname?.startsWith(`/projects/${ref}/`)));
}

/** The fields the pinned rail draws from each pinned row: a project's title
 *  and ref, a channel's id, kind, DM key and name, a view's name. A handful of
 *  pins, so a short string; empty with no pins. */
function pinnedRowsSig(s: any): string {
  let sig = "";
  for (const p of readPins(s)) {
    if (p.kind === "project") {
      const r = s.projects?.[p.id];
      sig += `p\u0001${r?.title ?? ""}\u0001${r?.short_id ?? ""}\u0002`;
    } else if (p.kind === "channel") {
      const id = supersededChannelId(s.chatChannels ?? {}, p.id) ?? p.id;
      const c = s.chatChannels?.[id];
      sig += `c\u0001${id}\u0001${c?.kind ?? ""}\u0001${c?.dm_key ?? ""}\u0001${c?.name ?? ""}\u0002`;
    } else {
      const views = s.savedViews;
      const v = (Array.isArray(views) ? undefined : views?.[p.id]) ?? Object.values(views ?? {}).find((r: any) => String(r?._id) === p.id) as any;
      sig += `v\u0001${v?.name ?? ""}\u0002`;
    }
  }
  return sig;
}

// The rail of pinned subsection rows — projects, saved views, channels —
// resolved LIVE from the store so renames follow, with the pin-time label as
// the fallback for objects the cache no longer holds.
export function PinnedRail({
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
  // This rail is always mounted: it wakes on the fields its pinned rows draw,
  // never on the whole projects, views and channels maps (a chat unread tick
  // or a project sync re-rendered it, pins or none). The rows themselves are
  // read below from the state this signature woke on.
  useInboxStore((s) => pinnedRowsSig(s));
  const { projects, savedViews, chatChannels } = useInboxStore.getState() as any;
  const viewRows: any[] = Array.isArray(savedViews) ? savedViews : Object.values(savedViews ?? {});
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
          threadsUnread > 0 ? <NavCount n={threadsUnread} tone="bg-sol-red text-white" small /> : null,
        active: pathname === "/threads",
        onSelect: () => onNavigate("/threads"),
      };
    }
    if (pin.kind === "project") {
      const p = (projects as any)?.[pin.id];
      const path = `/projects/${p?.short_id ?? pin.id}`;
      return {
        ...base,
        name: p?.title ?? pin.label,
        path,
        icon: <FolderKanban className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />,
        active: isOnProjectBoard(pathname, p ?? { _id: pin.id }),
        onSelect: () => onNavigate(path),
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
    const v = viewRows.find((r: any) => String(r?._id) === pin.id);
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
