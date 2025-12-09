"use client";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { getConversationPreview, cleanTitle } from "../lib/conversationProcessor";
import { useUIStore } from "../store/uiStore";
import { UsageBadge } from "./UsageDisplay";
import { useConversationsWithError } from "../hooks/useConversationsWithError";
import { useRouter } from "next/navigation";

type Conversation = {
  _id: string;
  title: string;
  first_user_message?: string;
  first_assistant_message?: string;
  message_alternates?: Array<{ role: "user" | "assistant"; content: string }>;
  tool_names?: string[];
  subagent_types?: string[];
  agent_type: string;
  model?: string | null;
  slug?: string | null;
  project_hash?: string;
  project_path?: string | null;
  git_branch?: string | null;
  git_remote_url?: string | null;
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

function ClaudeLogo({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.709 15.955l4.72-2.647.08-.08 2.726-4.721c.398-.65 1.063-1.063 1.808-1.063h.08c.744 0 1.409.413 1.807 1.063l2.727 4.72.079.08 4.72 2.728c.65.398 1.063 1.063 1.063 1.808v.08c0 .744-.413 1.409-1.063 1.807l-4.72 2.727-.08.08-2.727 4.72c-.398.65-1.063 1.063-1.808 1.063h-.08c-.744 0-1.409-.413-1.807-1.063l-2.727-4.72-.079-.08-4.72-2.727c-.65-.398-1.063-1.063-1.063-1.808v-.08c0-.744.413-1.409 1.063-1.807zm7.248-1.41l-1.33 2.302 2.302 1.33c.16.08.319.08.479 0l2.302-1.33-1.33-2.302c-.08-.16-.08-.319 0-.479l1.33-2.302-2.302-1.33c-.16-.08-.319-.08-.479 0l-2.302 1.33 1.33 2.302c.08.16.08.319 0 .479z" />
    </svg>
  );
}

type ConversationGroup =
  | { type: 'active-group'; title: string; conversations: Conversation[]; groupId: string }
  | { type: 'project-group'; title: string; projectHash: string; displayPath: string; conversations: Conversation[]; groupId: string };

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

function deriveDisplayPath(projectHash: string | undefined, conversations: Conversation[]): string {
  if (!projectHash) return 'No Project';

  const firstConv = conversations[0];

  if (firstConv?.project_path) {
    const parts = firstConv.project_path.split('/');
    return parts[parts.length - 1] || parts[parts.length - 2] || firstConv.project_path;
  }

  if (firstConv?.title) {
    const match = firstConv.title.match(/\[(.*?)\]/);
    if (match) return match[1];
  }

  return `proj-${projectHash.slice(0, 6)}`;
}

function buildProjectGroups(conversations: Conversation[]): ConversationGroup[] {
  const result: ConversationGroup[] = [];

  const active = conversations.filter(c => c.is_active);
  if (active.length > 0) {
    result.push({
      type: 'active-group',
      title: 'Active',
      conversations: active.sort((a, b) => b.updated_at - a.updated_at),
      groupId: 'active',
    });
  }

  const inactive = conversations.filter(c => !c.is_active);
  const byProject = new Map<string, Conversation[]>();

  for (const conv of inactive) {
    const key = conv.project_hash || '__no_project__';
    const existing = byProject.get(key) || [];
    existing.push(conv);
    byProject.set(key, existing);
  }

  const projectGroups: ConversationGroup[] = [];
  for (const [hash, convs] of byProject) {
    convs.sort((a, b) => b.updated_at - a.updated_at);

    projectGroups.push({
      type: 'project-group',
      title: deriveDisplayPath(hash === '__no_project__' ? undefined : hash, convs),
      projectHash: hash,
      displayPath: deriveDisplayPath(hash === '__no_project__' ? undefined : hash, convs),
      conversations: convs,
      groupId: `project-${hash}`,
    });
  }

  projectGroups.sort((a, b) => {
    const aRecent = Math.max(...a.conversations.map(c => c.updated_at));
    const bRecent = Math.max(...b.conversations.map(c => c.updated_at));
    return bRecent - aRecent;
  });

  result.push(...projectGroups);

  return result;
}

type TimeFilter = "all" | "long" | "active";
type SubagentFilter = "all" | "main" | "subagent";

export function ConversationList({ filter }: { filter: "my" | "team" }) {
  const conversations = useConversationsWithError(filter);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [subagentFilter, setSubagentFilter] = useState<SubagentFilter>("main");
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  const { collapsedSections, toggleSection } = useUIStore();
  const router = useRouter();
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLAnchorElement>>(new Map());

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const { filteredConversations, counts } = useMemo(() => {
    if (!conversations) return { filteredConversations: [], counts: { long: 0, active: 0, subagent: 0, main: 0 } };
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

    const nonTrivialConvs = convs.filter(c => !isTrivialSubagent(c));

    const counts = {
      long: nonTrivialConvs.filter(c => c.duration_ms >= 20 * 60 * 1000).length,
      active: nonTrivialConvs.filter(c => c.is_active).length,
      subagent: nonTrivialConvs.filter(c => isSubagent(c)).length,
      main: nonTrivialConvs.filter(c => !isSubagent(c)).length,
    };

    let filtered = nonTrivialConvs;

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

    filtered = withChildren as any;

    return { filteredConversations: filtered, counts };
  }, [conversations, timeFilter, subagentFilter]);

  if (!conversations) {
    return <LoadingSkeleton />;
  }

  if (conversations.length === 0) {
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

  const groups = buildProjectGroups(filteredConversations);

  const flatConversations = useMemo(() => {
    const flat: Array<{ conv: Conversation; isChild: boolean }> = [];
    for (const group of groups) {
      if (collapsedSections.has(group.groupId)) continue;
      for (const conv of group.conversations) {
        flat.push({ conv, isChild: false });
        if (conv.children && conv.children.length > 0) {
          for (const child of conv.children) {
            flat.push({ conv: child, isChild: true });
          }
        }
      }
    }
    return flat;
  }, [groups, collapsedSections]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (flatConversations.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusedIndex((prev) => {
            const next = prev < flatConversations.length - 1 ? prev + 1 : prev;
            return next;
          });
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedIndex((prev) => {
            const next = prev > 0 ? prev - 1 : prev;
            return next;
          });
          break;
        case "Home":
          e.preventDefault();
          setFocusedIndex(0);
          break;
        case "End":
          e.preventDefault();
          setFocusedIndex(flatConversations.length - 1);
          break;
        case "Enter":
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < flatConversations.length) {
            const { conv } = flatConversations[focusedIndex];
            router.push(`/conversation/${conv._id}`);
          }
          break;
      }
    },
    [flatConversations, focusedIndex, router]
  );

  useEffect(() => {
    if (focusedIndex >= 0 && focusedIndex < flatConversations.length) {
      const { conv } = flatConversations[focusedIndex];
      const element = itemRefs.current.get(conv._id);
      if (element) {
        element.focus();
      }
    }
  }, [focusedIndex, flatConversations]);

  useEffect(() => {
    setFocusedIndex(-1);
  }, [timeFilter, subagentFilter]);

  const setItemRef = useCallback((id: string, element: HTMLAnchorElement | null) => {
    if (element) {
      itemRefs.current.set(id, element);
    } else {
      itemRefs.current.delete(id);
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2">
        {/* Time filters */}
        <button
          onClick={() => setTimeFilter("all")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors motion-reduce:transition-none ${
            timeFilter === "all"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          All
        </button>
        <button
          onClick={() => setTimeFilter("long")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors motion-reduce:transition-none ${
            timeFilter === "long"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          Long Running{counts.long > 0 && ` (${counts.long})`}
        </button>
        <button
          onClick={() => setTimeFilter("active")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors motion-reduce:transition-none ${
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
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors motion-reduce:transition-none ${
            subagentFilter === "main"
              ? "bg-sol-blue/20 text-sol-blue border border-sol-blue/40"
              : "bg-sol-bg-alt/40 text-sol-text-muted border border-sol-border/30 hover:border-sol-border/50"
          }`}
        >
          Main{counts.main > 0 && ` (${counts.main})`}
        </button>
        <button
          onClick={() => setSubagentFilter(subagentFilter === "subagent" ? "all" : "subagent")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors motion-reduce:transition-none ${
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
      <div
        ref={listRef}
        role="listbox"
        aria-label={`Conversation list, ${flatConversations.length} items`}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="space-y-6 focus:outline-none"
      >
      {groups.map((group) => {
        const isCollapsed = collapsedSections.has(group.groupId);
        const isActiveGroup = group.type === 'active-group';

        return (
          <div key={group.groupId}>
            <button
              onClick={() => toggleSection(group.groupId)}
              className="w-full pb-2 mb-3 flex items-center gap-2 hover:opacity-70 transition-opacity motion-reduce:transition-none"
            >
              <svg
                className={`w-4 h-4 transition-transform motion-reduce:transition-none ${isCollapsed ? '-rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
              <h2 className="text-xs font-medium tracking-wide uppercase text-sol-text-muted0 flex-1 text-left">
                {group.title} ({group.conversations.length})
              </h2>
              {isActiveGroup && (
                <span className="w-2 h-2 rounded-full bg-sol-green animate-pulse motion-reduce:animate-none" />
              )}
            </button>

            {!isCollapsed && (

          <div className="space-y-3" role="group">
            {group.conversations.map((conv) => {
              const itemIndex = flatConversations.findIndex(item => item.conv._id === conv._id && !item.isChild);
              const isSelected = itemIndex === focusedIndex;
              const agentTypeLabel = conv.agent_type || 'Unknown';
              const timeLabel = getRelativeTime(conv.updated_at);
              const ariaLabel = `Conversation: ${cleanTitle(conv.title)}, ${agentTypeLabel}, ${timeLabel}`;

              return (
              <Link
                key={conv._id}
                href={`/conversation/${conv._id}`}
                ref={(el) => setItemRef(conv._id, el)}
                role="option"
                aria-label={ariaLabel}
                aria-selected={isSelected}
                tabIndex={-1}
                className="group block relative focus:outline-none focus:ring-2 focus:ring-sol-yellow/60 rounded-xl"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-sol-bg-alt/40 to-sol-bg/40 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300 motion-reduce:transition-none"></div>
                <div className="relative bg-sol-bg-alt/40 border border-sol-border/30 rounded-xl p-4 hover:border-sol-yellow/40 transition-all duration-200 motion-reduce:transition-none backdrop-blur-sm">
                  <div className="flex items-start justify-between gap-4 overflow-hidden">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-2 mb-1.5">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-sol-bg-alt flex items-center justify-center text-[10px] font-medium text-sol-text-secondary mt-0.5">
                          {(conv.author_name?.charAt(0) || "U").toUpperCase()}
                        </span>
                        <div className="flex-1 min-w-0">
                          <span className="text-sol-text font-medium text-base group-hover:text-sol-yellow transition-colors motion-reduce:transition-none">
                            {cleanTitle(conv.title)}
                          </span>
                          {conv.is_active && (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 ml-2 rounded-md bg-sol-green/20 border border-sol-green/60 align-middle">
                              <span className="w-2 h-2 rounded-full bg-sol-green animate-pulse motion-reduce:animate-none" />
                              <span className="text-xs text-sol-green font-semibold tracking-wide">LIVE</span>
                            </span>
                          )}
                          {conv.git_branch && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 ml-2 rounded bg-sol-bg-alt text-sol-text-muted text-[10px] font-mono border border-sol-border/40 align-middle">
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 3v12M18 9a3 3 0 01-3 3H9m0 0l3-3m-3 3l3 3M18 21V9" />
                              </svg>
                              {conv.git_branch}
                            </span>
                          )}
                        </div>
                      </div>

                      {(() => {
                        const messages = getConversationPreview(conv.message_alternates, conv.title, 4);
                        if (messages.length === 0 && conv.first_assistant_message && !conv.first_assistant_message.startsWith("[Using:")) {
                          messages.push({ role: "assistant", content: conv.first_assistant_message, cleanContent: conv.first_assistant_message, isCommand: false });
                        }

                        if (messages.length === 0) return null;
                        return (
                          <div className="mb-2 space-y-0.5 text-xs overflow-hidden opacity-60">
                            {messages.map((m, idx) => (
                              <div key={idx} className="flex items-start gap-1.5 min-w-0">
                                {m.role === "assistant" ? (
                                  <span className="flex-shrink-0 w-3.5 h-3.5 rounded-full bg-sol-yellow/70 flex items-center justify-center mt-0.5">
                                    <ClaudeLogo className="w-2 h-2 text-sol-text/80" />
                                  </span>
                                ) : (
                                  <span className="flex-shrink-0 w-3.5 h-3.5 rounded-full bg-sol-bg-alt flex items-center justify-center mt-0.5 text-[7px] font-medium text-sol-text-muted">
                                    {(conv.author_name?.charAt(0) || "U").toUpperCase()}
                                  </span>
                                )}
                                <span className="truncate min-w-0 text-sol-text-muted">{m.cleanContent}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })()}


                      <div className="flex items-center gap-2 text-xs flex-wrap opacity-70">
                        {!conv.is_own && (
                          <span className="text-sol-text-muted font-medium">
                            {conv.author_name}
                          </span>
                        )}
                        <span className="text-sol-text-muted0">
                          {getRelativeTime(conv.updated_at)}
                        </span>
                        {conv.duration_ms > 60000 && (
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-bg-alt/60 bg-sol-bg-alt border ${getDurationColor(conv.duration_ms)}`}>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            {formatDuration(conv.duration_ms)}
                          </span>
                        )}
                        {conv.message_count > 0 && (
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-bg-alt/60 bg-sol-bg-alt border ${getMessageCountColor(conv.message_count)}`}>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            {conv.message_count}
                          </span>
                        )}
                        {conv.tool_call_count > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-bg-alt/60 bg-sol-bg-alt text-sol-text-muted0 border border-sol-border/40 border-sol-border">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
                            </svg>
                            {conv.tool_call_count}
                          </span>
                        )}
                        {conv.latest_todos && conv.latest_todos.todos.length > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-bg-alt/60 bg-sol-bg-alt text-emerald-400 border border-emerald-500/40">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                            </svg>
                            {conv.latest_todos.todos.filter(t => t.status === 'completed').length}/{conv.latest_todos.todos.length} tasks
                          </span>
                        )}
                        {conv.latest_usage && (
                          <UsageBadge usage={conv.latest_usage} />
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
                    const childIndex = flatConversations.findIndex(item => item.conv._id === child._id && item.isChild);
                    const isChildSelected = childIndex === focusedIndex;
                    const childAgentTypeLabel = child.agent_type || 'Unknown';
                    const childTimeLabel = getRelativeTime(child.updated_at);
                    const childAriaLabel = `Subagent conversation: ${child.title}, ${childAgentTypeLabel}, ${childTimeLabel}`;

                    return (
                    <Link
                      key={child._id}
                      href={`/conversation/${child._id}`}
                      ref={(el) => setItemRef(child._id, el)}
                      role="option"
                      aria-label={childAriaLabel}
                      aria-selected={isChildSelected}
                      tabIndex={-1}
                      className="group block relative focus:outline-none focus:ring-2 focus:ring-violet-500/60 rounded-lg"
                    >
                      <div className="relative bg-sol-bg-alt/40 border border-sol-border/60 rounded-lg p-3 hover:border-violet-500/40 transition-all duration-200 motion-reduce:transition-none">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-violet-900/40 text-violet-300 border border-violet-600/50 text-[10px] font-medium">
                            Subagent
                          </span>
                          <h4 className="text-sol-text-secondary text-sm truncate flex-1">
                            {child.title}
                          </h4>
                          {child.is_active && (
                            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse motion-reduce:animate-none" />
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
                    );
                  })}
                </div>
              )
            )}
          </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}
