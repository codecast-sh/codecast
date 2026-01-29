"use client";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { cleanTitle, isSystemMessage } from "../lib/conversationProcessor";
import { shouldShowSession, isSubagent, isTrivialSubagent, isWarmupSession } from "../lib/sessionFilters";
import { useConversationsWithError } from "../hooks/useConversationsWithError";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

type Conversation = {
  _id: string;
  user_id: string;
  title?: string;
  subtitle?: string | null;
  first_user_message?: string;
  first_assistant_message?: string;
  message_alternates?: Array<{ role: "user" | "assistant"; content: string }>;
  tool_names?: string[];
  subagent_types?: string[];
  agent_type?: string;
  model?: string | null;
  slug?: string | null;
  started_at: number;
  updated_at: number;
  duration_ms: number;
  message_count?: number;
  ai_message_count?: number;
  tool_call_count?: number;
  is_active: boolean;
  author_name: string;
  is_own: boolean;
  parent_conversation_id?: string | null;
  children?: Conversation[];
  latest_todos?: { todos: Array<{ status: string; content: string; activeForm?: string }>; timestamp: number };
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
  is_favorite?: boolean;
  fork_count?: number;
  forked_from?: string | null;
  is_private?: boolean;
  auto_shared?: boolean;
  visibility_mode?: "full" | "detailed" | "summary" | "minimal";
  activity_summary?: string;
  author_avatar?: string | null;
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
  if (count < 10) return "bg-sol-bg-alt/60 text-sol-text-muted0 border-sol-border/40";
  if (count < 30) return "bg-sol-bg-alt/80 text-sol-text-muted border-sol-border/50";
  if (count < 100) return "bg-blue-500/20 text-blue-400 border-blue-600/40";
  if (count < 200) return "bg-blue-500/30 text-blue-400 border-blue-500/50";
  return "bg-indigo-500/30 text-indigo-400 border-indigo-500/50";
}

