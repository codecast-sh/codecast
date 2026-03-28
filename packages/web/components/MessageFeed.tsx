import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useMemo, useState, useCallback, useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";

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

function MessageCard({ message }: { message: FeedMessage }) {
  const isUser = message.role === "user";
  const content = message.content?.trim() || "";

  return (
    <div className="relative border-l-2 border-sol-border/30 pl-4 py-1 group">
      <div className="flex items-center gap-2 mb-1.5">
        <Link
          href={`/conversation/${message.conversation_id}`}
          className="text-xs font-medium text-sol-text-muted hover:text-sol-blue transition-colors truncate max-w-[400px]"
        >
          {message.conversation_title}
        </Link>
        {!message.is_own && (
          <span className="text-[11px] text-sol-text-dim">
            {message.author_name}
          </span>
        )}
        <span className="text-[11px] text-sol-text-dim/50 ml-auto shrink-0">
          {getRelativeTime(message.timestamp)}
        </span>
      </div>
      {content && (
        isUser ? (
          <MarkdownRenderer content={content} className="text-sm !prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
        ) : (
          <MarkdownRenderer content={content} className="text-sm !prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 opacity-70" />
        )
      )}
    </div>
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
  const [showOnlyUser, setShowOnlyUser] = useState(true);

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

  const loadMoreRef = useRef(false);

  const loadMore = useCallback(() => {
    if (result?.nextCursor && !isLoadingMore && !loadMoreRef.current) {
      loadMoreRef.current = true;
      setIsLoadingMore(true);
      setLoadedMessages(messages);
      setCursor(result.nextCursor);
      // Give time for query to complete before allowing another load
      setTimeout(() => {
        setIsLoadingMore(false);
        loadMoreRef.current = false;
      }, 500);
    }
  }, [result?.nextCursor, isLoadingMore, messages]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasNextCursor = !!result?.nextCursor;

  useWatchEffect(() => {
    if (!hasNextCursor || isLoadingMore) return;

    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { threshold: 0, rootMargin: "200px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextCursor, isLoadingMore, loadMore]);

  // Only show loading skeleton on initial load, not during pagination
  if (result === undefined && loadedMessages.length === 0) {
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
        <div ref={sentinelRef} className="flex justify-center py-8">
          <button
            onClick={loadMore}
            disabled={isLoadingMore}
            className="px-4 py-2 text-sm text-sol-text-muted hover:text-sol-text bg-sol-bg-alt hover:bg-sol-bg-alt/80 rounded-lg transition-colors disabled:opacity-50"
          >
            {isLoadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
