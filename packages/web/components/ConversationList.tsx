"use client";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { useEffect, useState, useMemo } from "react";

type Conversation = {
  _id: string;
  title: string;
  first_user_message?: string;
  first_assistant_message?: string;
  tool_names?: string[];
  subagent_types?: string[];
  agent_type: string;
  model?: string | null;
  slug?: string | null;
  started_at: number;
  updated_at: number;
  duration_ms: number;
  message_count: number;
  tool_call_count: number;
  is_active: boolean;
  author_name: string;
  is_own: boolean;
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
  if (minutes < 5) return "text-slate-500 border-slate-700/40";
  if (minutes < 20) return "text-slate-400 border-slate-600/50";
  if (minutes < 60) return "text-amber-500/80 border-amber-600/40";
  if (minutes < 120) return "text-amber-400 border-amber-500/50";
  return "text-orange-400 border-orange-500/50";
}

function getMessageCountColor(count: number): string {
  if (count < 10) return "text-slate-500 border-slate-700/40";
  if (count < 30) return "text-slate-400 border-slate-600/50";
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
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const yesterdayMs = todayMs - 86400000;
  const weekAgoMs = todayMs - 7 * 86400000;

  const groups: TimeGroup[] = [
    { label: "Today", conversations: [] },
    { label: "Yesterday", conversations: [] },
    { label: "This Week", conversations: [] },
    { label: "Older", conversations: [] },
  ];

  conversations.forEach((conv) => {
    if (conv.updated_at >= todayMs) {
      groups[0].conversations.push(conv);
    } else if (conv.updated_at >= yesterdayMs) {
      groups[1].conversations.push(conv);
    } else if (conv.updated_at >= weekAgoMs) {
      groups[2].conversations.push(conv);
    } else {
      groups[3].conversations.push(conv);
    }
  });

  return groups.filter((g) => g.conversations.length > 0);
}

type TimeFilter = "all" | "long" | "active";
type SubagentFilter = "all" | "main" | "subagent";

export function ConversationList({ filter }: { filter: "my" | "team" }) {
  const conversations = useQuery(api.conversations.listConversations, {
    filter,
  });
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [subagentFilter, setSubagentFilter] = useState<SubagentFilter>("all");

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

    const counts = {
      long: convs.filter(c => c.duration_ms >= 20 * 60 * 1000).length,
      active: convs.filter(c => c.is_active).length,
      subagent: convs.filter(c => isSubagent(c)).length,
      main: convs.filter(c => !isSubagent(c)).length,
    };

    let filtered = convs;

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
              : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:border-slate-600"
          }`}
        >
          All
        </button>
        <button
          onClick={() => setTimeFilter("long")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            timeFilter === "long"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
              : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:border-slate-600"
          }`}
        >
          Long (&gt;20m){counts.long > 0 && ` (${counts.long})`}
        </button>
        <button
          onClick={() => setTimeFilter("active")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            timeFilter === "active"
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
              : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:border-slate-600"
          }`}
        >
          Active{counts.active > 0 && ` (${counts.active})`}
        </button>

        <div className="w-px bg-slate-700/50 mx-1" />

        {/* Subagent filters */}
        <button
          onClick={() => setSubagentFilter(subagentFilter === "main" ? "all" : "main")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            subagentFilter === "main"
              ? "bg-blue-500/20 text-blue-400 border border-blue-500/40"
              : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:border-slate-600"
          }`}
        >
          Main{counts.main > 0 && ` (${counts.main})`}
        </button>
        <button
          onClick={() => setSubagentFilter(subagentFilter === "subagent" ? "all" : "subagent")}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            subagentFilter === "subagent"
              ? "bg-slate-500/20 text-slate-300 border border-slate-500/40"
              : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:border-slate-600"
          }`}
        >
          Subagent{counts.subagent > 0 && ` (${counts.subagent})`}
        </button>
      </div>

      {groups.length === 0 && (
        <div className="text-center py-8 text-slate-500">
          No conversations match these filters
        </div>
      )}
      {groups.map((group, groupIdx) => (
        <div key={group.label}>
          <div className="pb-3 mb-4">
            <h2 className="text-xs font-medium tracking-wide uppercase text-slate-500 px-1">
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
                <div className="absolute inset-0 bg-gradient-to-br from-slate-800/40 to-slate-900/40 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                <div className="relative bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 hover:border-amber-500/30 transition-all duration-200 backdrop-blur-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        {conv.agent_type === "claude_code" ? (
                          <span className="text-amber-500">
                            <ClaudeLogo className="w-4 h-4" />
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500 font-mono">{conv.agent_type}</span>
                        )}
                        <h3 className="text-slate-100 font-medium text-base truncate group-hover:text-amber-50 transition-colors">
                          {conv.title}
                        </h3>
                        {conv.is_active && (
                          <span className="flex-shrink-0 w-2 h-2 rounded-full bg-emerald-500 animate-pulse" title="Active" />
                        )}
                      </div>

                      {(conv.first_user_message || conv.first_assistant_message) && (
                        <div className="mb-2.5 space-y-1 text-sm">
                          {conv.first_user_message && (
                            <p className="text-slate-300 line-clamp-2 flex items-start gap-2">
                              <span className="text-blue-400 flex-shrink-0 text-xs mt-0.5">you:</span>
                              <span>{conv.first_user_message}</span>
                            </p>
                          )}
                          {conv.first_assistant_message && (
                            <p className="text-slate-400 line-clamp-2 flex items-start gap-2">
                              <span className="text-amber-400/70 flex-shrink-0 text-xs mt-0.5">ai:</span>
                              <span>{conv.first_assistant_message}</span>
                            </p>
                          )}
                        </div>
                      )}

                      {conv.tool_names && conv.tool_names.length > 0 && (
                        <div className="flex items-center gap-1.5 mb-2.5 flex-wrap">
                          {conv.tool_names.slice(0, 4).map((name) => (
                            <span
                              key={name}
                              className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-400 text-[10px] font-mono border border-slate-700/40"
                            >
                              {name}
                            </span>
                          ))}
                          {conv.tool_names.length > 4 && (
                            <span className="text-[10px] text-slate-500">
                              +{conv.tool_names.length - 4}
                            </span>
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-2 text-xs flex-wrap">
                        {!conv.is_own && (
                          <span className="text-slate-400 font-medium">
                            {conv.author_name}
                          </span>
                        )}
                        <span className="text-slate-500">
                          {getRelativeTime(conv.updated_at)}
                        </span>
                        {conv.duration_ms > 60000 && (
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800/60 border ${getDurationColor(conv.duration_ms)}`}>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            {formatDuration(conv.duration_ms)}
                          </span>
                        )}
                        {conv.message_count > 0 && (
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800/60 border ${getMessageCountColor(conv.message_count)}`}>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            {conv.message_count}
                          </span>
                        )}
                        {conv.tool_call_count > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-500 border border-slate-700/40">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
                            </svg>
                            {conv.tool_call_count}
                          </span>
                        )}
                        {conv.subagent_types && conv.subagent_types.length > 0 && conv.subagent_types.map((type) => (
                          <span
                            key={type}
                            className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-400 border border-emerald-700/40 text-[10px] font-mono"
                          >
                            {type}
                          </span>
                        ))}
                        {conv.title?.startsWith("Session agent-") && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-400 border border-slate-600/40 text-[10px]">
                            subagent
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
