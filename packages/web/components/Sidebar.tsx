import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useMemo, useCallback, useRef } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { toast } from "sonner";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { cleanTitle } from "../lib/conversationProcessor";
import { shouldShowSession } from "../lib/sessionFilters";
import { useInboxStore } from "../store/inboxStore";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { TeamIcon } from "./TeamIcon";
import { isDesktop } from "../lib/desktop";

interface SidebarProps {
  filter?: "my" | "team";
  onFilterChange?: (filter: "my" | "team") => void;
  directoryFilter?: string | null;
  onDirectoryFilterChange?: (directory: string | null) => void;
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
      className={`flex items-center gap-2 px-3 py-1 rounded text-sm transition-colors group text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50 ${isDragOver ? "ring-1 ring-sol-cyan bg-sol-cyan/10" : ""}`}
    >
      {conv.is_active ? (
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
      ) : conv.is_favorite ? (
        <svg className="w-3 h-3 text-amber-400 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      ) : (
        <span className="w-3 h-3 flex-shrink-0" />
      )}
      <span className="truncate flex-1 leading-tight">{cleanTitle(conv.title || "Untitled")}</span>
      {conv.worktree_name && (
        <span className="text-[9px] text-sol-cyan font-mono truncate max-w-[80px] flex-shrink-0" title={conv.worktree_branch || conv.worktree_name}>
          {conv.worktree_name}
        </span>
      )}
      <span className="text-[10px] text-sol-text-dim flex-shrink-0 tabular-nums">{conv.message_count}</span>
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

export function Sidebar({ directoryFilter, onDirectoryFilterChange, isMobileOpen = false, onMobileClose, isNarrow = false }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isInbox = pathname === "/conversation" || pathname?.startsWith("/conversation/") || pathname === "/inbox" || pathname?.startsWith("/inbox/");
  const isAdminLogs = pathname?.startsWith("/admin/daemon-logs");
  const isTeamActivity = pathname === "/team/activity" || pathname?.startsWith("/team/activity");
  const isTasks = pathname === "/tasks" || pathname?.startsWith("/tasks/");
  const isPlans = pathname === "/plans" || pathname?.startsWith("/plans/");
  const isDocs = pathname === "/docs" || pathname?.startsWith("/docs/");
  const { user: currentUser } = useCurrentUser();
  const isAdmin = currentUser?.email === "ashot@almostcandid.com";
  const [currentTime, setCurrentTime] = useState(Date.now());
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const teams = useQuery(api.teams.getUserTeams);
  const activeTeam = teams?.find(t => t?._id === activeTeamId);
  const teamUnreadCount = useQuery(
    api.conversations.getTeamUnreadCount,
    activeTeamId ? { teamId: activeTeamId } : "skip"
  );
  const toggleFavorite = useMutation(api.conversations.toggleFavorite);
  const activeSessions = useQuery(api.conversations.listIdleSessions, {});
  const needsInputCount = activeSessions?.filter((s: any) => s.is_idle && s.message_count > 0).length ?? 0;
  const openNewSession = useInboxStore((s) => s.openNewSession);
  const hasUsedDesktop = useInboxStore((s) => s.clientState.dismissed?.has_used_desktop ?? false);

  useMountEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  });

  const favorites = useQuery(api.conversations.listFavorites);
  const bookmarks = useQuery(api.bookmarks.listBookmarks);
  const toggleBookmark = useMutation(api.bookmarks.toggleBookmark);
  const { conversations } =
    useQuery(api.conversations.listConversations, {
      filter: "my",
      limit: 100,
      include_message_previews: false,
    }) ?? { conversations: [] };

  const handleDirectoryClick = (dir: string) => {
    const newDir = directoryFilter === dir ? null : dir;
    if (!pathname?.startsWith("/dashboard")) {
      if (newDir) {
        router.push(`/dashboard?dir=${encodeURIComponent(newDir)}`);
      } else {
        router.push("/dashboard");
      }
    } else {
      onDirectoryFilterChange?.(newDir);
    }
    onMobileClose?.();
  };

  type ConversationItem = NonNullable<typeof conversations>[number];

  const filteredConversations = useMemo(() =>
    conversations?.filter(c => shouldShowSession(c)) ?? [],
    [conversations]
  );

  const computedDirectories = useMemo(() => {
    const normalizeToRoot = (path: string): string => {
      const parts = path.split('/');
      const srcIndex = parts.findIndex(p => p === 'src' || p === 'projects' || p === 'repos' || p === 'code');
      if (srcIndex >= 0 && srcIndex < parts.length - 1) {
        return parts.slice(0, srcIndex + 2).join('/');
      }
      return path;
    };

    const deriveGitRoot = (c: ConversationItem): string | null => {
      const rawPath = c.git_root || c.project_path;
      if (!rawPath) return null;
      return normalizeToRoot(rawPath);
    };

    const dirLastUpdated = new Map<string, number>();
    for (const c of filteredConversations) {
      const dir = deriveGitRoot(c);
      if (dir) {
        const existing = dirLastUpdated.get(dir) || 0;
        if (c.updated_at > existing) {
          dirLastUpdated.set(dir, c.updated_at);
        }
      }
    }
    return Array.from(dirLastUpdated.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([path]) => path);
  }, [filteredConversations]);


  const groupedSessions = filteredConversations.reduce<Record<string, ConversationItem[]>>((acc, conv) => {
    const group = getDateGroup(conv.updated_at, currentTime);
    if (!acc[group]) acc[group] = [];
    acc[group].push(conv);
    return acc;
  }, {});

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
              useInboxStore.getState().setShowMySessions(true);
              useInboxStore.getState().clearSelection();
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
                {needsInputCount > 0 && (
                  <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-[11px] font-bold bg-teal-600 text-white rounded-full">
                    {needsInputCount}
                  </span>
                )}
              </>
            )}
          </button>
          <Link
            href="/tasks"
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none ${
              isTasks
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
            }`}
            title="Tasks"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            {!isNarrow && <span>Tasks</span>}
          </Link>
          <Link
            href="/plans"
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none ${
              isPlans
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
            }`}
            title="Plans"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
            </svg>
            {!isNarrow && <span>Plans</span>}
          </Link>
          <Link
            href="/docs"
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none ${
              isDocs
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
            }`}
            title="Documents"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {!isNarrow && <span>Docs</span>}
          </Link>
          {(activeTeamId || (teams && teams.length > 0)) && (
            <Link
              href="/team/activity"
              className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none text-left ${
                isTeamActivity
                  ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                  : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
              }`}
              title={activeTeam?.name || teams?.[0]?.name || "Team"}
            >
              {activeTeam ? (
                <TeamIcon icon={activeTeam.icon} color={activeTeam.icon_color} className="w-5 h-5 flex-shrink-0" />
              ) : teams?.[0] ? (
                <TeamIcon icon={teams[0].icon} color={teams[0].icon_color} className="w-5 h-5 flex-shrink-0" />
              ) : (
                <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              )}
              {!isNarrow && (
                <>
                  <span>{activeTeam?.name || teams?.[0]?.name || "Team"}</span>
                  {teamUnreadCount !== undefined && teamUnreadCount > 0 && !isTeamActivity && (
                    <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-xs font-semibold bg-sol-cyan text-sol-bg rounded-full">
                      {teamUnreadCount}
                    </span>
                  )}
                </>
              )}
            </Link>
          )}
          {isAdmin && (
            <Link
              href="/admin/daemon-logs"
              className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-4 py-2.5 transition-colors motion-reduce:transition-none ${
                isAdminLogs
                  ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                  : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
              }`}
              title="Daemon Logs"
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {!isNarrow && <span>Logs</span>}
            </Link>
          )}
        </div>

        {!isNarrow && favorites && favorites.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-amber-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              Favorites
            </div>
            <div className="space-y-0.5">
              {favorites.slice(0, 5).map((fav) => (
                <div key={fav._id} className="flex items-center group">
                  <Link
                    href={`/conversation/${fav._id}`}
                    onClick={onMobileClose}
                    className="flex items-center gap-2 px-4 py-1.5 text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60 transition-colors flex-1 min-w-0"
                  >
                    <svg className="w-3 h-3 text-amber-400 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                    <span className="truncate text-sm flex-1">{cleanTitle(fav.title || "New Session")}</span>
                    <span className="text-[10px] text-sol-text-dim">{fav.message_count}</span>
                  </Link>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite({ conversation_id: fav._id as Id<"conversations"> });
                    }}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 text-sol-text-dim hover:text-sol-text transition-opacity flex-shrink-0 mr-1"
                    title="Remove from favorites"
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

        {!isNarrow && bookmarks && bookmarks.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-sol-cyan" fill="currentColor" viewBox="0 0 24 24">
                <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              Bookmarks
            </div>
            <div className="space-y-0.5">
              {bookmarks.slice(0, 8).map((bookmark) => (
                <div
                  key={bookmark._id}
                  className="flex items-center gap-2 px-4 py-1.5 text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60 transition-colors group cursor-pointer"
                  onClick={() => {
                    useInboxStore.setState({
                      pendingNavigateId: bookmark.conversation_id,
                      pendingScrollToMessageId: bookmark.message_id,
                    });
                    router.push("/inbox");
                    onMobileClose?.();
                  }}
                >
                  <svg className={`w-3 h-3 flex-shrink-0 ${bookmark.message_role === "user" ? "text-sol-blue" : "text-sol-violet"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                  <span className="truncate text-sm flex-1">{bookmark.message_preview || bookmark.conversation_title}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleBookmark({ conversation_id: bookmark.conversation_id, message_id: bookmark.message_id });
                    }}
                    className="opacity-0 group-hover:opacity-100 text-sol-text-dim hover:text-sol-red transition-all flex-shrink-0"
                    title="Remove bookmark"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {!isNarrow && computedDirectories.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-4 mb-2 flex items-center justify-between">
              <span>Projects</span>
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
    </nav>
  );
}
