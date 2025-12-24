"use client";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { useEffect, useState, useMemo } from "react";
import { cleanTitle } from "../lib/conversationProcessor";
import { useConversationsWithError } from "../hooks/useConversationsWithError";

type Conversation = {
  _id: string;
  title: string;
  subtitle?: string | null;
  first_user_message?: string;
  first_assistant_message?: string;
  message_alternates?: Array<{ role: "user" | "assistant"; content: string }>;
  tool_names?: string[];
  subagent_types?: string[];
  agent_type: string;
  model?: string | null;
  slug?: string | null;
  started_at: number;
  updated_at: number;
  duration_ms: number;
  message_count: number;
  ai_message_count?: number;
  tool_call_count: number;
  is_active: boolean;
  author_name: string;
  is_own: boolean;
  parent_conversation_id?: string | null;
  children?: Conversation[];
  latest_todos?: { todos: Array<{ status: string }>; timestamp: number };
  latest_usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreation: number;
    cacheRead: number;
    contextSize: number;
    timestamp: number;
  };
  project_path?: string | null;
  git_root?: string | null;
};

function formatDuration(ms: number): string {
  if (ms < 60000) return "<1m";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function getDurationColor(ms: number): string {
  const minutes = ms / 60000;
  if (minutes < 5) return "text-sol-text-muted0 border-sol-border/40";
  if (minutes < 20) return "text-sol-text-muted border-sol-border/50";
  if (minutes < 60) return "text-amber-500/80 border-amber-600/40";
  if (minutes < 120) return "text-amber-400 border-amber-500/50";
  return "text-orange-400 border-orange-500/50";
}

function getMessageCountColor(count: number): string {
  if (count < 10) return "text-sol-text-muted0 border-sol-border/40";
  if (count < 30) return "text-sol-text-muted border-sol-border/50";
  if (count < 100) return "text-blue-400/80 border-blue-600/40";
  if (count < 200) return "text-blue-400 border-blue-500/50";
  return "text-indigo-400 border-indigo-500/50";
}

function ClaudeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
    </svg>
  );
}

type TimeGroup = {
  label: string;
  conversations: Conversation[];
};

function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes === 1) return "1 minute ago";
  if (diffMinutes < 60) return `${diffMinutes} minutes ago`;
  if (diffHours === 1) return "1 hour ago";
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return "yesterday";

  const date = new Date(timestamp);
  const thisYear = new Date().getFullYear();
  if (date.getFullYear() === thisYear) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function groupByTime(conversations: Conversation[]): TimeGroup[] {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const sixHoursAgo = now - 6 * 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const groups: TimeGroup[] = [
    { label: "Last Hour", conversations: [] },
    { label: "Last 6 Hours", conversations: [] },
    { label: "Last 24 Hours", conversations: [] },
    { label: "This Week", conversations: [] },
    { label: "Older", conversations: [] },
  ];

  conversations.forEach((conv) => {
    if (conv.updated_at >= oneHourAgo) {
      groups[0].conversations.push(conv);
    } else if (conv.updated_at >= sixHoursAgo) {
      groups[1].conversations.push(conv);
    } else if (conv.updated_at >= oneDayAgo) {
      groups[2].conversations.push(conv);
    } else if (conv.updated_at >= weekAgo) {
      groups[3].conversations.push(conv);
    } else {
      groups[4].conversations.push(conv);
    }
  });

  return groups.filter((g) => g.conversations.length > 0);
}

type TimeFilter = "all" | "long" | "active";
type SubagentFilter = "all" | "main" | "subagent";

interface ConversationListProps {
  filter: "my" | "team";
  directoryFilter?: string | null;
  onDirectoriesChange?: (directories: string[]) => void;
}

