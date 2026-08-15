import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useMemo, useCallback, useRef, memo } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useQuery, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { cleanTitle } from "../lib/conversationProcessor";
import { track } from "../lib/analytics";
import { visitTimeAgo } from "../lib/recentVisits";
import { getLabelColor } from "../lib/labelColors";
import { shouldShowSession } from "../lib/sessionFilters";
import { useInboxStore } from "../store/inboxStore";
import { useNeedsInputCount } from "../hooks/useNeedsInputCount";
import { useDecisionQueue } from "../hooks/useDecisionQueue";
import { useChatUnread, useChatRail } from "../hooks/useChatSync";
import { ChannelContextMenu, useChannelMenu } from "./chat/ChannelMenu";
import { readPins, isPinned, togglePin, type SidebarPin } from "../lib/sidebarPins";
import { useConvexSync } from "../hooks/useConvexSync";
import { useSyncProjects } from "../hooks/useSyncProjects";
import { useSyncSavedViews } from "../hooks/useSyncSavedViews";
import { activeViewId, currentViewId, VIEW_ID_KEY } from "../lib/savedViews";
import { projectDotClass } from "../lib/projectColors";
import { useWorkspaceArgs, workspaceStamp } from "../hooks/useWorkspaceArgs";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { TeamIcon } from "./TeamIcon";
import { isDesktop } from "../lib/desktop";
import { toast } from "sonner";
import { CreateTaskModal } from "./CreateTaskModal";
import { CreateDocModal } from "./CreateDocModal";
import { CreateChannelModal } from "./CreateChannelModal";
import { Globe, Workflow, Zap, MessageSquare, FolderKanban, Layers, Users, UserMinus, Hash, MoreHorizontal, Pin, PinOff, BellOff, Blocks } from "lucide-react";
import { WorkbenchSection } from "./WorkbenchSection";
import { filterToWorkspace, inActiveWorkspace } from "../lib/workspaceScope";

const api = _api as any;

interface SidebarProps {
  // The active workspace filter, derived from the activity-feed tab's `?dir=` by
  // DashboardLayout (the feed lives at /team/activity). Drives the "Workspaces"
  // highlight; clicking a workspace navigates there with the param toggled.
  directoryFilter?: string | null;
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
  isNarrow?: boolean;
}

/** A group label in the rail. Hidden when the rail is narrow, where the icons
 *  stand on their own and a heading would just be a stripe of unreadable text. */
function RailHeading({ label, isNarrow }: { label: string; isNarrow: boolean }) {
  if (isNarrow) return null;
  return (
    <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2 mt-4 first:mt-0">
      {label}
    </div>
  );
}

function getShortPath(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  if (parts.length === 0) return projectPath;
  return parts[parts.length - 1];
}

