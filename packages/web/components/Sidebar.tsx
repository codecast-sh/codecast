"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { cleanTitle } from "../lib/conversationProcessor";
import { shouldShowSession } from "../lib/sessionFilters";
import { useActiveTeamStore } from "../store/activeTeamStore";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { TeamIcon } from "./TeamIcon";

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

export function Sidebar({ filter = "my", onFilterChange, directoryFilter, onDirectoryFilterChange, isMobileOpen = false, onMobileClose, isNarrow = false }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isDashboard = pathname === "/dashboard" || pathname?.startsWith("/dashboard/");
  const isTimeline = pathname === "/timeline" || pathname?.startsWith("/timeline/");
  const isFeed = pathname === "/feed" || pathname?.startsWith("/feed/");
  const isInbox = pathname === "/inbox" || pathname?.startsWith("/inbox/");
  const isAdminLogs = pathname?.startsWith("/admin/daemon-logs");
  const { user: currentUser } = useCurrentUser();
  const isAdmin = currentUser?.email === "ashot@almostcandid.com";
  const [currentTime, setCurrentTime] = useState(Date.now());
  const { activeTeamId } = useActiveTeamStore();
  const teams = useQuery(api.teams.getUserTeams);
  const activeTeam = teams?.find(t => t?._id === activeTeamId);
  const teamUnreadCount = useQuery(
    api.conversations.getTeamUnreadCount,
    activeTeamId ? { teamId: activeTeamId } : "skip"
  );
  const markTeamSeen = useMutation(api.conversations.markTeamConversationsSeen);
  const activeSessions = useQuery(api.conversations.listIdleSessions);
  const idleCount = activeSessions?.filter((s: any) => s.is_idle).length ?? 0;

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const favorites = useQuery(api.conversations.listFavorites);
  const bookmarks = useQuery(api.bookmarks.listBookmarks);
  const { conversations } =
    useQuery(api.conversations.listConversations, {
      filter: "my",
      limit: 100,
      include_message_previews: false,
    }) ?? { conversations: [] };

  const handleFilterClick = (newFilter: "my" | "team") => {
    if (newFilter === "team") {
      markTeamSeen();
    }
    if (!isDashboard) {
      router.push(newFilter === "team" ? "/dashboard?filter=team" : "/dashboard");
    } else {
      onFilterChange?.(newFilter);
    }
    onMobileClose?.();
  };

  const handleDirectoryClick = (dir: string) => {
    const newDir = directoryFilter === dir ? null : dir;
    if (!isDashboard) {
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
    const deriveGitRoot = (c: ConversationItem): string | null => {
      if (c.git_root) return c.git_root;
      if (!c.project_path) return null;
      const parts = c.project_path.split('/');
      const srcIndex = parts.findIndex(p => p === 'src' || p === 'projects' || p === 'repos' || p === 'code');
      if (srcIndex >= 0 && srcIndex < parts.length - 1) {
        return parts.slice(0, srcIndex + 2).join('/');
      }
      return c.project_path;
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
          <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2">
            Conversations
          </div>
        )}
        <div className="space-y-1">
          <button
            onClick={() => handleFilterClick("my")}
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none text-left ${
              isDashboard && filter === "my"
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
            title="My Sessions (summaries shared with team)"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            {!isNarrow && <span>My Sessions</span>}
          </button>
          <Link
            href="/inbox"
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none ${
              isInbox
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
            title="Inbox"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
            {!isNarrow && (
              <>
                <span>Inbox</span>
                {idleCount > 0 && (
                  <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-xs font-semibold bg-sol-orange text-sol-bg rounded-full">
                    {idleCount}
                  </span>
                )}
              </>
            )}
          </Link>
          <button
            onClick={() => handleFilterClick("team")}
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none text-left ${
              isDashboard && filter === "team"
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
            title={activeTeam?.name || "Team"}
          >
            {activeTeam ? (
              <TeamIcon icon={activeTeam.icon} color={activeTeam.icon_color} className="w-5 h-5 flex-shrink-0" />
            ) : (
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            )}
            {!isNarrow && (
              <>
                <span>{activeTeam?.name || "Team"}</span>
                {teamUnreadCount !== undefined && teamUnreadCount > 0 && !(isDashboard && filter === "team") && (
                  <span className="-ml-0.5 min-w-[20px] h-[20px] px-1.5 flex items-center justify-center text-xs font-semibold bg-sol-cyan text-sol-bg rounded-full">
                    {teamUnreadCount}
                  </span>
                )}
              </>
            )}
          </button>
          {isAdmin && (
            <Link
              href="/admin/daemon-logs"
              className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none ${
                isAdminLogs
                  ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                  : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
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
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-amber-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              Favorites
            </div>
            <div className="space-y-0.5">
              {favorites.slice(0, 5).map((fav) => (
                <Link
                  key={fav._id}
                  href={`/conversation/${fav._id}`}
                  onClick={onMobileClose}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50 transition-colors group"
                >
                  <svg className="w-3 h-3 text-amber-400 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                  <span className="truncate text-sm flex-1">{cleanTitle(fav.title || `Session ${fav.session_id?.slice(0, 8)}`)}</span>
                  <span className="text-[10px] text-sol-text-dim">{fav.message_count}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {!isNarrow && bookmarks && bookmarks.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-sol-cyan" fill="currentColor" viewBox="0 0 24 24">
                <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              Bookmarks
            </div>
            <div className="space-y-0.5">
              {bookmarks.slice(0, 8).map((bookmark) => (
                <Link
                  key={bookmark._id}
                  href={`/conversation/${bookmark.conversation_id}#msg-${bookmark.message_id}`}
                  onClick={onMobileClose}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50 transition-colors group"
                >
                  <svg className={`w-3 h-3 flex-shrink-0 ${bookmark.message_role === "user" ? "text-sol-blue" : "text-sol-violet"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                  <span className="truncate text-sm flex-1">{bookmark.message_preview || bookmark.conversation_title}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {!isNarrow && computedDirectories.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2">
              Projects
            </div>
            <div className="space-y-0.5">
              {computedDirectories.slice(0, 8).map((dir) => (
                <button
                  key={dir}
                  onClick={() => handleDirectoryClick(dir)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors motion-reduce:transition-none text-left text-sm ${
                    directoryFilter === dir
                      ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                      : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
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
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2">
              Recent Sessions
            </div>
            <div className="space-y-2">
              {["Last Hour", "Last 6 Hours", "Last Day", "Yesterday", "This Week", "This Month", "Older"].map((group) => {
                const items = groupedSessions[group];
                if (!items || items.length === 0) return null;
                return (
                  <div key={group}>
                    <div className="text-[10px] font-medium text-sol-text-dim px-3 py-0.5">{group}</div>
                    <div className="space-y-0.5">
                      {items.map((conv) => (
                        <Link
                          key={conv._id}
                          href={`/conversation/${conv._id}`}
                          onClick={onMobileClose}
                          className={`flex items-center gap-2 px-3 py-1 rounded text-sm transition-colors group ${
                            pathname === `/conversation/${conv._id}`
                              ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                              : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
                          }`}
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
                          <span className="text-[10px] text-sol-text-dim flex-shrink-0 tabular-nums">{conv.message_count}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );

  return (
    <nav
      className={`
        h-full w-full p-3 sm:p-4 flex flex-col bg-sol-bg-alt overflow-y-auto scrollbar-auto
        ${isMobileOpen ? 'shadow-xl' : 'hidden md:flex'}
      `}
    >
      {sidebarContent}
    </nav>
  );
}
