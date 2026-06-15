import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useMemo, useCallback, useRef } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { toast } from "sonner";
import { useQuery, useMutation, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { cleanTitle, msgCountColor } from "../lib/conversationProcessor";
import { visitTimeAgo } from "../lib/recentVisits";
import { getLabelColor } from "../lib/labelColors";
import { shouldShowSession } from "../lib/sessionFilters";
import { useInboxStore, categorizeSessions, sessionsWithPendingSend, getProjectName } from "../store/inboxStore";
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
        const uploadUrl = await generateUploadUrl({});
        const result = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
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
        conv.is_subagent || conv.parent_conversation_id || conv.worktree_name
          ? "text-sol-text-dim/50 hover:text-sol-text-dim/70 hover:bg-sol-bg-alt/30 opacity-60"
          : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
      } ${isDragOver ? "ring-1 ring-sol-cyan bg-sol-cyan/10" : ""}`}
    >
      {conv.is_active && (
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0 -ml-1" />
      )}
      <span className={`truncate flex-1 leading-tight ${conv.is_subagent || conv.parent_conversation_id || conv.worktree_name ? "text-[13px]" : ""}`}>{cleanTitle(conv.title || "Untitled")}</span>
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
}: {
  label: string;
  href: string;
  isActive: boolean;
  isNarrow: boolean;
  icon: React.ReactNode;
  onMobileClose?: () => void;
  onAdd?: () => void;
}) {
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
        {!isNarrow && onAdd && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onAdd(); }}
            className="p-1 mr-2 opacity-60 hover:opacity-100 text-sol-text-dim hover:text-sol-text transition-all"
            title={`New ${label.toLowerCase().replace(/s$/, '')}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" d="M12 5v14m-7-7h14" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

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
  const showFavorites = useInboxStore((s) => s.showFavorites);
  const createDoc = useInboxStore((s) => s.createDoc);
  const createModal = useInboxStore((s) => s.createModal);
  const closeCreateModal = useInboxStore((s) => s.closeCreateModal);
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  const inboxSessions = useInboxStore((s) => s.sessions);
  const sessionsWithQueuedMessages = useInboxStore((s) => s.sessionsWithQueuedMessages);
  const pendingMessages = useInboxStore((s) => s.pendingMessages);
  const needsInputCount = useMemo(
    () => categorizeSessions(inboxSessions, sessionsWithQueuedMessages, sessionsWithPendingSend(pendingMessages)).needsInput.length,
    [inboxSessions, sessionsWithQueuedMessages, pendingMessages],
  );
  const openNewSession = useInboxStore((s) => s.openNewSession);
  const hasUsedDesktop = useInboxStore((s) => s.clientState.dismissed?.has_used_desktop ?? false);

  useMountEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  });

  const favoritesQuery = useQuery(api.conversations.listFavorites);
  const bookmarksQuery = useQuery(api.bookmarks.listBookmarks);
  const favorites = favoritesQuery ?? useInboxStore.getState().favorites;
  const bookmarks = bookmarksQuery ?? useInboxStore.getState().bookmarks;
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
  // The aggregate view: bookmarks clustered by their conversation (most-recently
  // bookmarked conversation first), so each pointer reads against its source
  // instead of floating as an orphaned preview line.
  const groupedBookmarks = useMemo(() => {
    if (!bookmarks) return [] as Array<{ conversation_id: string; title: string; project: string; items: any[]; latest: number }>;
    const byConv = new Map<string, { conversation_id: string; title: string; project: string; items: any[]; latest: number }>();
    for (const bm of bookmarks as any[]) {
      let g = byConv.get(bm.conversation_id);
      if (!g) {
        g = { conversation_id: bm.conversation_id, title: bm.conversation_title || "New Session", project: getProjectName(bm.git_root, bm.project_path), items: [], latest: 0 };
        byConv.set(bm.conversation_id, g);
      }
      g.items.push(bm);
      g.latest = Math.max(g.latest, bm.created_at ?? 0);
    }
    for (const g of byConv.values()) g.items.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    return Array.from(byConv.values()).sort((a, b) => b.latest - a.latest);
  }, [bookmarks]);
  const toggleBookmark = useInboxStore((s) => s.toggleBookmark);
  const allSavedViews = useInboxStore((s) => s.clientState.ui?.saved_views);
  const savedViews = useMemo(
    () => allSavedViews?.filter((v: any) => !v.team_id || v.team_id === activeTeamId),
    [allSavedViews, activeTeamId]
  );
  const deleteView = useInboxStore((s) => s.deleteView);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);

  useConvexSync(teamsQuery, useCallback((d: any) => useInboxStore.getState().syncTable("teams", d), []));
  useConvexSync(teamUnreadCountQuery, useCallback((d: any) => useInboxStore.getState().syncTable("teamUnreadCount", d), []));
  useConvexSync(favoritesQuery, useCallback((d: any) => useInboxStore.getState().syncTable("favorites", d), []));
  useConvexSync(bookmarksQuery, useCallback((d: any) => useInboxStore.getState().syncTable("bookmarks", d), []));
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
              isInbox && !showFavorites
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
                {needsInputCount > 0 && (
                  <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-[11px] font-bold bg-teal-600 text-white rounded-full">
                    {needsInputCount}
                  </span>
                )}
              </>
            )}
          </button>
          {/* Favorites — a peer top-level section. Repoints the session-list
              panel to the kept set (long-term shelf, grouped by project), reusing
              the same rows, keyboard nav and project filter as the inbox. */}
          <button
            onClick={() => {
              useInboxStore.getState().setShowFavorites(true);
              router.push("/inbox");
              onMobileClose?.();
            }}
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none text-left ${
              showFavorites
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-amber-400"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
            }`}
            title="Favorites"
          >
            <svg className={`w-5 h-5 flex-shrink-0 ${showFavorites ? "text-amber-400" : ""}`} fill={showFavorites ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            {!isNarrow && (
              <>
                <span>Favorites</span>
                {favorites && favorites.length > 0 && (
                  <span className="-ml-0.5 text-[10px] tabular-nums text-sol-text-dim/70">{favorites.length}</span>
                )}
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
            icon={
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            }
          />
          {/* Docs */}
          <div className={`flex items-center transition-colors motion-reduce:transition-none ${
            isDocs || isPlans
              ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
              : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
          }`}>
            <Link
              href="/docs"
              onClick={onMobileClose}
              className={`flex-1 flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 min-w-0`}
              title="Docs"
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {!isNarrow && <span>Docs</span>}
            </Link>
            {!isNarrow && (
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const result = await createDoc({ title: "", doc_type: "note" });
                  if (result?.id) router.push(`/docs/${result.id}`);
                }}
                className="p-1 mr-2 opacity-60 hover:opacity-100 text-sol-text-dim hover:text-sol-text transition-all"
                title="New page"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" d="M12 5v14m-7-7h14" />
                </svg>
              </button>
            )}
          </div>
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

        {!isNarrow && savedViews && savedViews.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              Saved Views
            </div>
            <div className="space-y-0.5">
              {savedViews.map((view: any) => (
                <div key={view.id} className="flex items-center group">
                  <button
                    onClick={() => {
                      const pagePrefsKey = view.page === "tasks" ? "task_view" : view.page === "docs" ? "doc_view" : "plan_view";
                      updateClientUI({ [pagePrefsKey]: view.prefs });
                      router.push(`/${view.page}`);
                      onMobileClose?.();
                    }}
                    className="flex items-center gap-2 px-4 py-1.5 text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60 transition-colors flex-1 min-w-0 text-left"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${view.page === "tasks" ? "bg-sol-yellow" : view.page === "docs" ? "bg-sol-violet" : "bg-sol-cyan"}`} />
                    <span className="truncate text-sm flex-1">{view.name}</span>
                    <span className="text-[9px] text-sol-text-dim/60 uppercase">{view.page}</span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteView(view.id);
                    }}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 text-sol-text-dim hover:text-sol-text transition-opacity flex-shrink-0 mr-1"
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

        {!isNarrow && groupedBookmarks.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-sol-cyan" fill="currentColor" viewBox="0 0 24 24">
                <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              Bookmarks
              <span className="ml-auto text-[10px] tabular-nums text-sol-text-dim/60 normal-case font-normal">{bookmarks.length}</span>
            </div>
            <div className="space-y-2.5">
              {(showAllBookmarks ? groupedBookmarks : groupedBookmarks.slice(0, 6)).map((group) => (
                <div key={group.conversation_id}>
                  <div className="px-4 mb-0.5 flex items-center gap-1.5 min-w-0">
                    {group.project && group.project !== "unknown" && (
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${getLabelColor(group.project).dot}`} />
                    )}
                    <span className="truncate text-[11px] font-semibold text-sol-text-dim">{cleanTitle(group.title)}</span>
                  </div>
                  {group.items.map((bm: any) => (
                    <div
                      key={bm._id}
                      onMouseEnter={() => prefetchBookmark(bm)}
                      onFocus={() => prefetchBookmark(bm)}
                      className="flex items-start gap-2 px-4 py-1 hover:bg-sol-bg-highlight/60 transition-colors group cursor-pointer"
                      onClick={() => {
                        const store = useInboxStore.getState();
                        // Pair the navigation target with the scroll target atomically so the
                        // inbox's pendingNavigateId watcher resolves them together. Setting them
                        // separately (navigateToSession + a later setState) raced the cache-hit
                        // watcher, which pinned the scroll to the *previous* conversation.
                        store.requestNavigate(bm.conversation_id, { scrollToMessageId: bm.message_id });
                        const activeTab = store.tabs.find((t: any) => t.id === store.activeTabId);
                        if (activeTab) {
                          store.updateTab(activeTab.id, { path: "/inbox" });
                        }
                        if (!store.tabs.length) router.push("/inbox");
                        onMobileClose?.();
                      }}
                    >
                      <svg className={`w-3 h-3 flex-shrink-0 mt-[3px] ${bm.message_role === "user" ? "text-sol-blue" : "text-sol-violet"}`} fill="currentColor" viewBox="0 0 24 24">
                        <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                      </svg>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-sol-text-muted group-hover:text-sol-text leading-snug">
                          {bm.name || bm.message_preview || "Bookmarked message"}
                        </div>
                        <div className="flex items-center gap-1 text-[10px] text-sol-text-dim/70 leading-tight">
                          <span>{bm.message_role === "user" ? "you" : "assistant"}</span>
                          <span aria-hidden>·</span>
                          <span>{visitTimeAgo(bm.created_at)}</span>
                          {bm.name && bm.message_preview && (
                            <span className="truncate opacity-80">· {bm.message_preview}</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleBookmark(bm.conversation_id, bm.message_id);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-sol-text-dim hover:text-sol-red transition-all flex-shrink-0 mt-[2px]"
                        title="Remove bookmark"
                        aria-label="Remove bookmark"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              ))}
              {groupedBookmarks.length > 6 && (
                <button
                  onClick={() => setShowAllBookmarks(v => !v)}
                  className="w-full px-4 py-1 text-xs text-sol-text-dim hover:text-sol-text transition-colors text-left"
                >
                  {showAllBookmarks ? "Show less" : `${groupedBookmarks.length - 6} more conversation${groupedBookmarks.length - 6 === 1 ? "" : "s"}…`}
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
                onClick={() => openNewSession()}
                className="text-sol-text-dim hover:text-sol-yellow transition-colors"
                title="New session..."
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
