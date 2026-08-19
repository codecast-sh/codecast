import { useMemo, useState } from "react";
import { useMessageFeed } from "../hooks/useMessageFeed";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CornerDownRight } from "lucide-react";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";
import { EntityIdPill } from "./EntityIdPill";
import { parseInboundSessionMessage, isSessionMessage } from "./sessionMessage";
import { classifyFeedMessage } from "../lib/conversationProcessor";

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

// How many real (non-noise) messages to keep on screen before the user has to
// ask for more. The raw feed can be mostly machine noise, so the loader keeps
// pulling server batches until this many survive the filter (or history runs out).
const MIN_VISIBLE = 30;
// How many to add per "Load older" click / auto-fill step (server page size).

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

// Agent-to-agent message (delivered by `cast send`, stored wrapped in a
// <session-message from="…"> tag). Rendered with the same cyan "Message from
// <sender>" chrome the conversation view uses (SessionMessageBlock), so the feed
// reads like the convos. A plain div (not a Link) because EntityIdPill renders
// its own <a> for the sender — nesting anchors is invalid — so we navigate via a
// click handler that yields to any inner link/button.
function SessionMessageCard({ message }: { message: FeedMessage }) {
  const router = useRouter();
  const parsed = parseInboundSessionMessage(message.content);
  const from = parsed?.from || "unknown";
  const body = parsed?.body || message.content?.trim() || "";

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        router.push(`/conversation/${message.conversation_id}`);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") router.push(`/conversation/${message.conversation_id}`);
      }}
      className="group relative cursor-pointer rounded-lg border border-l-[3px] border-l-sol-cyan/60 border-sol-border/20 bg-sol-cyan/[0.04] px-4 py-3 transition-all duration-150 hover:border-l-sol-cyan hover:bg-sol-cyan/[0.07]"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <CornerDownRight className="w-3.5 h-3.5 shrink-0 text-sol-cyan/70" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-cyan/80 shrink-0">
          message from
        </span>
        {from && from !== "unknown" ? (
          <EntityIdPill shortId={from} />
        ) : (
          <span className="text-xs text-sol-text-muted">another session</span>
        )}
        <span className="text-[10px] text-sol-text-dim/30">&middot;</span>
        <span className="text-xs text-sol-text-muted truncate group-hover:text-sol-text transition-colors">
          {message.conversation_title}
        </span>
        <span className="text-[11px] text-sol-text-dim/50 ml-auto shrink-0">
          {getRelativeTime(message.timestamp)}
        </span>
      </div>
      <div className="line-clamp-4 overflow-hidden">
        <MarkdownRenderer
          content={body}
          className="text-sm !prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        />
      </div>
    </div>
  );
}

// A real human prompt. `text` is already cleaned of system wrappers by
// classifyFeedMessage, so the card never shows raw <task-notification>/<command>
// noise. The "you" label gets the author's name appended for teammates' messages.
function MessageCard({ message, text }: { message: FeedMessage; text: string }) {
  return (
    <Link
      href={`/conversation/${message.conversation_id}`}
      className="block group"
    >
      <div className="relative rounded-lg border border-l-[3px] border-l-sol-blue/50 border-sol-border/20 bg-sol-bg px-4 py-3 transition-all duration-150 hover:border-l-sol-blue hover:bg-sol-bg-alt/40">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-blue">
            {message.is_own ? "you" : message.author_name}
          </span>
          <span className="text-[10px] text-sol-text-dim/30">&middot;</span>
          <span className="text-xs text-sol-text-muted truncate group-hover:text-sol-text transition-colors">
            {message.conversation_title}
          </span>
          <span className="text-[11px] text-sol-text-dim/50 ml-auto shrink-0">
            {getRelativeTime(message.timestamp)}
          </span>
        </div>
        <div className="line-clamp-3 overflow-hidden pointer-events-none">
          <MarkdownRenderer
            content={text}
            className="text-sm !prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          />
        </div>
      </div>
    </Link>
  );
}

function LoadMoreBar({
  onLoadMore,
  isLoadingMore,
}: {
  onLoadMore: () => void;
  isLoadingMore: boolean;
}) {
  return (
    <div className="flex justify-center pt-2 pb-6">
      <button
        onClick={onLoadMore}
        disabled={isLoadingMore}
        className="px-4 py-1.5 text-xs rounded-lg border border-sol-border/40 text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt disabled:opacity-50 disabled:cursor-wait transition-colors"
      >
        {isLoadingMore ? "Loading…" : "Load older messages"}
      </button>
    </div>
  );
}

interface MessageFeedProps {
  filter: "my" | "team";
}

type FeedItem =
  | { kind: "session"; msg: FeedMessage }
  | { kind: "text"; msg: FeedMessage; text: string };

