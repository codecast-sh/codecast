"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";

type FeedMessage = {
  _id: string;
  conversation_id: string;
  role: string;
  content: string | undefined;
  timestamp: number;
  has_tool_calls: boolean;
  has_tool_results: boolean;
  conversation_title: string;
  conversation_session_id: string;
  author_name: string;
  is_own: boolean;
};

function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes === 1) return "1m ago";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours === 1) return "1h ago";
  if (diffHours < 24) return `${diffHours}h ago`;
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

function truncateContent(content: string | undefined, maxLength: number = 500): string {
  if (!content) return "";
  const cleaned = content.trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength) + "...";
}

function MessageCard({ message }: { message: FeedMessage }) {
  const isUser = message.role === "user";
  const contentPreview = truncateContent(message.content);

  return (
    <Link href={`/conversation/${message.conversation_id}`} className="group block">
      <div
        className={`relative border rounded-xl p-4 transition-all duration-200 shadow-sm hover:shadow-md ${
          isUser
            ? "bg-white border-sol-blue/40 hover:border-sol-blue/60"
            : "bg-sol-bg-alt/60 border-sol-border/40 hover:border-sol-violet/40"
        }`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
              isUser
                ? "bg-sol-blue/40 text-sol-blue"
                : "bg-sol-violet/40 text-sol-violet"
            }`}
          >
            {isUser ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
              </svg>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`text-xs font-medium ${
                    isUser ? "text-sol-blue" : "text-sol-violet"
                  }`}
                >
                  {isUser ? "User" : "Assistant"}
                </span>
                {message.has_tool_calls && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sol-yellow/20 text-sol-yellow border border-sol-yellow/30">
                    tools
                  </span>
                )}
              </div>
              <span className="text-[11px] text-sol-text-dim/60 shrink-0">
                {getRelativeTime(message.timestamp)}
              </span>
            </div>

            {contentPreview && (
              <p className="text-sol-text text-sm leading-relaxed line-clamp-6 mb-2 whitespace-pre-wrap">
                {contentPreview}
              </p>
            )}

            <div className="flex items-center gap-2 text-xs text-sol-text-muted">
              <span className="truncate max-w-[300px] font-medium group-hover:text-sol-yellow transition-colors">
                {message.conversation_title}
              </span>
              {!message.is_own && (
                <>
                  <span className="text-sol-text-dim">by</span>
                  <span>{message.author_name}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

interface MessageFeedProps {
  filter: "my" | "team";
}

export function MessageFeed({ filter }: MessageFeedProps) {
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [loadedMessages, setLoadedMessages] = useState<FeedMessage[]>([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [prevFilter, setPrevFilter] = useState(filter);
  const [showOnlyUser, setShowOnlyUser] = useState(false);

  // Reset when filter changes
  if (filter !== prevFilter) {
    setPrevFilter(filter);
    setCursor(undefined);
    setLoadedMessages([]);
  }

  const result = useQuery(api.conversations.getMessageFeed, {
    filter,
    limit: 100,
    cursor,
  });

  // Deduplicate and merge messages
  const messages = useMemo(() => {
    if (!result?.messages) return loadedMessages;

    const allMsgs = cursor === undefined
      ? result.messages
      : [...loadedMessages, ...result.messages];

    // Deduplicate by _id
    const seen = new Set<string>();
    const deduplicated: FeedMessage[] = [];
    for (const msg of allMsgs) {
      if (!seen.has(msg._id)) {
        seen.add(msg._id);
        deduplicated.push(msg);
      }
    }

    // Sort by timestamp descending
    deduplicated.sort((a, b) => b.timestamp - a.timestamp);

    // Filter by role if needed
    if (showOnlyUser) {
      return deduplicated.filter(msg => msg.role === "user");
    }
    return deduplicated;
  }, [result?.messages, loadedMessages, cursor, showOnlyUser]);

  const loadMore = useCallback(() => {
    if (result?.nextCursor && !isLoadingMore) {
      setIsLoadingMore(true);
      setLoadedMessages(messages);
      setCursor(result.nextCursor);
      setTimeout(() => setIsLoadingMore(false), 100);
    }
  }, [result?.nextCursor, isLoadingMore, messages]);

  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !result?.nextCursor) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isLoadingMore) {
          loadMore();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [result?.nextCursor, isLoadingMore, loadMore]);

  if (result === undefined) {
    return <LoadingSkeleton />;
  }

  if (messages.length === 0) {
    return (
      <EmptyState
        title="No messages yet"
        description="Your conversation messages will appear here as they happen."
        action={{
          label: "View Dashboard",
          href: "/dashboard",
        }}
      />
    );
  }

  const groups: { label: string; items: FeedMessage[] }[] = [];
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const sixHoursAgo = now - 6 * 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const groupMap = new Map<string, FeedMessage[]>([
    ["Last Hour", []],
    ["Last 6 Hours", []],
    ["Last 24 Hours", []],
    ["This Week", []],
    ["Older", []],
  ]);

  for (const msg of messages) {
    if (msg.timestamp >= oneHourAgo) {
      groupMap.get("Last Hour")!.push(msg);
    } else if (msg.timestamp >= sixHoursAgo) {
      groupMap.get("Last 6 Hours")!.push(msg);
    } else if (msg.timestamp >= oneDayAgo) {
      groupMap.get("Last 24 Hours")!.push(msg);
    } else if (msg.timestamp >= weekAgo) {
      groupMap.get("This Week")!.push(msg);
    } else {
      groupMap.get("Older")!.push(msg);
    }
  }

  for (const [label, items] of groupMap) {
    if (items.length > 0) {
      groups.push({ label, items });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowOnlyUser(!showOnlyUser)}
          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            showOnlyUser
              ? "bg-sol-blue/20 text-sol-blue border-sol-blue/30"
              : "text-sol-text-muted border-sol-border/40 hover:text-sol-text hover:bg-sol-bg-alt"
          }`}
        >
          User only
        </button>
      </div>
      {groups.map((group) => (
        <div key={group.label}>
          <div className="pb-2 mb-3">
            <h2 className="text-xs font-medium tracking-wide uppercase text-sol-text-muted">
              {group.label}
            </h2>
          </div>
          <div className="space-y-2">
            {group.items.map((msg) => (
              <MessageCard key={msg._id} message={msg} />
            ))}
          </div>
        </div>
      ))}

      {result?.nextCursor && (
        <div ref={sentinelRef} className="flex justify-center py-6">
          <div className="text-sm text-sol-text-muted">
            {isLoadingMore ? "Loading..." : ""}
          </div>
        </div>
      )}
    </div>
  );
}
