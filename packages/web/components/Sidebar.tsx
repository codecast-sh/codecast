import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useMemo, useCallback, useRef, memo } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { toast } from "sonner";
import { useQuery, useMutation, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { cleanTitle, msgCountColor } from "../lib/conversationProcessor";
import { compressImage } from "../lib/compressImage";
import { visitTimeAgo } from "../lib/recentVisits";
import { getLabelColor } from "../lib/labelColors";
import { shouldShowSession } from "../lib/sessionFilters";
import { nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { useInboxStore, categorizeSessions, sessionsWithPendingSend } from "../store/inboxStore";
import { useConvexSync } from "../hooks/useConvexSync";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { TeamIcon } from "./TeamIcon";
import { isDesktop } from "../lib/desktop";
import { CreateTaskModal } from "./CreateTaskModal";
import { CreateDocModal } from "./CreateDocModal";
import { Workflow } from "lucide-react";

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

function getDateGroup(timestamp: number, now: number): string {
  const diffMs = now - timestamp;
  const diffHours = diffMs / 3600000;
  const diffDays = diffMs / 86400000;

  if (diffHours < 1) return "Last Hour";
  if (diffHours < 6) return "Last 6 Hours";
  if (diffDays < 1) return "Last Day";
  if (diffDays < 2) return "Yesterday";
  if (diffDays < 7) return "This Week";
  if (diffDays < 30) return "This Month";
  return "Older";
}


function getShortPath(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  if (parts.length === 0) return projectPath;
  return parts[parts.length - 1];
}

function DroppableSessionRow({ conv, onMobileClose }: { conv: any; onMobileClose?: () => void }) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    if (files.length === 0) {
      if (e.dataTransfer.files.length > 0) toast.error("Only image files are supported");
      return;
    }
    try {
      const storageIds: Id<"_storage">[] = [];
      for (const file of files) {
        const uploaded = await compressImage(file);
        const uploadUrl = await generateUploadUrl({});
        const result = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": uploaded.type }, body: uploaded });
        const { storageId } = await result.json();
        storageIds.push(storageId);
      }
      await sendMessage({ conversation_id: conv._id, content: "[image]", image_storage_ids: storageIds });
      toast.success(`Attached ${files.length} image${files.length > 1 ? "s" : ""} to "${cleanTitle(conv.title || "Untitled")}"`);
    } catch {
      toast.error("Failed to attach files");
    }
  }, [conv._id, conv.title, generateUploadUrl, sendMessage]);

  return (
    <Link
      href={`/conversation/${conv._id}`}
      onClick={onMobileClose}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex items-center gap-2 px-3 py-1 rounded text-sm transition-colors group ${
        conv.is_subagent || nestParentIdOf(conv) || conv.worktree_name
          ? "text-sol-text-dim/50 hover:text-sol-text-dim/70 hover:bg-sol-bg-alt/30 opacity-60"
          : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
      } ${isDragOver ? "ring-1 ring-sol-cyan bg-sol-cyan/10" : ""}`}
    >
      {conv.is_active && (
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0 -ml-1" />
      )}
      <span className={`truncate flex-1 leading-tight ${conv.is_subagent || nestParentIdOf(conv) || conv.worktree_name ? "text-[13px]" : ""}`}>{cleanTitle(conv.title || "Untitled")}</span>
      {conv.worktree_name && (
        <span className="text-[9px] text-sol-cyan font-mono truncate max-w-[80px] flex-shrink-0" title={conv.worktree_branch || conv.worktree_name}>
          {conv.worktree_name}
        </span>
      )}
      {conv.message_count > 0 && (
        <span className={`text-[10px] flex-shrink-0 tabular-nums ${msgCountColor(conv.message_count)}`}>{conv.message_count}</span>
      )}
    </Link>
  );
}

const INITIAL_SESSION_LIMIT = 30;
const SESSION_PAGE_SIZE = 50;

function RecentSessions({
  groupedSessions,
  totalCount,
  onMobileClose,
}: {
  groupedSessions: Record<string, any[]>;
  totalCount: number;
  onMobileClose?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_SESSION_LIMIT);
  const showMore = useCallback(() => setVisibleCount(c => c + SESSION_PAGE_SIZE), []);
  const groups = ["Last Hour", "Last 6 Hours", "Last Day", "Yesterday", "This Week", "This Month", "Older"];

  let rendered = 0;
  const hiddenCount = totalCount - Math.min(visibleCount, totalCount);

  return (
    <div className="mt-4">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2 hover:text-sol-text-muted transition-colors select-none"
      >
        <span>Recent Sessions</span>
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {!expanded ? null : <div className="space-y-2">
        {groups.map((group) => {
          if (rendered >= visibleCount) return null;
          const items = groupedSessions[group];
          if (!items || items.length === 0) return null;
          const remaining = visibleCount - rendered;
          const visible = items.slice(0, remaining);
          rendered += visible.length;
          return (
            <div key={group}>
              <div className="text-[10px] font-medium text-sol-text-dim px-3 py-0.5">{group}</div>
              <div className="space-y-0.5">
                {visible.map((conv: any) => (
                  <DroppableSessionRow key={conv._id} conv={conv} onMobileClose={onMobileClose} />
                ))}
              </div>
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <button
            onClick={showMore}
            className="w-full px-3 py-1.5 text-xs text-sol-text-dim hover:text-sol-text transition-colors text-left"
          >
            {hiddenCount} more...
          </button>
        )}
      </div>}
    </div>
  );
}


function NavSection({
  label,
  href,
  isActive,
  isNarrow,
  icon,
  onMobileClose,
  onAdd,
  addTitle,
  views,
  expanded,
  onToggle,
  onSelectView,
  onRemoveView,
}: {
  label: string;
  href: string;
  isActive: boolean;
  isNarrow: boolean;
  icon: React.ReactNode;
  onMobileClose?: () => void;
  onAdd?: () => void;
  addTitle?: string;
  views?: any[];
  expanded?: boolean;
  onToggle?: () => void;
  onSelectView?: (view: any) => void;
  onRemoveView?: (id: string) => void;
}) {
  // Only the wide rail nests saved views; the narrow rail stays icon-only.
  const hasViews = !isNarrow && !!views && views.length > 0;
  return (
    <div>
      <div className={`flex items-center transition-colors motion-reduce:transition-none ${
        isActive
          ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
          : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
      }`}>
        <Link
          href={href}
          onClick={onMobileClose}
          className={`flex-1 flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 min-w-0`}
          title={label}
        >
          {icon}
          {!isNarrow && <span>{label}</span>}
        </Link>
        {hasViews && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle?.(); }}
            className="p-1 text-sol-text-dim hover:text-sol-text transition-colors"
            title={expanded ? `Hide saved ${label.toLowerCase()} views` : `Show saved ${label.toLowerCase()} views`}
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
      {/* Saved views for this page — a slide-open list aligned under the row's icon. */}
      {hasViews && (
        <div className={`overflow-hidden transition-all duration-200 ease-out ${expanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="ml-[27px] my-0.5 border-l border-sol-border/50">
            {views!.map((view) => (
              <div key={view.id} className="flex items-center group/v">
                <button
                  onClick={() => onSelectView?.(view)}
                  className="flex items-center pl-4 pr-2 py-1 text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/40 transition-colors flex-1 min-w-0 text-left"
                >
                  <span className="truncate text-[13px] min-w-0">{view.name}</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemoveView?.(view.id); }}
                  className="p-1 mr-1.5 rounded opacity-0 group-hover/v:opacity-100 text-sol-text-dim hover:text-sol-text transition-opacity flex-shrink-0"
                  title="Remove saved view"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
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
  const inboxSessions = useInboxStore((s) => s.sessions);
  const sessionsWithQueuedMessages = useInboxStore((s) => s.sessionsWithQueuedMessages);
  const pendingMessages = useInboxStore((s) => s.pendingMessages);
  const needsInputCount = useMemo(
    () => categorizeSessions(inboxSessions, sessionsWithQueuedMessages, sessionsWithPendingSend(pendingMessages)).needsInput.length,
    [inboxSessions, sessionsWithQueuedMessages, pendingMessages],
  );
  if (needsInputCount === 0) return null;
  return (
    <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-[11px] font-bold bg-teal-600 text-white rounded-full">
      {needsInputCount}
    </span>
  );
});

export function Sidebar({ directoryFilter, isMobileOpen = false, onMobileClose, isNarrow = false }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isInbox = pathname === "/conversation" || pathname?.startsWith("/conversation/") || pathname === "/inbox" || pathname?.startsWith("/inbox/");
  const isSessions = pathname?.startsWith("/sessions");
  const isWindows = pathname?.startsWith("/windows");
  const isTeamActivity = pathname === "/team/activity" || pathname?.startsWith("/team/activity");
  const isTasks = pathname === "/tasks" || pathname?.startsWith("/tasks/");
  const isPlans = pathname === "/plans" || pathname?.startsWith("/plans/");
  const isDocs = pathname === "/docs" || pathname?.startsWith("/docs/");
  const isWorkflows = pathname === "/workflows" || pathname?.startsWith("/workflows/");
  const isSchedules = pathname === "/schedules" || pathname?.startsWith("/schedules/");
  const { user: currentUser } = useCurrentUser();
  const teamMembers = useInboxStore((s) => s.teamMembers);
  const [currentTime, setCurrentTime] = useState(Date.now());
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
  const createModal = useInboxStore((s) => s.createModal);
  const closeCreateModal = useInboxStore((s) => s.closeCreateModal);
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  const openCompose = useInboxStore((s) => s.openCompose);
  const hasUsedDesktop = useInboxStore((s) => s.clientState.dismissed?.has_used_desktop ?? false);

  useMountEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  });

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
  const allSavedViews = useInboxStore((s) => s.clientState.ui?.saved_views);
  const savedViews = useMemo(
    () => allSavedViews?.filter((v: any) => !v.team_id || v.team_id === activeTeamId),
    [allSavedViews, activeTeamId]
  );
  const deleteView = useInboxStore((s) => s.deleteView);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  // Saved views nest under their page's nav row instead of a separate section.
  const taskViews = useMemo(() => savedViews?.filter((v: any) => v.page === "tasks") ?? [], [savedViews]);
  const docViews = useMemo(() => savedViews?.filter((v: any) => v.page === "docs" || v.page === "plans") ?? [], [savedViews]);
  // They reveal when you open that page (navigation is the default); the chevron
  // pins a section open or closed regardless of which page you're on.
  const [viewSectionOverride, setViewSectionOverride] = useState<Record<string, boolean>>({});
  const applyView = useCallback((view: any) => {
    const pagePrefsKey = view.page === "tasks" ? "task_view" : view.page === "docs" ? "doc_view" : "plan_view";
    updateClientUI({ [pagePrefsKey]: view.prefs });
    router.push(`/${view.page}`);
    onMobileClose?.();
  }, [updateClientUI, router, onMobileClose]);

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


  const groupedSessions = filteredConversations.reduce((acc: Record<string, ConversationItem[]>, conv: ConversationItem) => {
    const group = getDateGroup(conv.updated_at, currentTime);
    if (!acc[group]) acc[group] = [];
    acc[group].push(conv);
    return acc;
  }, {} as Record<string, ConversationItem[]>);

  const sidebarContent = (
    <>
      <div className="flex-1 flex flex-col min-h-0">
        {!isNarrow && (
          <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2">
            Conversations
          </div>
        )}
        <div>
          <button
            onClick={() => {
              useInboxStore.getState().setShowFavorites(false);
              if (isInbox) {
                useInboxStore.getState().setShowMySessions(true);
                useInboxStore.getState().clearSelection();
              }
              router.push("/inbox");
            }}
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none text-left ${
              isInbox
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
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
              className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none text-left ${
                isTeamActivity
                  ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                  : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
              }`}
              title={activeTeam.name}
            >
              <TeamIcon icon={activeTeam.icon} color={activeTeam.icon_color} className="w-5 h-5 flex-shrink-0" />
              {!isNarrow && (
                <>
                  <span>{activeTeam.name}</span>
                  {teamUnreadCount !== undefined && teamUnreadCount > 0 && !isTeamActivity && (
                    <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-xs font-semibold bg-sol-cyan text-sol-bg rounded-full">
                      {teamUnreadCount}
                    </span>
                  )}
                </>
              )}
            </Link>
          )}
          <NavSection
            label="Tasks"
            href="/tasks"
            isActive={isTasks}
            isNarrow={isNarrow}
            onMobileClose={onMobileClose}
            onAdd={() => openCreateModal("task")}
            views={taskViews}
            expanded={viewSectionOverride.tasks ?? isTasks}
            onToggle={() => setViewSectionOverride((o) => ({ ...o, tasks: !(o.tasks ?? isTasks) }))}
            onSelectView={applyView}
            onRemoveView={deleteView}
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
              const result = await createDoc({ title: "", doc_type: "note" });
              if (result?.id) router.push(`/docs/${result.id}`);
            }}
            views={docViews}
            expanded={viewSectionOverride.docs ?? (isDocs || isPlans)}
            onToggle={() => setViewSectionOverride((o) => ({ ...o, docs: !(o.docs ?? (isDocs || isPlans)) }))}
            onSelectView={applyView}
            onRemoveView={deleteView}
            icon={
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            }
          />
          <Link
            href="/workflows"
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none ${
              isWorkflows
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
            }`}
            title="Workflows"
          >
            <Workflow className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />
            {!isNarrow && <span>Workflows</span>}
          </Link>
          <Link
            href="/schedules"
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none ${
              isSchedules
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
            }`}
            title="Schedules"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {!isNarrow && <span>Schedules</span>}
          </Link>
          <Link
            href="/sessions"
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none ${
              isSessions
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
            }`}
            title="Sessions"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            {!isNarrow && <span>Sessions</span>}
          </Link>
          <Link
            href="/windows"
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none ${
              isWindows
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
            }`}
            title="Windows"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 16a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3zm10-2a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1h-4a1 1 0 01-1-1v-5z" />
            </svg>
            {!isNarrow && <span>Windows</span>}
          </Link>
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

        {!isNarrow && filteredConversations.length > 0 && (
          <RecentSessions
            groupedSessions={groupedSessions}
            totalCount={filteredConversations.length}
            onMobileClose={onMobileClose}
          />
        )}
      </div>
    </>
  );

  return (
    <nav
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
          className="flex items-center gap-2 px-3 py-2 mt-2 text-sm text-sol-text-dim hover:text-sol-cyan transition-colors border-t border-sol-border/30 pt-3"
        >
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span>Get Desktop App</span>
        </a>
      )}
      {createModal === "task" && (
        <CreateTaskModal onClose={() => closeCreateModal()} teamMembers={teamMembers} currentUser={currentUser} />
      )}
      {createModal === "plan" && (
        <CreateDocModal onClose={() => closeCreateModal()} initialType="plan" />
      )}
    </nav>
  );
}