export function MessageFeed({ filter }: MessageFeedProps) {
  // Default hides session→session cross-talk (cast send coordination): the
  // feed is about what people wrote. "All" re-adds the agent-to-agent cards.
  const [mode, setMode] = useState<"humans" | "mine" | "all">("humans");
  // Store-fed (hooks/useMessageFeed): the feed paints from cached rows on
  // the first frame; the live newest page and one-shot older pages overlay
  // the store, and the continuation cursor survives a reload.
  const { messages: allMessages, ready, hasMore, isLoadingMore, loadMore } = useMessageFeed(filter);
  const result = ready || allMessages.length > 0 ? { nextCursor: hasMore ? 1 : null } : undefined;
  const loadedMessages = allMessages;

  // Classify every user-role message once. Session→session cross-talk gets its
  // own cyan card; machine noise (task notifications, command/skill expansions,
  // continuations, compaction prompts, tool-output pointers) is dropped; the rest
  // becomes cleaned display text. This is the SAME structured-message handling the
  // conversation view does, via the shared classifier in conversationProcessor —
  // so the feed never dumps raw <task-notification> XML.
  const displayItems = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    for (const msg of allMessages) {
      if (msg.role !== "user") continue;
      if (isSessionMessage(msg.content)) {
        items.push({ kind: "session", msg });
        continue;
      }
      const d = classifyFeedMessage(msg.content);
      if (d.kind === "hidden") continue;
      items.push({ kind: "text", msg, text: d.text });
    }
    return items;
  }, [allMessages]);

  // "humans" = what people typed (no agent cross-talk); "mine" = only my own
  // prompts; "all" = everything including session→session messages.
  const visibleItems = useMemo(() => {
    if (mode === "all") return displayItems;
    if (mode === "mine") return displayItems.filter((it) => it.kind === "text" && it.msg.is_own);
    return displayItems.filter((it) => it.kind === "text");
  }, [displayItems, mode]);

  // Auto-fill: a server page can be almost all machine noise, leaving too few
  // real messages on screen. Keep pulling until MIN_VISIBLE survive the filter
  // (or history runs out). Bounded by nextCursor, so it can't run away.
  useWatchEffect(() => {
    if (visibleItems.length < MIN_VISIBLE && result?.nextCursor && !isLoadingMore) {
      loadMore();
    }
  }, [visibleItems.length, result?.nextCursor, isLoadingMore, loadMore]);

  const groups = useMemo(() => {
    const now = Date.now();
    const boundaries = [
      { label: "Last Hour", threshold: now - 3600000 },
      { label: "Last 6 Hours", threshold: now - 21600000 },
      { label: "Last 24 Hours", threshold: now - 86400000 },
      { label: "This Week", threshold: now - 604800000 },
      { label: "Older", threshold: 0 },
    ];
    const groupMap = new Map<string, FeedItem[]>();
    for (const { label } of boundaries) groupMap.set(label, []);
    for (const item of visibleItems) {
      for (const { label, threshold } of boundaries) {
        if (item.msg.timestamp >= threshold) {
          groupMap.get(label)!.push(item);
          break;
        }
      }
    }
    const grouped: { label: string; items: FeedItem[] }[] = [];
    for (const { label } of boundaries) {
      const items = groupMap.get(label)!;
      if (items.length > 0) grouped.push({ label, items });
    }
    return grouped;
  }, [visibleItems]);

  if (result === undefined && loadedMessages.length === 0) {
    return <LoadingSkeleton />;
  }

  // Still pulling batches to fill the first screen (noise-heavy feed) — show a
  // skeleton instead of a premature "no messages".
  if (visibleItems.length === 0 && (isLoadingMore || result?.nextCursor)) {
    return <LoadingSkeleton />;
  }

  if (visibleItems.length === 0) {
    return (
      <EmptyState
        title="No messages yet"
        description="Your conversation messages will appear here as they happen."
        action={{ label: "View Dashboard", href: "/team/activity" }}
      />
    );
  }

  return (
    <div className="space-y-5 scroll-mt-20">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-sol-border/40 p-0.5">
          {([
            { key: "humans", label: "People", title: "Messages people typed (no agent-to-agent traffic)" },
            { key: "mine", label: "Mine", title: "Only messages I typed" },
            { key: "all", label: "All", title: "Everything, including session-to-session messages between agents" },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setMode(opt.key)}
              title={opt.title}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                mode === opt.key
                  ? "bg-sol-blue/20 text-sol-blue"
                  : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-sol-text-dim/50">
          {visibleItems.length} message{visibleItems.length === 1 ? "" : "s"}
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
            {group.items.map((item) =>
              item.kind === "session" ? (
                <SessionMessageCard key={item.msg._id} message={item.msg} />
              ) : (
                <MessageCard key={item.msg._id} message={item.msg} text={item.text} />
              ),
            )}
          </div>
        </div>
      ))}

      {result?.nextCursor && (
        <LoadMoreBar onLoadMore={loadMore} isLoadingMore={isLoadingMore} />
      )}
    </div>
  );
}
