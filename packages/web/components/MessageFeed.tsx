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

const PAGE_SIZE = 25;

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

function getPageNumbers(current: number, total: number): (number | "dots")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | "dots")[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push("dots");
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < total - 1) pages.push("dots");
  pages.push(total);
  return pages;
}

function MessageCard({ message }: { message: FeedMessage }) {
  const isUser = message.role === "user";
  const content = message.content?.trim() || "";

  return (
    <Link
      href={`/conversation/${message.conversation_id}`}
      className="block group"
    >
      <div
        className={`
          relative rounded-lg border border-l-[3px] px-4 py-3 transition-all duration-150
          ${isUser
            ? "border-l-sol-blue/50 border-sol-border/20 bg-sol-bg hover:border-l-sol-blue hover:bg-sol-bg-alt/40"
            : "border-l-sol-violet/30 border-sol-border/15 bg-sol-bg-alt/20 hover:border-l-sol-violet/60 hover:bg-sol-bg-alt/40"
          }
        `}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <span
            className={`text-[10px] font-semibold uppercase tracking-wider ${
              isUser ? "text-sol-blue" : "text-sol-violet/70"
            }`}
          >
            {isUser ? "you" : "assistant"}
          </span>
          <span className="text-[10px] text-sol-text-dim/30">&middot;</span>
          <span className="text-xs text-sol-text-muted truncate group-hover:text-sol-text transition-colors">
            {message.conversation_title}
          </span>
          {!message.is_own && (
            <>
              <span className="text-[10px] text-sol-text-dim/30">&middot;</span>
              <span className="text-[11px] text-sol-text-dim">
                {message.author_name}
              </span>
            </>
          )}
          <span className="text-[11px] text-sol-text-dim/50 ml-auto shrink-0">
            {getRelativeTime(message.timestamp)}
          </span>
        </div>
        {content && (
          <div
            className={`line-clamp-3 overflow-hidden pointer-events-none ${
              !isUser ? "opacity-60" : ""
            }`}
          >
            <MarkdownRenderer
              content={content}
              className="text-sm !prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            />
          </div>
        )}
      </div>
    </Link>
  );
}

