"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { cleanTitle } from "../lib/conversationProcessor";

interface SidebarProps {
  filter?: "my" | "team";
  onFilterChange?: (filter: "my" | "team") => void;
  directories?: string[];
  directoryFilter?: string | null;
  onDirectoryFilterChange?: (directory: string | null) => void;
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
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

function getDateGroup(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This Week";
  if (diffDays < 30) return "This Month";
  return "Older";
}

const bottomNavItems = [
  {
    href: "/cli",
    label: "CLI Setup",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
    ),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    ),
  },
];

function getShortPath(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  if (parts.length === 0) return projectPath;
  return parts[parts.length - 1];
}

export function Sidebar({ filter = "my", onFilterChange, directories = [], directoryFilter, onDirectoryFilterChange, isMobileOpen = false, onMobileClose }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isDashboard = pathname === "/dashboard" || pathname?.startsWith("/dashboard/");
  const isTimeline = pathname === "/timeline" || pathname?.startsWith("/timeline/");

  const favorites = useQuery(api.conversations.listFavorites);
  const { conversations } = useQuery(api.conversations.listConversations, { filter: "my", limit: 50 }) ?? { conversations: [] };

  const handleFilterClick = (newFilter: "my" | "team") => {
    if (!isDashboard) {
      router.push("/dashboard");
    }
    onFilterChange?.(newFilter);
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
  const groupedSessions = conversations?.reduce<Record<string, ConversationItem[]>>((acc, conv) => {
    const group = getDateGroup(conv.updated_at);
    if (!acc[group]) acc[group] = [];
    acc[group].push(conv);
    return acc;
  }, {}) ?? {};

  const sidebarContent = (
    <>
      <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
        <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2">
          Conversations
        </div>
        <div className="space-y-1">
          <button
            onClick={() => handleFilterClick("my")}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none text-left ${
              isDashboard && filter === "my"
                ? "bg-sol-bg-alt text-sol-text"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span>Private</span>
          </button>
          <button
            onClick={() => handleFilterClick("team")}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none text-left ${
              isDashboard && filter === "team"
                ? "bg-sol-bg-alt text-sol-text"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span>Team</span>
          </button>
          <Link
            href="/timeline"
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none ${
              isTimeline
                ? "bg-sol-bg-alt text-sol-text"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Timeline</span>
          </Link>
        </div>

        {favorites && favorites.length > 0 && (
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

        {directories.length > 0 && (
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
                      ? "bg-sol-bg-alt text-sol-text"
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

        {conversations && conversations.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2">
              Recent Sessions
            </div>
            <div className="space-y-2">
              {["Today", "Yesterday", "This Week", "This Month", "Older"].map((group) => {
                const items = groupedSessions[group];
                if (!items || items.length === 0) return null;
                return (
                  <div key={group}>
                    <div className="text-[10px] font-medium text-sol-text-dim px-3 py-0.5">{group}</div>
                    <div className="space-y-0.5">
                      {items.slice(0, group === "Today" ? 10 : 5).map((conv) => (
                        <Link
                          key={conv._id}
                          href={`/conversation/${conv._id}`}
                          onClick={onMobileClose}
                          className={`flex items-center gap-2 px-3 py-1 rounded text-sm transition-colors group ${
                            pathname === `/conversation/${conv._id}`
                              ? "bg-sol-bg-alt text-sol-text"
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

      <div className="pt-4 space-y-1 flex-shrink-0">
        <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2">
          Configuration
        </div>
        {bottomNavItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => onMobileClose?.()}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none ${
              pathname === item.href || pathname?.startsWith(item.href + "/")
                ? "bg-sol-bg-alt text-sol-text"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        ))}
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
          w-64 sm:w-72 md:w-64 border-r border-sol-border bg-sol-bg-alt/50 h-[calc(100vh-52px)] p-3 sm:p-4 flex flex-col sticky top-[52px]
          md:flex
          ${isMobileOpen ? 'fixed top-[52px] left-0 z-40 w-[85vw] max-w-xs' : 'hidden'}
        `}
      >
        {sidebarContent}
      </nav>
    </>
  );
}
