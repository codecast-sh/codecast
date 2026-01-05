"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useAuthActions } from "@convex-dev/auth/react";
import { cleanTitle } from "../lib/conversationProcessor";

interface SidebarProps {
  filter?: "my" | "team";
  onFilterChange?: (filter: "my" | "team") => void;
  directories?: string[];
  directoryFilter?: string | null;
  onDirectoryFilterChange?: (directory: string | null) => void;
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
  isNarrow?: boolean;
}

function formatRelativeDate(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;

  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

export function Sidebar({ filter = "my", onFilterChange, directories = [], directoryFilter, onDirectoryFilterChange, isMobileOpen = false, onMobileClose, isNarrow = false }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isDashboard = pathname === "/dashboard" || pathname?.startsWith("/dashboard/");
  const isTimeline = pathname === "/timeline" || pathname?.startsWith("/timeline/");
  const isFeed = pathname === "/feed" || pathname?.startsWith("/feed/");
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const { signOut } = useAuthActions();
  const user = useQuery(api.users.getCurrentUser);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = async () => {
    await signOut();
    router.push("/");
  };

  const displayName = user?.name || user?.email?.split("@")[0] || "User";
  const initials = displayName.slice(0, 1).toUpperCase();

  const favorites = useQuery(api.conversations.listFavorites);
  const bookmarks = useQuery(api.bookmarks.listBookmarks);
  const { conversations } = useQuery(api.conversations.listConversations, { filter: "my", limit: 100 }) ?? { conversations: [] };

  const handleFilterClick = (newFilter: "my" | "team") => {
    if (!isDashboard) {
      router.push(newFilter === "team" ? "/dashboard?filter=team" : "/dashboard");
    } else {
      onFilterChange?.(newFilter);
    }
    onMobileClose?.();
  };

  const handleDirectoryClick = (dir: string) => {
    if (!isDashboard) {
      router.push("/dashboard");
    }
    onDirectoryFilterChange?.(directoryFilter === dir ? null : dir);
    onMobileClose?.();
  };

  type ConversationItem = NonNullable<typeof conversations>[number];

  const isSubagent = (c: ConversationItem) =>
    c.title?.startsWith("Session agent-") ?? false;

  const isTrivialSubagent = (c: ConversationItem) => {
    if (!isSubagent(c)) return false;
    const userMsgCount = c.message_alternates?.filter(m => m.role === "user").length ?? 0;
    const aiMsgCount = c.message_alternates?.filter(m => m.role === "assistant").length ?? 0;
    if (c.ai_message_count !== undefined) {
      return c.ai_message_count <= 1 && userMsgCount === 0;
    }
    return aiMsgCount <= 1 && userMsgCount === 0;
  };

  const isWarmupSession = (c: ConversationItem) => {
    if (c.title?.toLowerCase() === "warmup") return true;
    if (c.message_count > 3) return false;
    const firstAssistantMsg = c.first_assistant_message?.toLowerCase() ||
      c.message_alternates?.find(m => m.role === "assistant")?.content?.toLowerCase() || "";
    const warmupPatterns = [
      "i'm ready to help",
      "i'll wait for your task",
      "what would you like me to help",
      "i understand. i'm ready",
      "running in read-only exploration mode",
    ];
    return warmupPatterns.some(p => firstAssistantMsg.includes(p));
  };

  const filteredConversations = conversations?.filter(c => !isTrivialSubagent(c) && !isWarmupSession(c)) ?? [];

  const groupedSessions = filteredConversations.reduce<Record<string, ConversationItem[]>>((acc, conv) => {
    const group = getDateGroup(conv.updated_at, currentTime);
    if (!acc[group]) acc[group] = [];
    acc[group].push(conv);
    return acc;
  }, {});

  const sidebarContent = (
    <>
      <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
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
            title="Private"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            {!isNarrow && <span>Private</span>}
          </button>
          <button
            onClick={() => handleFilterClick("team")}
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none text-left ${
              isDashboard && filter === "team"
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
            title="Team"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            {!isNarrow && <span>Team</span>}
          </button>
          <Link
            href="/timeline"
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none ${
              isTimeline
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
            title="Timeline"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {!isNarrow && <span>Timeline</span>}
          </Link>
          <Link
            href="/feed"
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none ${
              isFeed
                ? "bg-sol-bg-highlight text-sol-text border-l-2 border-sol-cyan"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
            title="Feed"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
            </svg>
            {!isNarrow && <span>Feed</span>}
          </Link>
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

        {!isNarrow && directories.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2">
              Projects
            </div>
            <div className="space-y-0.5">
              {directories.slice(0, 8).map((dir) => (
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
                          <span className="truncate flex-1 leading-tight">{cleanTitle(conv.title)}</span>
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

      <div className="pt-4 flex-shrink-0" ref={userMenuRef}>
        <div className="relative">
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className={`w-full flex items-center ${isNarrow ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg transition-colors hover:bg-sol-bg-alt/50`}
            title={displayName}
          >
            <div className="w-8 h-8 rounded-full bg-sol-bg-highlight flex items-center justify-center text-sol-text flex-shrink-0">
              <span className="text-sm font-medium">{initials}</span>
            </div>
            {!isNarrow && (
              <>
                <span className="flex-1 text-left text-sol-text-muted truncate">{displayName}</span>
                <svg className={`w-4 h-4 text-sol-text-dim transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 15l7-7 7 7" />
                </svg>
              </>
            )}
          </button>
          {userMenuOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-sol-bg border border-sol-border rounded-lg shadow-lg py-1 z-50">
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  onMobileClose?.();
                  router.push("/settings");
                }}
                className="w-full px-4 py-2 text-left text-sm text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt transition-colors flex items-center gap-3"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Settings
              </button>
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  handleLogout();
                }}
                className="w-full px-4 py-2 text-left text-sm text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt transition-colors flex items-center gap-3"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );

  return (
    <>
      {isMobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      <nav
        className={`
          h-full w-full p-3 sm:p-4 flex flex-col bg-sol-bg-alt/80 shadow-[6px_0_20px_rgba(0,0,0,0.12)] overflow-y-auto
          md:flex
          ${isMobileOpen ? 'fixed top-0 left-0 z-40 w-[85vw] max-w-xs h-screen bg-sol-bg-alt' : 'hidden'}
        `}
      >
        {sidebarContent}
      </nav>
    </>
  );
}