function TodoBadge({ todos }: { todos: Array<{ status: string; content: string; activeForm?: string }> }) {
  const [showTooltip, setShowTooltip] = useState(false);
  const completed = todos.filter(t => t.status === 'completed').length;
  const activeTodo = todos.find(t => t.status === 'in_progress');

  return (
    <div className="relative inline-block">
      <span
        className="inline-flex items-center gap-1 text-sol-green cursor-default"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        {activeTodo ? (
          <span className="text-sol-text-secondary text-xs truncate max-w-[120px]">
            {activeTodo.activeForm || activeTodo.content}
          </span>
        ) : (
          <span>{completed}/{todos.length}</span>
        )}
      </span>
      {showTooltip && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-sol-bg border border-sol-border rounded p-2 min-w-[180px] max-w-xs shadow-lg">
          <div className="space-y-1">
            {todos.map((todo, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                {todo.status === 'completed' ? (
                  <svg className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : todo.status === 'in_progress' ? (
                  <svg className="w-3 h-3 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <circle cx="12" cy="12" r="9" strokeWidth={2} />
                  </svg>
                )}
                <span className={`${
                  todo.status === 'completed' ? 'text-sol-text-dim line-through' :
                  todo.status === 'in_progress' ? 'text-sol-text' :
                  'text-sol-text-muted'
                }`}>
                  {todo.content}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ClaudeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
    </svg>
  );
}

function OpenAIIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function AgentIcon({ agentType, className = "w-4 h-4" }: { agentType: string; className?: string }) {
  if (agentType === "claude_code") {
    return <ClaudeIcon className={`${className} text-amber-400`} />;
  } else if (agentType === "codex_cli") {
    return <OpenAIIcon className={`${className} text-emerald-400`} />;
  }
  return null;
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
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";

  const date = new Date(timestamp);

  if (diffDays < 7) {
    return date.toLocaleDateString("en-US", { weekday: "long" });
  }

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

function getAgentTypeLabel(agentType: string): string {
  if (agentType === "claude_code") return "Claude Code";
  if (agentType === "codex_cli") return "Codex CLI";
  return agentType;
}

function createConversationAriaLabel(conv: Conversation): string {
  const title = cleanTitle(conv.title || "Untitled");
  const agentType = getAgentTypeLabel(conv.agent_type || "claude_code");
  const time = getRelativeTime(conv.updated_at);
  const status = conv.is_active ? ", active" : "";
  return `${title}, ${agentType}, ${time}${status}`;
}

type TimeFilter = "all" | "long" | "active";
type SubagentFilter = "all" | "main" | "subagent";

interface ConversationListProps {
  filter: "my" | "team";
  directoryFilter?: string | null;
  memberFilter?: string | null;
  onMemberFilterChange?: (memberId: string | null) => void;
}

export function ConversationList({ filter, directoryFilter, memberFilter, onMemberFilterChange }: ConversationListProps) {
  const router = useRouter();
  const { conversations, hasMore, loadMore, isLoadingMore, isLoading } = useConversationsWithError(filter, memberFilter);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [subagentFilter, setSubagentFilter] = useState<SubagentFilter>("main");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const user = useQuery(api.users.getCurrentUser);
  const toggleFavorite = useMutation(api.conversations.toggleFavorite);
  const setPrivacy = useMutation(api.conversations.setPrivacy);
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );
  const hasTeammates = teamMembers && teamMembers.length > 1;

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const { filteredConversations, counts, directories } = useMemo(() => {
    if (!conversations || conversations.length === 0) return { filteredConversations: [], counts: { long: 0, active: 0, subagent: 0, main: 0 }, directories: [] };
    const convs = conversations as Conversation[];

    const nonTrivialConvs = convs.filter(c => {
      // For summary/minimal visibility, don't filter by title (they intentionally don't have titles)
      if (c.visibility_mode === "summary" || c.visibility_mode === "minimal") {
        return !isTrivialSubagent(c) && !isWarmupSession(c);
      }
      // For team view, filter out default-titled sessions from others
      return shouldShowSession(c, { excludeDefaultTitles: filter === "team" && !c.is_own });
    });

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

    // memberFilter is now handled server-side for proper pagination

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
  }, [conversations, filter, timeFilter, subagentFilter, directoryFilter]);

  const flatConversations = useMemo(() => {
    const flat: Conversation[] = [];
    filteredConversations.forEach((conv) => {
      flat.push(conv);
      if (conv.children && conv.children.length > 0) {
        flat.push(...conv.children);
      }
    });
    return flat;
  }, [filteredConversations]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatConversations.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => {
          if (prev < flatConversations.length - 1) {
            return prev + 1;
          }
          return prev;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => {
          if (prev > 0) {
            return prev - 1;
          }
          return prev;
        });
      } else if (e.key === "Enter" && focusedIndex >= 0) {
        e.preventDefault();
        const conversation = flatConversations[focusedIndex];
        if (conversation) {
          router.push(`/conversation/${conversation._id}`);
        }
      }
    },
    [flatConversations, focusedIndex, router]
  );

  useEffect(() => {
    if (focusedIndex === -1 && flatConversations.length > 0 && document.activeElement === listRef.current) {
      setFocusedIndex(0);
    }
  }, [focusedIndex, flatConversations.length]);

  if (isLoading && conversations.length === 0) {
    return <LoadingSkeleton />;
  }

  if (!isLoading && conversations.length === 0) {
    if (filter === "team") {
      return (
        <EmptyState
          title="No team conversations yet"
          description="Your team hasn't synced any conversations. Invite team members to start sharing conversations."
          action={{
            label: "Invite team members",
            href: "/settings/team",
          }}
        />
      );
    }

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
    <div
      ref={listRef}
      className="space-y-6"
      tabIndex={0}
      role="list"
      aria-label="Conversation list"
      onKeyDown={handleKeyDown}
      onFocus={() => {
        if (focusedIndex === -1 && flatConversations.length > 0) {
          setFocusedIndex(0);
        }
      }}
      onBlur={() => setFocusedIndex(-1)}>
      {/* Filter bar */}
      <div className="flex flex-wrap gap-1.5 sm:gap-2 items-center pt-2">
        {/* Time filters */}
        <button
          onClick={() => setTimeFilter("all")}
          className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
            timeFilter === "all"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          All
        </button>
        <button
          onClick={() => setTimeFilter("long")}
          className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
            timeFilter === "long"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          <span className="hidden sm:inline">Long Running</span>
          <span className="sm:hidden">Long</span>
          {counts.long > 0 && ` (${counts.long})`}
        </button>
        <button
          onClick={() => setTimeFilter("active")}
          className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
            timeFilter === "active"
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          Active{counts.active > 0 && ` (${counts.active})`}
        </button>

        {/* Member filter (team only) */}
        {filter === "team" && teamMembers && teamMembers.length > 0 && (
          <>
            <div className="w-px bg-sol-border/30 mx-1" />
            <select
              value={memberFilter || ""}
              onChange={(e) => onMemberFilterChange?.(e.target.value || null)}
              className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
                memberFilter
                  ? "bg-purple-500/20 text-purple-400 border border-purple-500/40"
                  : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border"
              }`}
            >
              <option value="">All Members</option>
              {teamMembers.map((member) => (
                <option key={member._id} value={member._id}>
                  {member.name || member.email}
                </option>
              ))}
            </select>
          </>
        )}

        <div className="w-px bg-sol-border/30 mx-1" />

        {/* Subagent filters */}
        <button
          onClick={() => setSubagentFilter(subagentFilter === "main" ? "all" : "main")}
          className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
            subagentFilter === "main"
              ? "bg-sol-blue/20 text-sol-blue border border-sol-blue/40"
              : "bg-sol-bg-alt/40 text-sol-text-muted border border-sol-border/30 hover:border-sol-border/50"
          }`}
        >
          Main{counts.main > 0 && ` (${counts.main})`}
        </button>
        <button
          onClick={() => setSubagentFilter(subagentFilter === "subagent" ? "all" : "subagent")}
          className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
            subagentFilter === "subagent"
              ? "bg-sol-violet/20 text-sol-violet border border-sol-violet/40"
              : "bg-sol-bg-alt/40 text-sol-text-muted border border-sol-border/30 hover:border-sol-border/50"
          }`}
        >
          <span className="hidden sm:inline">Subagent</span>
          <span className="sm:hidden">Sub</span>
          {counts.subagent > 0 && ` (${counts.subagent})`}
        </button>
      </div>

      {/* Screen reader announcement for focused item */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {focusedIndex >= 0 && focusedIndex < flatConversations.length && (
          `Selected: ${createConversationAriaLabel(flatConversations[focusedIndex])}`
        )}
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
            {group.conversations.map((conv) => {
              const convIndex = flatConversations.findIndex(c => c._id === conv._id);
              const isFocused = convIndex === focusedIndex;

              if (conv.visibility_mode === "summary" || conv.visibility_mode === "minimal") {
                return (
                  <div
                    key={conv._id}
                    className="relative bg-sol-bg-alt/30 border border-sol-border/30 rounded-lg p-3"
                    role="listitem"
                  >
                    <div className="flex items-center gap-3">
                      {conv.author_avatar ? (
                        <img
                          src={conv.author_avatar}
                          alt={conv.author_name}
                          className="w-6 h-6 rounded-full shrink-0"
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-sol-base02 flex items-center justify-center shrink-0">
                          <span className="text-xs text-sol-text-muted">{conv.author_name?.charAt(0).toUpperCase()}</span>
                        </div>
                      )}
                      <span className="font-medium text-sol-text text-sm">{conv.author_name}</span>
                      {conv.is_active && (
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      )}
                      <span className="text-sol-text-muted text-sm">{conv.activity_summary}</span>
                      <span className="text-sol-text-dim text-xs ml-auto">{getRelativeTime(conv.updated_at)}</span>
                    </div>
                  </div>
                );
              }

              return (
                <Link
                  key={conv._id}
                  href={conv.visibility_mode === "detailed" ? "#" : `/conversation/${conv._id}`}
                  className={`group block relative ${conv.visibility_mode === "detailed" ? "cursor-default" : ""}`}
                  role="listitem"
                  aria-label={createConversationAriaLabel(conv)}
                  aria-current={isFocused ? "true" : undefined}
                  onClick={conv.visibility_mode === "detailed" ? (e) => e.preventDefault() : undefined}
                >
                  <div className={`relative bg-white dark:bg-sol-bg-alt/60 border rounded-lg sm:rounded-xl p-2.5 sm:p-3 md:p-4 transition-all duration-200 shadow-sm dark:shadow-none ${
                    conv.visibility_mode === "detailed"
                      ? "border-sol-border/30 opacity-80"
                      : isFocused
                        ? "ring-2 ring-sol-yellow border-sol-yellow/60 hover:border-sol-yellow/50 hover:shadow-md"
                        : "border-sol-border/40 hover:border-sol-yellow/50 hover:shadow-md"
                  }`}>
                  <div className="flex items-start justify-between gap-2 sm:gap-3 md:gap-4 overflow-hidden">
                    <div className="flex-1 min-w-0">
                      {/* Header row: title + timestamp */}
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <AgentIcon agentType={conv.agent_type || "claude_code"} className="w-4 h-4 shrink-0" />
                          <span className={`font-medium text-base transition-colors truncate ${
                            conv.visibility_mode === "detailed"
                              ? "text-sol-text-muted"
                              : "text-sol-text group-hover:text-sol-yellow"
                          }`}>
                            {cleanTitle(conv.title || "Untitled")}
                          </span>
                          {conv.is_active && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-green/20 border border-sol-green/50 shrink-0">
                              <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
                              <span className="text-[10px] text-sol-green font-semibold">LIVE</span>
                            </span>
                          )}
                        </div>
                        {conv.is_own && hasTeammates && (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setPrivacy({ conversation_id: conv._id as Id<"conversations">, is_private: !conv.is_private });
                            }}
                            className={`p-1 rounded transition-colors flex-shrink-0 ${
                              !conv.is_private
                                ? "text-emerald-400 hover:text-emerald-300"
                                : "text-sol-text-dim/30 hover:text-sol-text-muted opacity-0 group-hover:opacity-100"
                            }`}
                            title={conv.is_private ? "Share with team" : "Make private"}
                          >
                            {conv.is_private ? (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                              </svg>
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                              </svg>
                            )}
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleFavorite({ conversation_id: conv._id as Id<"conversations"> });
                          }}
                          className={`p-1 rounded transition-colors flex-shrink-0 ${
                            conv.is_favorite
                              ? "text-amber-400 hover:text-amber-300"
                              : "text-sol-text-dim/30 hover:text-amber-400 opacity-0 group-hover:opacity-100"
                          }`}
                          title={conv.is_favorite ? "Remove from favorites" : "Add to favorites"}
                        >
                          <svg className="w-4 h-4" fill={conv.is_favorite ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                          </svg>
                        </button>
                        <span className="text-[11px] text-sol-text-dim/50 shrink-0">
                          {getRelativeTime(conv.updated_at)}
                        </span>
                      </div>

                      {/* Subtitle */}
                      {conv.subtitle && (
                        <p className="text-sm text-sol-text-muted mb-2 line-clamp-4 whitespace-pre-line">{conv.subtitle}</p>
                      )}

                      {(() => {
                        const alternates = conv.message_alternates || [];
                        if (alternates.length === 0) return null;

                        const clean = (c: string) => c?.replace(/<[^>]+>/g, "").replace(/^\s*Caveat:.*$/gm, "").trim() || "";

                        const processed = alternates
                          .map(m => ({ ...m, cleanContent: clean(m.content) }))
                          .filter(m => m.cleanContent.length > 0 && !isSystemMessage(m.cleanContent));

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
                        {(filter === "team" || !conv.is_own) && (
                          <span className="flex items-center gap-1.5 font-medium">
                            {conv.author_avatar ? (
                              <img
                                src={conv.author_avatar}
                                alt={conv.author_name}
                                className="w-4 h-4 rounded-full"
                              />
                            ) : (
                              <span className="w-4 h-4 rounded-full bg-sol-base02 flex items-center justify-center text-[8px] text-sol-text-muted">
                                {conv.author_name?.charAt(0).toUpperCase()}
                              </span>
                            )}
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
                        {(conv.message_count ?? 0) > 0 && (
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border ${getMessageCountColor(conv.message_count ?? 0)}`}>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            <span className="text-[10px] font-semibold">{conv.message_count}</span>
                          </span>
                        )}
                        {conv.latest_todos && conv.latest_todos.todos.length > 0 && (
                          <TodoBadge todos={conv.latest_todos.todos} />
                        )}
                        {((conv.fork_count ?? 0) > 0 || conv.forked_from) && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/30"
                            title={conv.forked_from ? "This is a fork" : `${conv.fork_count} fork${conv.fork_count === 1 ? '' : 's'}`}
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                            </svg>
                            {conv.forked_from ? "fork" : conv.fork_count}
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
              );
            })}
            {/* Render children (subagents) indented */}
            {group.conversations.map((conv) =>
              conv.children && conv.children.length > 0 && (
                <div key={`children-${conv._id}`} className="ml-6 border-l-2 border-violet-600/30 pl-3 space-y-2">
                  {conv.children.map((child) => {
                    const childIndex = flatConversations.findIndex(c => c._id === child._id);
                    const isChildFocused = childIndex === focusedIndex;
                    return (
                      <Link
                        key={child._id}
                        href={`/conversation/${child._id}`}
                        className="group block relative"
                        role="listitem"
                        aria-label={`Subagent: ${createConversationAriaLabel(child)}`}
                        aria-current={isChildFocused ? "true" : undefined}
                      >
                        <div className={`relative bg-white dark:bg-sol-bg-alt/60 border rounded-lg p-3 hover:border-violet-500/50 transition-all duration-200 shadow-sm hover:shadow-md dark:shadow-none ${
                          isChildFocused
                            ? "ring-2 ring-sol-yellow border-sol-yellow/60"
                            : "border-sol-border/40"
                        }`}>
                        <div className="flex items-center gap-2 mb-1">
                          <AgentIcon agentType={child.agent_type || "claude_code"} className="w-3.5 h-3.5 shrink-0" />
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
                          {(child.message_count ?? 0) > 0 && (
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border ${getMessageCountColor(child.message_count ?? 0)}`}>
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                              </svg>
                              <span className="text-[10px] font-semibold">{child.message_count}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </Link>
                    );
                  })}
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