function PaginationControls({
  currentPage,
  totalPages,
  onPageChange,
  totalMessages,
  isLoadingMore,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  totalMessages: number;
  isLoadingMore: boolean;
}) {
  const pages = getPageNumbers(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, totalMessages);

  return (
    <div className="flex flex-col items-center gap-3 pt-2 pb-4">
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="px-2.5 py-1.5 text-xs rounded-md text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
        >
          &larr; Prev
        </button>
        {pages.map((p, i) =>
          p === "dots" ? (
            <span
              key={`dots-${i}`}
              className="w-8 text-center text-sol-text-dim/40 text-xs select-none"
            >
              &middot;&middot;&middot;
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={`w-8 h-8 text-xs rounded-md transition-colors ${
                p === currentPage
                  ? "bg-sol-blue/20 text-sol-blue font-semibold"
                  : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt"
              }`}
            >
              {p}
            </button>
          ),
        )}
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="px-2.5 py-1.5 text-xs rounded-md text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
        >
          Next &rarr;
        </button>
      </div>
      <span className="text-[11px] text-sol-text-dim/50">
        {start}&ndash;{end} of {totalMessages}
        {isLoadingMore ? "+" : ""} messages
      </span>
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
  const [currentPage, setCurrentPage] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  if (filter !== prevFilter) {
    setPrevFilter(filter);
    setCursor(undefined);
    setLoadedMessages([]);
    setCurrentPage(1);
  }

  const result = useQuery(api.conversations.getMessageFeed, {
    filter,
    limit: 100,
    cursor,
  });

  const allMessages = useMemo(() => {
    if (!result?.messages) return loadedMessages;
    const allMsgs =
      cursor === undefined
        ? result.messages
        : [...loadedMessages, ...result.messages];
    const seen = new Set<string>();
    const deduplicated: FeedMessage[] = [];
    for (const msg of allMsgs) {
      if (!seen.has(msg._id)) {
        seen.add(msg._id);
        deduplicated.push(msg);
      }
    }
    deduplicated.sort((a, b) => b.timestamp - a.timestamp);
    return deduplicated;
  }, [result?.messages, loadedMessages, cursor]);

  const filteredMessages = useMemo(() => {
    return showOnlyUser
      ? allMessages.filter((msg) => msg.role === "user")
      : allMessages;
  }, [allMessages, showOnlyUser]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredMessages.length / PAGE_SIZE),
  );
  const pageMessages = filteredMessages.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const loadMoreRef = useRef(false);
  const loadMore = useCallback(() => {
    if (result?.nextCursor && !isLoadingMore && !loadMoreRef.current) {
      loadMoreRef.current = true;
      setIsLoadingMore(true);
      setLoadedMessages(allMessages);
      setCursor(result.nextCursor);
      setTimeout(() => {
        setIsLoadingMore(false);
        loadMoreRef.current = false;
      }, 500);
    }
  }, [result?.nextCursor, isLoadingMore, allMessages]);

  useWatchEffect(() => {
    if (currentPage >= totalPages && result?.nextCursor) {
      loadMore();
    }
  }, [currentPage, totalPages, result?.nextCursor, loadMore]);

  const handlePageChange = (page: number) => {
    const clamped = Math.max(1, Math.min(page, totalPages));
    setCurrentPage(clamped);
    containerRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const groups = useMemo(() => {
    const now = Date.now();
    const boundaries = [
      { label: "Last Hour", threshold: now - 3600000 },
      { label: "Last 6 Hours", threshold: now - 21600000 },
      { label: "Last 24 Hours", threshold: now - 86400000 },
      { label: "This Week", threshold: now - 604800000 },
      { label: "Older", threshold: 0 },
    ];
    const groupMap = new Map<string, FeedMessage[]>();
    for (const { label } of boundaries) groupMap.set(label, []);
    for (const msg of pageMessages) {
      for (const { label, threshold } of boundaries) {
        if (msg.timestamp >= threshold) {
          groupMap.get(label)!.push(msg);
          break;
        }
      }
    }
    const grouped: { label: string; items: FeedMessage[] }[] = [];
    for (const { label } of boundaries) {
      const items = groupMap.get(label)!;
      if (items.length > 0) grouped.push({ label, items });
    }
    return grouped;
  }, [pageMessages]);

  if (result === undefined && loadedMessages.length === 0) {
    return <LoadingSkeleton />;
  }

  if (filteredMessages.length === 0) {
    return (
      <EmptyState
        title="No messages yet"
        description="Your conversation messages will appear here as they happen."
        action={{ label: "View Dashboard", href: "/team/activity" }}
      />
    );
  }

  return (
    <div ref={containerRef} className="space-y-5 scroll-mt-20">
      <div className="flex items-center justify-between">
        <button
          onClick={() => {
            setShowOnlyUser(!showOnlyUser);
            setCurrentPage(1);
          }}
          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            showOnlyUser
              ? "bg-sol-blue/20 text-sol-blue border-sol-blue/30"
              : "text-sol-text-muted border-sol-border/40 hover:text-sol-text hover:bg-sol-bg-alt"
          }`}
        >
          User only
        </button>
        <span className="text-xs text-sol-text-dim/50">
          {filteredMessages.length} messages
        </span>
      </div>

      {groups.map((group) => (
        <div key={group.label}>
          <div className="pb-2 mb-2">
            <h2 className="text-[11px] font-semibold tracking-widest uppercase text-sol-text-dim/60">
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

      {totalPages > 1 && (
        <PaginationControls
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          totalMessages={filteredMessages.length}
          isLoadingMore={isLoadingMore}
        />
      )}
    </div>
  );
}