function NavSection({
  label,
  href,
  isActive,
  isNarrow,
  icon,
  title,
  simpleHide,
  onMobileClose,
  onAdd,
  addTitle,
  badge,
  unread,
  items,
  expanded,
  onToggle,
}: {
  label: string;
  href: string;
  isActive: boolean;
  isNarrow: boolean;
  icon: React.ReactNode;
  title?: string;
  simpleHide?: boolean;
  /** Rendered beside the label in the wide rail — an unread count or dot. */
  badge?: React.ReactNode;
  /** Unread carried by WEIGHT, the same rule the channel rail follows: colour is
   *  already busy marking the active row, so using it for both makes neither
   *  legible. */
  unread?: boolean;
  onMobileClose?: () => void;
  onAdd?: () => void;
  addTitle?: string;
  /** Rows nested under this one — the projects under Projects, the saved views
   *  under Tasks and Docs. One list shape for both: what it's called, what
   *  opening it does, and (for a saved view) how to forget it. */
  items?: Array<{
    id: string;
    name: string;
    icon?: React.ReactNode;
    /** Highlighted as the row you are currently looking at. */
    active?: boolean;
    /** Rendered at the row's end — a shared marker, an owner avatar. */
    trailing?: React.ReactNode;
    /** Hover actions, in order. Each is its own small button. */
    actions?: Array<{ key: string; title: string; icon: React.ReactNode; onClick: (e?: React.MouseEvent) => void }>;
    onSelect: () => void;
    /** Right-click, for rows that have a context menu. */
    onContextMenu?: (e: React.MouseEvent) => void;
  }>;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  // Only the wide rail nests children; the narrow rail stays icon-only.
  const hasChildren = !isNarrow && !!items && items.length > 0;
  return (
    <div data-simple-hide={simpleHide ? "" : undefined}>
      <div className={`flex items-center border-l-2 transition-colors motion-reduce:transition-none ${
        isActive
          ? "bg-sol-bg-highlight text-sol-text border-sol-cyan"
          : "text-sol-text-muted border-transparent hover:text-sol-text hover:bg-sol-bg-highlight/60"
      }`}>
        <Link
          href={href}
          onClick={onMobileClose}
          data-nav-row
          className={`flex-1 flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 min-w-0`}
          title={title ?? label}
        >
          {icon}
          {!isNarrow && <span className={unread && !isActive ? "font-semibold text-sol-text" : undefined}>{label}</span>}
          {!isNarrow && badge}
        </Link>
        {hasChildren && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle?.(); }}
            className="p-1 text-sol-text-dim hover:text-sol-text transition-colors"
            title={expanded ? `Collapse ${label.toLowerCase()}` : `Expand ${label.toLowerCase()}`}
            aria-expanded={expanded}
          >
            <svg className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
        {!isNarrow && onAdd && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onAdd(); }}
            className="p-1 mr-2 opacity-60 hover:opacity-100 text-sol-text-dim hover:text-sol-text transition-all"
            title={addTitle ?? `New ${label.toLowerCase().replace(/s$/, '')}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" d="M12 5v14m-7-7h14" />
            </svg>
          </button>
        )}
      </div>
      {/* Nested rows — a slide-open list aligned under this row's icon. */}
      {hasChildren && (
        <div className={`overflow-hidden transition-all duration-200 ease-out ${expanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="ml-[17px] my-0.5 border-l border-sol-border/50 overflow-y-auto max-h-96">
            {items!.map((child) => (
              <div
                key={child.id}
                onContextMenu={child.onContextMenu}
                className={`flex items-center group/v transition-colors ${
                  child.active
                    ? "bg-sol-bg-highlight text-sol-text"
                    : "text-sol-text-muted hover:bg-sol-bg-highlight/40"
                }`}
              >
                <button
                  onClick={child.onSelect}
                  className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 hover:text-sol-text transition-colors flex-1 min-w-0 text-left"
                  title={child.name}
                  aria-current={child.active ? "page" : undefined}
                >
                  {child.icon}
                  <span className={`truncate text-[13px] min-w-0 ${child.active ? "text-sol-text" : ""}`}>{child.name}</span>
                </button>
                {/* Marker and actions trade places on hover rather than
                    competing for the row's width — otherwise the name of the
                    row you are pointing at is the first thing to truncate. */}
                {child.trailing && (
                  <span className={child.actions?.length ? "flex group-hover/v:hidden" : "flex"}>
                    {child.trailing}
                  </span>
                )}
                {!!child.actions?.length && (
                  <span className="hidden group-hover/v:flex items-center flex-shrink-0">
                    {child.actions.map((action) => (
                      <button
                        key={action.key}
                        onClick={(e) => { e.stopPropagation(); action.onClick(e); }}
                        className="p-1 rounded text-sol-text-dim hover:text-sol-text flex-shrink-0"
                        title={action.title}
                      >
                        {action.icon}
                      </button>
                    ))}
                  </span>
                )}
                <span className="w-1.5 flex-shrink-0" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// The "needs input" count is the only thing in the Sidebar that depends on the
// whole sessions map, which gets a fresh identity on every ~1s heartbeat.
// Isolating it here means a heartbeat re-renders just this 20px badge instead of
// the entire Sidebar (favorites, bookmarks, recents). Mirrors ActiveAgentsBadge
// in DashboardLayout. Only mounted in the non-narrow rail, so no work when narrow.
const NeedsInputCountBadge = memo(function NeedsInputCountBadge() {
  const needsInputCount = useNeedsInputCount();
  if (needsInputCount === 0) return null;
  return (
    <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-[11px] font-bold bg-teal-600 text-white rounded-full">
      {needsInputCount}
    </span>
  );
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
  const pending = useDecisionQueue().length;
  if (pending === 0) return null;
  return (
    <Link
      href="/questions"
      onClick={onMobileClose}
      className={`w-full flex items-center ${isNarrow ? "justify-center" : "gap-3"} px-4 py-2.5 border-l-2 transition-colors motion-reduce:transition-none text-left ${
        isActive
          ? "bg-sol-bg-highlight text-sol-text border-sol-violet"
          : "text-sol-text-muted border-transparent hover:text-sol-text hover:bg-sol-bg-highlight/60"
      }`}
      title="Decisions waiting on you"
    >
      <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {!isNarrow && (
        <>
          <span>Questions</span>
          <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-[11px] font-bold bg-sol-violet text-white rounded-full">
            {pending}
          </span>
        </>
      )}
    </Link>
  );
});

// Chat's sidebar row. Isolated for the same reason NeedsInputCountBadge is: the
// unread numbers move whenever anyone on the team says anything, and that must
// re-render one row rather than the whole rail.
//
// The rule the rail already follows, applied one level up: unread is WEIGHT plus
// a dot, and only a mention gets a number. A count of ordinary chatter teaches
// people to ignore counts, and then the one that matters is invisible inside it.
const ChatNavRow = memo(function ChatNavRow({
  isActive,
  isNarrow,
  pathname,
  expanded,
  onToggle,
  onMobileClose,
}: {
  isActive: boolean;
  isNarrow: boolean;
  pathname: string | null;
  expanded: boolean;
  onToggle: () => void;
  onMobileClose?: () => void;
}) {
  const { channels, mentions } = useChatUnread();
  const rail = useChatRail();
  const router = useRouter();
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  const activeWorkspaceTeam = useInboxStore((s) => s.clientState.ui?.active_team_id);
  // The app's one context-menu system: one instance for the whole list, rows
  // open it from the ⋯ button and from right-click alike.
  const channelMenu = useChannelMenu();

  const items = rail.map((c) => ({
    id: c.id,
    name: c.name,
    icon: c.muted
      ? <BellOff className="w-3 h-3 flex-shrink-0 opacity-50" aria-label="Muted" />
      : <Hash className="w-3 h-3 flex-shrink-0 opacity-60" />,
    active: pathname === `/chat/${c.id}`,
    // The rail's own signal rules, unchanged: only a mention gets a number;
    // plain unread is a dot; a muted channel keeps only the dot.
    trailing:
      (c.mentionCount ?? 0) > 0 ? (
        <span className="min-w-[16px] h-[15px] px-1 flex items-center justify-center text-[9.5px] font-bold bg-sol-orange text-sol-bg rounded-full flex-shrink-0">
          {(c.mentionCount ?? 0) > 99 ? "99+" : c.mentionCount}
        </span>
      ) : (c.unreadCount ?? 0) > 0 ? (
        <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan flex-shrink-0" aria-label="Unread" />
      ) : null,
    actions: [
      {
        key: "pin",
        title: "Pin to top of sidebar",
        icon: <Pin className="w-3 h-3" />,
        onClick: () => togglePin("channel", c.id, c.name),
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
  }));

  return (
    <>
      <NavSection
        label="Chat"
        href="/chat"
        isActive={isActive}
        isNarrow={isNarrow}
        onMobileClose={onMobileClose}
        unread={channels > 0 || mentions > 0}
        badge={
          mentions > 0 ? (
            <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-[11px] font-bold bg-sol-orange text-sol-bg rounded-full">
              {mentions > 99 ? "99+" : mentions}
            </span>
          ) : channels > 0 && !isActive ? (
            <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan" aria-label="Unread messages" />
          ) : null
        }
        icon={<MessageSquare className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
        items={items}
        expanded={expanded}
        onToggle={onToggle}
        onAdd={activeWorkspaceTeam ? () => openCreateModal("chat") : undefined}
        addTitle="New channel"
      />
      <ChannelContextMenu state={channelMenu} />
    </>
  );
});

// The rail of pinned subsection rows — projects, saved views, channels —
// resolved LIVE from the store so renames follow, with the pin-time label as
// the fallback for objects the cache no longer holds.
function PinnedRail({
  onNavigate,
  applyView,
}: {
  onNavigate: (href: string) => void;
  applyView: (view: any) => void;
}) {
  const pins = useInboxStore((s) => readPins(s));
  const projects = useInboxStore((s) => s.projects);
  // "kind:id" keys of current pins — one subscription serves every section's
  // pin/unpin affordance and keeps the memos honest about pin state.
  const pinnedKeys = useInboxStore((s) => readPins(s).map((x) => `${x.kind}:${x.id}`).join(","));
  const pinned = useCallback((key: string) => pinnedKeys.split(",").includes(key), [pinnedKeys]);
  const savedViews = useInboxStore((s) => (s as any).savedViews);
  const chatChannels = useInboxStore((s) => s.chatChannels);
  if (pins.length === 0) return null;

  const resolve = (pin: SidebarPin): { label: string; icon: React.ReactNode; go: () => void } => {
    if (pin.kind === "project") {
      const p = (projects as any)?.[pin.id];
      return {
        label: p?.title ?? pin.label,
        icon: <FolderKanban className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />,
        go: () => onNavigate(`/projects/${pin.id}`),
      };
    }
    if (pin.kind === "channel") {
      const c = (chatChannels as any)?.[pin.id];
      return {
        label: `#${c?.name ?? pin.label}`,
        icon: <Hash className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />,
        go: () => onNavigate(`/chat/${pin.id}`),
      };
    }
    const rows: any[] = Array.isArray(savedViews) ? savedViews : Object.values(savedViews ?? {});
    const v = rows.find((r: any) => String(r?._id) === pin.id);
    return {
      label: v?.name ?? pin.label,
      icon: <Layers className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />,
      // A view pin replays the SAME apply the section row runs — one codepath,
      // so a pinned view can never drift from its source row's behavior.
      go: () => (v ? applyView(v) : undefined),
    };
  };

  return (
    <div className="mb-1">
      <RailHeading label="Pinned" isNarrow={false} />
      {pins.map((pin) => {
        const r = resolve(pin);
        return (
          <div
            key={`${pin.kind}:${pin.id}`}
            className="flex items-center group/v transition-colors text-sol-text-muted hover:bg-sol-bg-highlight/40 mx-2 rounded"
          >
            <button
              onClick={r.go}
              className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 hover:text-sol-text transition-colors flex-1 min-w-0 text-left"
              title={r.label}
            >
              {r.icon}
              <span className="truncate text-[13px] min-w-0">{r.label}</span>
            </button>
            <button
              onClick={() => togglePin(pin.kind, pin.id, pin.label)}
              className="p-1 rounded text-sol-text-dim hover:text-sol-text opacity-0 group-hover/v:opacity-100 transition-opacity flex-shrink-0"
              title="Unpin"
            >
              <PinOff className="w-3 h-3" />
            </button>
            <span className="w-1.5 flex-shrink-0" />
          </div>
        );
      })}
    </div>
  );
}

export function Sidebar({ directoryFilter, isMobileOpen = false, onMobileClose, isNarrow = false }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isInbox = pathname === "/conversation" || pathname?.startsWith("/conversation/") || pathname === "/inbox" || pathname?.startsWith("/inbox/");
  const isSessions = pathname?.startsWith("/sessions");
  const isAnchor = pathname?.startsWith("/anchor");
  const isWindows = pathname?.startsWith("/windows");
  const isTeamActivity = pathname === "/team/activity" || pathname?.startsWith("/team/activity");
  const isChat = pathname === "/chat" || pathname?.startsWith("/chat/");
  const isTasks = pathname === "/tasks" || pathname?.startsWith("/tasks/");
  const isProjects = pathname === "/projects" || pathname?.startsWith("/projects/");
  const isPlans = pathname === "/plans" || pathname?.startsWith("/plans/");
  const isDocs = pathname === "/docs" || pathname?.startsWith("/docs/");
  const isCapabilities = pathname === "/capabilities";
  const isVault = pathname === "/files" || pathname?.startsWith("/files/") ||
    pathname === "/vault" || pathname?.startsWith("/vault/"); // /vault = pre-rename alias
  const isPages = pathname === "/pages" || pathname?.startsWith("/pages/") ||
    pathname === "/artifacts" || pathname?.startsWith("/artifacts/"); // /artifacts = pre-rename alias
  const isWorkflows = pathname === "/workflows" || pathname?.startsWith("/workflows/");
  const isTriggers = pathname === "/triggers" || pathname?.startsWith("/triggers/") ||
    pathname === "/schedules" || pathname?.startsWith("/schedules/"); // /schedules = pre-rename alias
  const { user: currentUser } = useCurrentUser();
  const teamMembers = useInboxStore((s) => s.teamMembers);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const teamsQuery = useQuery(api.teams.getUserTeams);
  const teams = useInboxStore((s) => s.teams);
  const activeTeam = (teamsQuery ?? teams)?.find((t: any) => t?._id === activeTeamId);
  const teamUnreadCountQuery = useQuery(
    api.conversations.getTeamUnreadCount,
    activeTeamId ? { teamId: activeTeamId } : "skip"
  );
  const teamUnreadCount = teamUnreadCountQuery ?? useInboxStore.getState().teamUnreadCount;
  const createDoc = useInboxStore((s) => s.createDoc);
  const wsStamp = workspaceStamp(useWorkspaceArgs());
  const createModal = useInboxStore((s) => s.createModal);
  const createModalDefaults = useInboxStore((s) => s.createModalDefaults);
  const closeCreateModal = useInboxStore((s) => s.closeCreateModal);
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  const openCompose = useInboxStore((s) => s.openCompose);
  const hasUsedDesktop = useInboxStore((s) => s.clientState.dismissed?.has_used_desktop ?? false);

  const favoritesQuery = useQuery(api.conversations.listFavorites);
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
  // pins a section open or closed regardless of which page you're on.
  const [viewSectionOverride, setViewSectionOverride] = useState<Record<string, boolean>>({});
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
          <img src={v.owner_image} alt={v.owner_name ?? ""} className="w-3.5 h-3.5 rounded-full" />
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
            toast.error("Pick a team first — a shared view needs a team to share with");
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
  const projects = useInboxStore((s) => s.projects);
  const projectItems = useMemo(() => {
    const order: Record<string, number> = { active: 0, planning: 1, paused: 2, done: 3 };
    // store.projects is a cross-workspace cache (sync never prunes on team
    // switch) — re-assert the active workspace here like every other list view.
    return filterToWorkspace(Object.values(projects), activeTeamId)
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
  }, [projects, activeTeamId, router, onMobileClose, pathname, pinned]);

  useConvexSync(teamsQuery, useCallback((d: any) => useInboxStore.getState().syncTable("teams", d), []));
  useConvexSync(teamUnreadCountQuery, useCallback((d: any) => useInboxStore.getState().syncTable("teamUnreadCount", d), []));
  useConvexSync(favoritesQuery, useCallback((d: any) => useInboxStore.getState().syncTable("favorites", d), []));
  const { conversations } =
    useQuery(api.conversations.listConversations, {
      filter: "my",
      limit: 100,
      include_message_previews: false,
    }) ?? { conversations: [] };

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
        {/* Workbenches first: switching the whole arrangement is the rail's
            fastest gesture, so it sits at the top (see store/workbench.ts). */}
        <WorkbenchSection isNarrow={isNarrow} onMobileClose={onMobileClose} />
        {!isNarrow && (
          <PinnedRail
            onNavigate={(href) => { router.push(href); onMobileClose?.(); }}
            applyView={applyView}
          />
        )}
        <RailHeading label="Conversations" isNarrow={isNarrow} />
        <div className="text-sm">
          <button
            onClick={() => {
              useInboxStore.getState().setShowFavorites(false);
              if (isInbox) {
                useInboxStore.getState().setShowMySessions(true);
                useInboxStore.getState().clearSelection();
              }
              router.push("/inbox");
            }}
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 border-l-2 transition-colors motion-reduce:transition-none text-left ${
              isInbox
                ? "bg-sol-bg-highlight text-sol-text border-sol-cyan"
                : "text-sol-text-muted border-transparent hover:text-sol-text hover:bg-sol-bg-highlight/60"
            }`}
            title="Inbox"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
            {!isNarrow && (
              <>
                <span>Inbox</span>
                <NeedsInputCountBadge />
              </>
            )}
          </button>
          {activeTeam && (
            <Link
              href="/team/activity"
              className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 border-l-2 transition-colors motion-reduce:transition-none text-left ${
                isTeamActivity
                  ? "bg-sol-bg-highlight text-sol-text border-sol-cyan"
                  : "text-sol-text-muted border-transparent hover:text-sol-text hover:bg-sol-bg-highlight/60"
              }`}
              title={activeTeam.name}
            >
              <TeamIcon icon={activeTeam.icon} color={activeTeam.icon_color} className="w-5 h-5 flex-shrink-0" />
              {!isNarrow && (
                <>
                  <span>Feed</span>
                  {teamUnreadCount !== undefined && teamUnreadCount > 0 && !isTeamActivity && (
                    <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-xs font-semibold bg-sol-cyan text-sol-bg rounded-full">
                      {teamUnreadCount}
                    </span>
                  )}
                </>
              )}
            </Link>
          )}
          <QuestionsNavRow
            isActive={pathname === "/questions"}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
          />
          <ChatNavRow
            isActive={!!isChat}
            isNarrow={isNarrow}
            pathname={pathname}
            expanded={viewSectionOverride.chat ?? !!isChat}
            onToggle={() => setViewSectionOverride((v) => ({ ...v, chat: !(v.chat ?? !!isChat) }))}
            onMobileClose={onMobileClose}
          />
        </div>

        {/* What you are working on. Projects leads: it is the container the rest
            of this group files into, so the rail reads top-down as project →
            its tasks → the docs and files around them. */}
        <RailHeading label="Work" isNarrow={isNarrow} />
        <div className="text-sm">
          <NavSection
            label="Projects"
            href="/projects"
            isActive={isProjects}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            items={projectItems}
            expanded={viewSectionOverride.projects ?? isProjects}
            onToggle={() => setViewSectionOverride((o) => ({ ...o, projects: !(o.projects ?? isProjects) }))}
            icon={<FolderKanban className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
          />
          <NavSection
            label="Tasks"
            href="/tasks"
            isActive={isTasks}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            onAdd={() => openCreateModal("task")}
            items={taskViewItems}
            expanded={viewSectionOverride.tasks ?? isTasks}
            onToggle={() => setViewSectionOverride((o) => ({ ...o, tasks: !(o.tasks ?? isTasks) }))}
            icon={
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            }
          />
          <NavSection
            label="Docs"
            href="/docs"
            isActive={isDocs || isPlans}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            addTitle="New page"
            onAdd={async () => {
              // Stamp the active workspace so the doc lives where it was created.
              await createDoc(
                { title: "", doc_type: "note", ...wsStamp },
                { version: 1, kind: "navigate" },
              );
            }}
            items={docViewItems}
            expanded={viewSectionOverride.docs ?? (isDocs || isPlans)}
            onToggle={() => setViewSectionOverride((o) => ({ ...o, docs: !(o.docs ?? (isDocs || isPlans)) }))}
            icon={
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            }
          />
          <NavSection
            label="Capabilities"
            href="/capabilities"
            icon={<Blocks className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
            isActive={isCapabilities}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            items={[]}
          />
          <NavSection
            label="Files"
            href="/files"
            isActive={isVault}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            icon={
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-6 3h4" />
              </svg>
            }
          />
          <NavSection
            label="Pages"
            href="/pages"
            isActive={isPages}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            simpleHide
            icon={<Globe className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
          />
        </div>

        {/* The machinery that does the work: what is running right now, and the
            standing things that set it running. */}
        <RailHeading label="Agents" isNarrow={isNarrow} />
        <div className="text-sm">
          <NavSection
            label="Sessions"
            href="/sessions"
            isActive={!!isSessions}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            icon={
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            }
          />
          <NavSection
            label="Workflows"
            href="/workflows"
            isActive={isWorkflows}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            icon={<Workflow className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
          />
          <NavSection
            label="Triggers"
            href="/triggers"
            isActive={isTriggers}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            icon={<Zap className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />}
          />
          <NavSection
            label="Anchor"
            href="/anchor"
            isActive={isAnchor}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            title="Anchor — your standing agent"
            icon={
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="5" r="2.5" strokeWidth={1.5} />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 7.5V21M5 12H3a9 9 0 0018 0h-2" />
              </svg>
            }
          />
          <NavSection
            label="Windows"
            href="/windows"
            isActive={!!isWindows}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            icon={
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 16a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3zm10-2a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1h-4a1 1 0 01-1-1v-5z" />
            </svg>
            }
          />
        </div>

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

        {!isNarrow && computedDirectories.length > 0 && (
          <div className="mt-4">
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

      </div>
    </>
  );

  return (
    <nav
      data-sv-nav
      className={`
        h-full w-full py-3 sm:py-4 flex flex-col bg-sol-bg-alt select-none
        ${isMobileOpen ? 'shadow-xl' : 'hidden md:flex'}
      `}
    >
      <div className="flex-1 overflow-y-auto scrollbar-auto">
        {sidebarContent}
      </div>
      {!isDesktop() && !isNarrow && !hasUsedDesktop && (
        <a
          href="https://codecast.sh/download/mac"
          onClick={() => track("desktop_download_clicked", { location: "sidebar" })}
          className="flex items-center gap-2 px-3 py-2 mt-2 text-sm text-sol-text-dim hover:text-sol-cyan transition-colors border-t border-sol-border/30 pt-3"
        >
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span>Get Desktop App</span>
        </a>
      )}
      {createModal === "task" && (
        <CreateTaskModal onClose={() => closeCreateModal()} teamMembers={teamMembers} currentUser={currentUser} defaults={createModalDefaults} />
      )}
      {createModal === "plan" && (
        <CreateDocModal onClose={() => closeCreateModal()} initialType="plan" />
      )}
      {createModal === "chat" && (
        <CreateChannelModal
          onClose={() => closeCreateModal()}
          // The stub id is what the rail already shows; the tab path follows the
          // supersede when the server row lands (rekeyId).
          onCreated={(channelId) => router.push(`/chat/${channelId}`)}
        />
      )}
    </nav>
  );
}