export function ConversationList({ filter, directoryFilter, onDirectoriesChange }: ConversationListProps) {
  const { conversations, hasMore, loadMore, isLoadingMore, isLoading } = useConversationsWithError(filter);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [subagentFilter, setSubagentFilter] = useState<SubagentFilter>("main");

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const { filteredConversations, counts, directories } = useMemo(() => {
    if (!conversations || conversations.length === 0) return { filteredConversations: [], counts: { long: 0, active: 0, subagent: 0, main: 0 }, directories: [] };
    const convs = conversations as Conversation[];

    const isSubagent = (c: Conversation) =>
      c.title?.startsWith("Session agent-") ?? false;
    const isTrivialSubagent = (c: Conversation) => {
      if (!isSubagent(c)) return false;
      const userMsgCount = c.message_alternates?.filter(m => m.role === "user").length ?? 0;
      const aiMsgCount = c.message_alternates?.filter(m => m.role === "assistant").length ?? 0;
      if (c.ai_message_count !== undefined) {
        return c.ai_message_count <= 1 && userMsgCount === 0;
      }
      return aiMsgCount <= 1 && userMsgCount === 0;
    };

    const isWarmupSession = (c: Conversation) => {
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

    const nonTrivialConvs = convs.filter(c => !isTrivialSubagent(c) && !isWarmupSession(c));

    // Derive git root from project_path if git_root is not set
    // Common patterns: /Users/x/src/repo, /home/x/projects/repo, etc.
    const deriveGitRoot = (c: Conversation): string | null => {
      if (c.git_root) return c.git_root;
      if (!c.project_path) return null;

      // Try to find repo root from path
      const parts = c.project_path.split('/');
      // Look for common source directories
      const srcIndex = parts.findIndex(p => p === 'src' || p === 'projects' || p === 'repos' || p === 'code');
      if (srcIndex >= 0 && srcIndex < parts.length - 1) {
        // Return path up to and including the first directory after src/
        return parts.slice(0, srcIndex + 2).join('/');
      }
      // Fallback: use project_path as-is
      return c.project_path;
    };

    const dirLastUpdated = new Map<string, number>();
    for (const c of nonTrivialConvs) {
      const dir = deriveGitRoot(c);
      if (dir) {
        const existing = dirLastUpdated.get(dir) || 0;
        if (c.updated_at > existing) {
          dirLastUpdated.set(dir, c.updated_at);
        }
      }
    }
    const directories = Array.from(dirLastUpdated.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([path]) => path);

    const counts = {
      long: nonTrivialConvs.filter(c => c.duration_ms >= 20 * 60 * 1000).length,
      active: nonTrivialConvs.filter(c => c.is_active).length,
      subagent: nonTrivialConvs.filter(c => isSubagent(c)).length,
      main: nonTrivialConvs.filter(c => !isSubagent(c)).length,
    };

    let filtered = nonTrivialConvs;

    if (directoryFilter) {
      filtered = filtered.filter(c => deriveGitRoot(c) === directoryFilter);
    }

    if (timeFilter === "long") {
      filtered = filtered.filter(c => c.duration_ms >= 20 * 60 * 1000);
    } else if (timeFilter === "active") {
      filtered = filtered.filter(c => c.is_active);
    }

    if (subagentFilter === "main") {
      filtered = filtered.filter(c => !isSubagent(c));
    } else if (subagentFilter === "subagent") {
      filtered = filtered.filter(c => isSubagent(c));
    }

    // Build parent-child map for nesting
    const childrenMap = new Map<string, Conversation[]>();
    const topLevel: Conversation[] = [];

    for (const conv of filtered) {
      if (conv.parent_conversation_id) {
        const children = childrenMap.get(conv.parent_conversation_id) || [];
        children.push(conv);
        childrenMap.set(conv.parent_conversation_id, children);
      } else {
        topLevel.push(conv);
      }
    }

    // Attach children to parents, or promote orphans to top level
    const withChildren = topLevel.map(conv => ({
      ...conv,
      children: childrenMap.get(conv._id) || [],
    }));

    // Find orphan children (parent not in current filtered set)
    const parentIds = new Set(topLevel.map(c => c._id));
    for (const [parentId, children] of childrenMap) {
      if (!parentIds.has(parentId)) {
        // Parent not visible, show children at top level
        for (const child of children) {
          withChildren.push({ ...child, children: [] });
        }
      }
    }

    // Sort by updated_at descending
    withChildren.sort((a, b) => b.updated_at - a.updated_at);

    filtered = withChildren as any;

    return { filteredConversations: filtered, counts, directories };
  }, [conversations, timeFilter, subagentFilter, directoryFilter]);

  useEffect(() => {
    if (onDirectoriesChange && directories.length > 0) {
      onDirectoriesChange(directories);
    }
  }, [directories, onDirectoriesChange]);

  if (isLoading && conversations.length === 0) {
    return <LoadingSkeleton />;
  }

  if (!isLoading && conversations.length === 0) {
    return (
      <EmptyState
        title="No conversations yet"
        description="Your synced conversations will appear here. Start a conversation in Claude Code or Cursor to see it listed."
        action={{
          label: "Learn how to sync",
          href: "/cli",
        }}
      />
    );
  }

  const groups = groupByTime(filteredConversations);

  return (
    <div className="space-y-6">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2">
        {/* Time filters */}
        <button
          onClick={() => setTimeFilter("all")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            timeFilter === "all"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          All
        </button>
        <button
          onClick={() => setTimeFilter("long")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            timeFilter === "long"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          Long Running{counts.long > 0 && ` (${counts.long})`}
        </button>
        <button
          onClick={() => setTimeFilter("active")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            timeFilter === "active"
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          Active{counts.active > 0 && ` (${counts.active})`}
        </button>

        <div className="w-px bg-sol-border/30 mx-1" />

        {/* Subagent filters */}
        <button
          onClick={() => setSubagentFilter(subagentFilter === "main" ? "all" : "main")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            subagentFilter === "main"
              ? "bg-sol-blue/20 text-sol-blue border border-sol-blue/40"
              : "bg-sol-bg-alt/40 text-sol-text-muted border border-sol-border/30 hover:border-sol-border/50"
          }`}
        >
          Main{counts.main > 0 && ` (${counts.main})`}
        </button>
        <button
          onClick={() => setSubagentFilter(subagentFilter === "subagent" ? "all" : "subagent")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            subagentFilter === "subagent"
              ? "bg-sol-violet/20 text-sol-violet border border-sol-violet/40"
              : "bg-sol-bg-alt/40 text-sol-text-muted border border-sol-border/30 hover:border-sol-border/50"
          }`}
        >
          Subagent{counts.subagent > 0 && ` (${counts.subagent})`}
        </button>
      </div>

      {groups.length === 0 && (
        <div className="text-center py-8 text-sol-text-muted0">
          No conversations match these filters
        </div>
      )}
      {groups.map((group) => (
        <div key={group.label}>
          <div className="pb-2 mb-3">
            <h2 className="text-xs font-medium tracking-wide uppercase text-sol-text-muted0">
              {group.label}
            </h2>
          </div>

          <div className="space-y-3">
            {group.conversations.map((conv) => (
              <Link
                key={conv._id}
                href={`/conversation/${conv._id}`}
                className="group block relative"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-sol-bg-alt/40 to-sol-bg/40 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                <div className="relative bg-sol-bg-alt/40 border border-sol-border/30 rounded-xl p-4 hover:border-sol-yellow/40 transition-all duration-200 backdrop-blur-sm">
                  <div className="flex items-start justify-between gap-4 overflow-hidden">
                    <div className="flex-1 min-w-0">
                      {/* Header row: title + timestamp */}
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-sol-text font-medium text-base group-hover:text-sol-yellow transition-colors truncate">
                            {cleanTitle(conv.title)}
                          </span>
                          {conv.is_active && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-green/20 border border-sol-green/50 shrink-0">
                              <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
                              <span className="text-[10px] text-sol-green font-semibold">LIVE</span>
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-sol-text-dim/50 shrink-0">
                          {getRelativeTime(conv.updated_at).replace(' minutes', ' min').replace(' minute', ' min').replace(' hours', ' hr').replace(' hour', ' hr')}
                        </span>
                      </div>

                      {/* Subtitle */}
                      {conv.subtitle && (
                        <p className="text-sm text-sol-text-muted mb-2 line-clamp-2">{conv.subtitle}</p>
                      )}

                      {(() => {
                        const alternates = conv.message_alternates || [];
                        if (alternates.length === 0) return null;

                        const clean = (c: string) => c?.replace(/<[^>]+>/g, "").replace(/^\s*Caveat:.*$/gm, "").trim() || "";
                        const isToolMsg = (c: string) => c?.startsWith("[Using:") || c?.startsWith("[Request");

                        const processed = alternates
                          .map(m => ({ ...m, cleanContent: clean(m.content) }))
                          .filter(m => m.cleanContent.length > 0 && !isToolMsg(m.cleanContent));

                        if (processed.length === 0) return null;

                        const firstMsgs = processed.slice(0, 2);
                        const lastMsgs = processed.length > 4 ? processed.slice(-2) : [];
                        const showEllipsis = processed.length > 4;

                        const renderMessage = (m: typeof processed[0], key: string) => (
                          <div key={key} className="flex items-start gap-2 min-w-0">
                            {m.role === "assistant" ? (
                              <span className="flex-shrink-0 w-4 h-4 rounded bg-sol-yellow flex items-center justify-center mt-0.5">
                                <ClaudeIcon className="w-2.5 h-2.5 text-sol-bg" />
                              </span>
                            ) : (
                              <span className="flex-shrink-0 w-4 h-4 rounded-full bg-sol-violet/60 flex items-center justify-center mt-0.5 text-[8px] font-medium text-white">
                                {(conv.author_name?.charAt(0) || "U").toUpperCase()}
                              </span>
                            )}
                            <span className="truncate min-w-0 text-sol-text-muted leading-relaxed">{m.cleanContent}</span>
                          </div>
                        );

                        return (
                          <div className="mb-3 space-y-1.5 text-xs overflow-hidden opacity-70">
                            {firstMsgs.map((m, idx) => renderMessage(m, `first-${idx}`))}
                            {showEllipsis && (
                              <div className="flex items-center gap-2 pl-6">
                                <span className="text-sol-text-muted0">...</span>
                              </div>
                            )}
                            {lastMsgs.map((m, idx) => renderMessage(m, `last-${idx}`))}
                          </div>
                        );
                      })()}


                      <div className="flex items-center gap-2 text-xs flex-wrap text-sol-text-muted0">
                        {!conv.is_own && (
                          <span className="font-medium">
                            {conv.author_name}
                          </span>
                        )}
                        {conv.duration_ms > 60000 && (
                          <span className={`inline-flex items-center gap-1 ${getDurationColor(conv.duration_ms).split(' ')[0]}`}>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            {formatDuration(conv.duration_ms)}
                          </span>
                        )}
                        {conv.message_count > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            {conv.message_count}
                          </span>
                        )}
                        {conv.latest_todos && conv.latest_todos.todos.length > 0 && (
                          <span className="inline-flex items-center gap-1 text-sol-green">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            {conv.latest_todos.todos.filter(t => t.status === 'completed').length}/{conv.latest_todos.todos.length}
                          </span>
                        )}
                        {conv.subagent_types && conv.subagent_types.length > 0 && conv.subagent_types.map((type) => (
                          <span
                            key={type}
                            className="inline-flex items-center px-1.5 py-0.5 rounded bg-sol-cyan/20 text-sol-cyan border border-sol-cyan/40 text-[10px] font-mono"
                          >
                            {type}
                          </span>
                        ))}
                        {conv.title?.startsWith("Session agent-") && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-violet-900/40 text-violet-300 border border-violet-600/50 text-[10px] font-medium">
                            Subagent
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
            {/* Render children (subagents) indented */}
            {group.conversations.map((conv) =>
              conv.children && conv.children.length > 0 && (
                <div key={`children-${conv._id}`} className="ml-6 border-l-2 border-violet-600/30 pl-3 space-y-2">
                  {conv.children.map((child) => (
                    <Link
                      key={child._id}
                      href={`/conversation/${child._id}`}
                      className="group block relative"
                    >
                      <div className="relative bg-sol-bg-alt/40 border border-sol-border/60 rounded-lg p-3 hover:border-violet-500/40 transition-all duration-200">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-violet-900/40 text-violet-300 border border-violet-600/50 text-[10px] font-medium">
                            Subagent
                          </span>
                          <h4 className="text-sol-text-secondary text-sm truncate flex-1">
                            {child.title}
                          </h4>
                          {child.is_active && (
                            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-sol-text-muted0">
                          <span>{getRelativeTime(child.updated_at)}</span>
                          {child.duration_ms > 60000 && (
                            <span>{formatDuration(child.duration_ms)}</span>
                          )}
                          <span>{child.message_count} msgs</span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      ))}

      {hasMore && (
        <div className="flex justify-center pt-4 pb-8">
          <button
            onClick={loadMore}
            disabled={isLoadingMore}
            className="px-6 py-2 text-sm font-medium rounded-lg bg-sol-bg-alt border border-sol-border hover:border-amber-500/40 text-sol-text-muted hover:text-sol-text transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoadingMore ? (
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Loading...
              </span>
            ) : (
              "Load more"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
