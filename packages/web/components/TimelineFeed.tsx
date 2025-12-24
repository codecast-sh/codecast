"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useState, useMemo } from "react";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { cleanTitle } from "../lib/conversationProcessor";

type TimelineItem =
  | {
      type: "session";
      id: string;
      title: string;
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

function SessionCard({ item }: { item: Extract<TimelineItem, { type: "session" }> }) {
  return (
    <Link href={`/conversation/${item.id}`} className="group block relative">
      <div className="absolute inset-0 bg-gradient-to-br from-sol-bg-alt/40 to-sol-bg/40 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
      <div className="relative bg-sol-bg-alt/40 border border-sol-border/30 rounded-xl p-4 hover:border-sol-yellow/40 transition-all duration-200 backdrop-blur-sm">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded bg-sol-yellow flex items-center justify-center mt-1">
            <ClaudeIcon className="w-4 h-4 text-sol-bg" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3 mb-1">
              <span className="text-sol-text font-medium text-base group-hover:text-sol-yellow transition-colors truncate">
                {cleanTitle(item.title)}
              </span>
              <span className="text-[11px] text-sol-text-dim/50 shrink-0">
                {getRelativeTime(item.timestamp)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-sol-text-muted0 flex-wrap">
              {!item.is_own && <span className="font-medium">{item.author_name}</span>}
              {item.is_active && (
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

function CommitCard({ item }: { item: Extract<TimelineItem, { type: "commit" }> }) {
  const shortSha = item.sha.substring(0, 7);
  return (
    <div className="relative bg-sol-bg-alt/30 border border-sol-border/20 rounded-xl p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded bg-sol-violet/60 flex items-center justify-center mt-1">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
            />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3 mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <code className="text-xs font-mono text-sol-text-muted bg-sol-bg/50 px-1.5 py-0.5 rounded">
                {shortSha}
              </code>
              <span className="text-sol-text text-sm truncate">{item.message}</span>
            </div>
            <span className="text-[11px] text-sol-text-dim/50 shrink-0">
              {getRelativeTime(item.timestamp)}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-sol-text-muted0">
            <span>{item.author_name}</span>
            <span className="text-sol-green">+{item.insertions}</span>
            <span className="text-sol-red">-{item.deletions}</span>
            <span>{item.files_changed} files</span>
          </div>
        </div>
      </div>
    </div>
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

  const timelineItems = useMemo(() => {
    if (!conversations?.conversations || !commits) return [];

    const items: TimelineItem[] = [];

    for (const conv of conversations.conversations) {
      items.push({
        type: "session",
        id: conv._id,
        title: conv.title || "Untitled Session",
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
      });
    }

    items.sort((a, b) => b.timestamp - a.timestamp);

    return items;
  }, [conversations, commits]);

  if (conversations === undefined || commits === undefined) {
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
            {group.items.map((item) =>
              item.type === "session" ? (
                <SessionCard key={item.id} item={item} />
              ) : (
                <CommitCard key={item.id} item={item} />
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
