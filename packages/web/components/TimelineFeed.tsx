"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useMemo } from "react";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { cleanTitle } from "../lib/conversationProcessor";
import { shouldShowSession } from "../lib/sessionFilters";

type TimelineItem =
  | {
      type: "session";
      id: string;
      title: string;
      subtitle: string | null;
      author_name: string;
      timestamp: number;
      duration_ms: number;
      message_count: number;
      is_active: boolean;
      is_own: boolean;
    }
  | {
      type: "commit";
      id: string;
      sha: string;
      message: string;
      author_name: string;
      timestamp: number;
      files_changed: number;
      insertions: number;
      deletions: number;
      conversation_id?: string;
      repository?: string;
    }
  | {
      type: "pr";
      id: string;
      number: number;
      title: string;
      body: string;
      state: "open" | "closed" | "merged";
      author_github_username: string;
      timestamp: number;
      repository: string;
      additions?: number;
      deletions?: number;
      changed_files?: number;
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
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDuration(ms: number): string {
  if (ms < 60000) return "<1m";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24)
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function ClaudeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
    </svg>
  );
}

function GitIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.11.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function SessionCard({ item }: { item: Extract<TimelineItem, { type: "session" }> }) {
  const cleanedTitle = cleanTitle(item.title);
  return (
    <Link href={`/conversation/${item.id}`} className="group block relative">
      <div className="relative bg-white/60 border border-sol-border/40 rounded-xl p-4 hover:border-sol-yellow/50 transition-all duration-200 shadow-sm hover:shadow-md">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-gradient-to-br from-sol-yellow to-sol-yellow/80 flex items-center justify-center shadow-sm">
            <ClaudeIcon className="w-5 h-5 text-sol-bg" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3 mb-1">
              <div className="min-w-0 flex-1">
                <h3 className="text-sol-text font-medium text-[15px] leading-snug group-hover:text-sol-yellow transition-colors line-clamp-2">
                  {cleanedTitle}
                </h3>
                {item.subtitle && item.subtitle !== cleanedTitle && (
                  <p className="text-sol-text-muted text-xs mt-0.5 line-clamp-3 whitespace-pre-line">{item.subtitle}</p>
                )}
              </div>
              <div className="flex flex-col items-end shrink-0 gap-0.5">
                <span className="text-[11px] text-sol-text-dim/60">
                  {getRelativeTime(item.timestamp)}
                </span>
                {item.is_active && (
                  <span className="text-[10px] text-sol-green font-medium">LIVE</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-sol-text-muted0 flex-wrap">
              {!item.is_own && <span className="font-medium">{item.author_name}</span>}
              {item.is_active && !item.is_own && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-green/20 border border-sol-green/50">
                  <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
                  <span className="text-[10px] text-sol-green font-semibold">LIVE</span>
                </span>
              )}
              {item.duration_ms > 60000 && (
                <span className="inline-flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  {formatDuration(item.duration_ms)}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
                {item.message_count}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

function CommitCard({
  item,
  sessionTitle,
}: {
  item: Extract<TimelineItem, { type: "commit" }>;
  sessionTitle?: string;
}) {
  const shortSha = item.sha.substring(0, 7);
  const commitLines = item.message.split("\n");
  const commitTitle = commitLines[0];
  const repoName = item.repository?.split("/").pop() || null;

  const content = (
    <div className="relative bg-white/60 border border-sol-border/40 rounded-xl p-4 hover:border-sol-violet/50 transition-all duration-200 shadow-sm hover:shadow-md">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-gradient-to-br from-sol-violet to-sol-violet/80 flex items-center justify-center shadow-sm">
          <GitIcon className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3 mb-1.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                {item.repository ? (
                  <a
                    href={`https://github.com/${item.repository}/commit/${item.sha}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-[11px] font-mono text-sol-violet bg-sol-violet/10 px-1.5 py-0.5 rounded border border-sol-violet/20 hover:bg-sol-violet/20 hover:border-sol-violet/40 transition-colors"
                  >
                    {shortSha}
                  </a>
                ) : (
                  <code className="text-[11px] font-mono text-sol-violet bg-sol-violet/10 px-1.5 py-0.5 rounded border border-sol-violet/20">
                    {shortSha}
                  </code>
                )}
                {repoName && (
                  <span className="text-[11px] font-mono text-sol-text-dim/60">{repoName}</span>
                )}
              </div>
              <h3 className="text-sol-text font-medium text-[14px] leading-snug line-clamp-2">
                {commitTitle}
              </h3>
            </div>
            <span className="text-[11px] text-sol-text-dim/60 shrink-0">
              {getRelativeTime(item.timestamp)}
            </span>
          </div>

          <div className="flex items-center gap-3 text-xs text-sol-text-dim/70 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
              {item.author_name}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="text-sol-green font-medium">+{item.insertions}</span>
              <span className="text-sol-red font-medium">-{item.deletions}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              {item.files_changed} {item.files_changed === 1 ? "file" : "files"}
            </span>
            {sessionTitle && (
              <span className="inline-flex items-center gap-1 text-sol-yellow/70">
                <ClaudeIcon className="w-3 h-3" />
                <span className="truncate max-w-[150px]">{sessionTitle}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (item.repository) {
    const [owner, repo] = item.repository.split("/");
    return (
      <Link href={`/commit/${owner}/${repo}/${item.sha}`} className="group block">
        {content}
      </Link>
    );
  }

  if (item.conversation_id) {
    return (
      <Link href={`/conversation/${item.conversation_id}/diff`} className="group block">
        {content}
      </Link>
    );
  }

  return content;
}

function PRIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 6a2 2 0 1 1 4 0 2 2 0 0 1-4 0zm2 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-2 3a2 2 0 1 1 4 0 2 2 0 0 1-4 0zm16-6a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-2 3a2 2 0 1 1 4 0 2 2 0 0 1-4 0zM6.5 7v8h1V7h-1zm12 5v5h-1v-5h1zm-11 1H13v-1H7.5v1zm0 2.5c0-1.5 1.5-2.5 3-2.5h2.5v-1H10.5c-2.25 0-4 1.5-4 3.5v.5h1v-.5z" />
    </svg>
  );
}

function PRCard({ item }: { item: Extract<TimelineItem, { type: "pr" }> }) {
  const repoName = item.repository.split("/").pop() || item.repository;
  const [owner, repo] = item.repository.split("/");

  const stateConfig = {
    open: {
      color: "text-sol-green",
      bgColor: "bg-sol-green/20",
      borderColor: "border-sol-green/30",
      label: "Open",
    },
    merged: {
      color: "text-sol-violet",
      bgColor: "bg-sol-violet/20",
      borderColor: "border-sol-violet/30",
      label: "Merged",
    },
    closed: {
      color: "text-sol-red",
      bgColor: "bg-sol-red/20",
      borderColor: "border-sol-red/30",
      label: "Closed",
    },
  };

  const state = stateConfig[item.state];

  return (
    <Link href={`/pr/${owner}/${repo}/${item.number}`} className="group block">
      <div className="relative bg-white/60 border border-sol-border/40 rounded-xl p-4 hover:border-sol-green/50 transition-all duration-200 shadow-sm hover:shadow-md">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-gradient-to-br from-sol-green to-sol-green/80 flex items-center justify-center shadow-sm">
            <PRIcon className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3 mb-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${state.bgColor} ${state.color} border ${state.borderColor}`}>
                    {state.label}
                  </span>
                  <span className="text-[11px] font-mono text-sol-text-dim/60">#{item.number}</span>
                  <span className="text-[11px] font-mono text-sol-text-dim/60">{repoName}</span>
                </div>
                <h3 className="text-sol-text font-medium text-[14px] leading-snug line-clamp-2 group-hover:text-sol-green transition-colors">
                  {item.title}
                </h3>
              </div>
              <span className="text-[11px] text-sol-text-dim/60 shrink-0">
                {getRelativeTime(item.timestamp)}
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs text-sol-text-dim/70 flex-wrap">
              <span className="inline-flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                  />
                </svg>
                {item.author_github_username}
              </span>
              {item.additions !== undefined && item.deletions !== undefined && (
                <span className="inline-flex items-center gap-1">
                  <span className="text-sol-green font-medium">+{item.additions}</span>
                  <span className="text-sol-red font-medium">-{item.deletions}</span>
                </span>
              )}
              {item.changed_files !== undefined && (
                <span className="inline-flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                  {item.changed_files} {item.changed_files === 1 ? "file" : "files"}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

interface TimelineFeedProps {
  filter: "my" | "team";
  dateRange?: { start?: number; end?: number };
}

export function TimelineFeed({ filter, dateRange }: TimelineFeedProps) {
  const conversations = useQuery(api.conversations.listConversations, { filter });
  const commits = useQuery(api.commits.getCommitsForTimeline, {
    start_time: dateRange?.start,
    end_time: dateRange?.end,
  });
  const prs = useQuery(api.pull_requests.getPRsForTimeline, {});

  const { timelineItems, sessionTitleMap } = useMemo(() => {
    if (!conversations?.conversations || !commits || !prs)
      return { timelineItems: [], sessionTitleMap: new Map<string, string>() };

    const items: TimelineItem[] = [];
    const titleMap = new Map<string, string>();

    for (const conv of conversations.conversations) {
      if (!shouldShowSession(conv)) continue;

      titleMap.set(conv._id, conv.title || "Untitled Session");
      items.push({
        type: "session",
        id: conv._id,
        title: conv.title || "Untitled Session",
        subtitle: conv.subtitle || null,
        author_name: conv.author_name,
        timestamp: conv.updated_at,
        duration_ms: conv.duration_ms,
        message_count: conv.message_count,
        is_active: conv.is_active,
        is_own: conv.is_own,
      });
    }

    for (const commit of commits) {
      items.push({
        type: "commit",
        id: commit._id,
        sha: commit.sha,
        message: commit.message,
        author_name: commit.author_name,
        timestamp: commit.timestamp,
        files_changed: commit.files_changed,
        insertions: commit.insertions,
        deletions: commit.deletions,
        conversation_id: commit.conversation_id,
        repository: commit.repository,
      });
    }

    for (const pr of prs) {
      items.push({
        type: "pr",
        id: pr._id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        author_github_username: pr.author_github_username,
        timestamp: pr.updated_at,
        repository: pr.repository,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
      });
    }

    items.sort((a, b) => b.timestamp - a.timestamp);

    return { timelineItems: items, sessionTitleMap: titleMap };
  }, [conversations, commits, prs]);

  if (conversations === undefined || commits === undefined || prs === undefined) {
    return <LoadingSkeleton />;
  }

  if (timelineItems.length === 0) {
    return (
      <EmptyState
        title="No timeline items yet"
        description="Your sessions and commits will appear here as they happen."
        action={{
          label: "View Dashboard",
          href: "/dashboard",
        }}
      />
    );
  }

  const groups: { label: string; items: TimelineItem[] }[] = [];
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const sixHoursAgo = now - 6 * 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const groupMap = new Map<string, TimelineItem[]>([
    ["Last Hour", []],
    ["Last 6 Hours", []],
    ["Last 24 Hours", []],
    ["This Week", []],
    ["Older", []],
  ]);

  for (const item of timelineItems) {
    if (item.timestamp >= oneHourAgo) {
      groupMap.get("Last Hour")!.push(item);
    } else if (item.timestamp >= sixHoursAgo) {
      groupMap.get("Last 6 Hours")!.push(item);
    } else if (item.timestamp >= oneDayAgo) {
      groupMap.get("Last 24 Hours")!.push(item);
    } else if (item.timestamp >= weekAgo) {
      groupMap.get("This Week")!.push(item);
    } else {
      groupMap.get("Older")!.push(item);
    }
  }

  for (const [label, items] of groupMap) {
    if (items.length > 0) {
      groups.push({ label, items });
    }
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="pb-2 mb-3">
            <h2 className="text-xs font-medium tracking-wide uppercase text-sol-text-muted0">
              {group.label}
            </h2>
          </div>
          <div className="space-y-3">
            {group.items.map((item) => {
              if (item.type === "session") {
                return <SessionCard key={item.id} item={item} />;
              } else if (item.type === "commit") {
                return (
                  <CommitCard
                    key={item.id}
                    item={item}
                    sessionTitle={
                      item.conversation_id ? sessionTitleMap.get(item.conversation_id) : undefined
                    }
                  />
                );
              } else if (item.type === "pr") {
                return <PRCard key={item.id} item={item} />;
              }
              return null;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
