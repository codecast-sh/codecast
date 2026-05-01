"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isCommandMessage, cleanContent, isSystemMessage } from "../lib/conversationProcessor";
import { useMountEffect } from "../hooks/useMountEffect";
import { isConvexId, useInboxStore } from "../store/inboxStore";

function getCommandLabel(content: string): string | null {
  const m = content.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
  return m ? `/${m[1].replace(/^\//, "")}` : null;
}

function processUserMessage(content: string): { display: string; isCmd: boolean } {
  const isCmd = isCommandMessage(content);
  if (isCmd) {
    const label = getCommandLabel(content);
    return { display: label || cleanContent(content), isCmd: true };
  }
  return { display: cleanContent(content), isCmd: false };
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 30) return `${days}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

type PM = { _id: string; display: string; isCmd: boolean; role: "user" | "assistant"; timestamp: number; commentCount: number };

type CommentEntry = {
  _id: string;
  message_id?: string;
  content: string;
  created_at: number;
  user: { name?: string; github_username?: string; github_avatar_url?: string };
};

type IndexedPM = PM & { originalIndex: number };

function HoverPreview({ message, rect, onMouseEnter, onMouseLeave, onDropdownEnter, onDropdownLeave }: { message: IndexedPM; rect: DOMRect; onMouseEnter: () => void; onMouseLeave: () => void; onDropdownEnter: () => void; onDropdownLeave: () => void }) {
  const previewWidth = 420;
  const bridgePad = 20;
  const left = Math.max(8, rect.left - previewWidth - bridgePad);
  const top = Math.max(8, rect.top - 20);

  return createPortal(
    <div
      className="fixed z-[10000]"
      style={{ top, left, width: previewWidth + bridgePad, paddingRight: bridgePad }}
      onMouseEnter={() => { onMouseEnter(); onDropdownEnter(); }}
      onMouseLeave={() => { onMouseLeave(); onDropdownLeave(); }}
    >
      <div
        className="bg-sol-bg border border-sol-border/40 rounded-lg shadow-2xl flex flex-col"
        style={{ width: previewWidth, maxHeight: "60vh" }}
      >
        <div className="flex items-center gap-2 p-3 pb-1 flex-shrink-0">
          <span className="text-[10px] text-sol-text-dim tabular-nums">#{message.originalIndex + 1}</span>
          <span className="text-sol-text-dim/30">·</span>
          <span className={`text-[10px] ${message.role === "assistant" ? "text-sol-orange/70" : "text-sol-text-dim"}`}>
            {message.role === "assistant" ? "claude" : "you"}
          </span>
          <span className="text-sol-text-dim/30">·</span>
          <span className="text-sol-text-dim text-[10px]">{formatTimeAgo(message.timestamp)}</span>
          {message.commentCount > 0 && (
            <span className="text-[10px] text-sol-cyan flex items-center gap-0.5">
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              {message.commentCount}
            </span>
          )}
        </div>
        <div className="px-3 pb-3 overflow-y-auto flex-1 min-h-0">
          <div className="text-[13px] text-sol-text whitespace-pre-wrap break-words leading-relaxed">
            {message.display}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function NavDropdown({
  messages,
  comments,
  conversationId,
  currentMessageId,
  triggerRect,
  onClose,
  onMouseEnter,
  onMouseLeave,
  pinned,
  onPin,
  onScrollToMessage,
  tab,
  onTabChange,
}: {
  messages: PM[];
  comments: CommentEntry[];
  conversationId: string;
  currentMessageId: string | null;
  triggerRect: DOMRect;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  pinned: boolean;
  onPin: () => void;
  onScrollToMessage?: (messageId: string) => void;
  tab: "messages" | "comments";
  onTabChange: (t: "messages" | "comments") => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [search, setSearch] = useState("");
  const [focusIndex, setFocusIndex] = useState(-1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewMsg, setPreviewMsg] = useState<IndexedPM | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentItemRef = useRef<HTMLDivElement>(null);
  useMountEffect(() => setMounted(true));

  useEffect(() => {
    if (mounted) {
      requestAnimationFrame(() => {
        if (currentItemRef.current) {
          currentItemRef.current.scrollIntoView({ block: "center" });
        } else if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [mounted]);

  const indexed: IndexedPM[] = messages.map((m, i) => ({ ...m, originalIndex: i }));
  const filtered = search
    ? indexed.filter(m => m.display.toLowerCase().includes(search.toLowerCase()))
    : indexed;

  useEffect(() => { setFocusIndex(-1); }, [search]);

  const navigateToMessage = useCallback((m: PM) => {
    onPin();
    if (onScrollToMessage) {
      onScrollToMessage(m._id);
    } else {
      useInboxStore.setState({
        pendingNavigateId: conversationId,
        pendingScrollToMessageId: m._id,
      });
    }
  }, [conversationId, onPin, onScrollToMessage]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (tab !== "messages") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex(prev => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex(prev => {
          const next = prev - 1;
          if (next < 0) searchRef.current?.focus();
          return Math.max(next, -1);
        });
      } else if (e.key === "Enter" && focusIndex >= 0 && focusIndex < filtered.length) {
        e.preventDefault();
        navigateToMessage(filtered[focusIndex]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusIndex, filtered, tab, navigateToMessage]);

  useEffect(() => {
    if (focusIndex >= 0) {
      const el = scrollRef.current?.querySelector(`[data-focus-index="${focusIndex}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [focusIndex]);

  const handleItemHover = useCallback((id: string, el: HTMLElement, msg: IndexedPM) => {
    setHoveredId(id);
    if (previewLeaveTimerRef.current) clearTimeout(previewLeaveTimerRef.current);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredRect(el.getBoundingClientRect());
      setPreviewMsg(msg);
    }, 250);
  }, []);

  const dismissPreview = useCallback(() => {
    if (previewLeaveTimerRef.current) clearTimeout(previewLeaveTimerRef.current);
    previewLeaveTimerRef.current = setTimeout(() => {
      setPreviewMsg(null);
      setHoveredRect(null);
    }, 500);
  }, []);

  const cancelDismissPreview = useCallback(() => {
    if (previewLeaveTimerRef.current) clearTimeout(previewLeaveTimerRef.current);
  }, []);

  const handleItemLeave = useCallback(() => {
    setHoveredId(null);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    dismissPreview();
  }, [dismissPreview]);

  if (!mounted || typeof document === "undefined") return null;

  const dropdownWidth = 420;
  const margin = 8;
  const left = Math.max(margin, triggerRect.left - dropdownWidth - 8);
  const top = Math.max(margin, triggerRect.top);

  const hasComments = comments.length > 0;

  return createPortal(
    <>
      {pinned && <div className="fixed inset-0 z-[9998] pointer-events-auto" onClick={onClose} />}
      <div
        className="fixed z-[9999] bg-sol-bg border border-sol-border/30 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        style={{ top, left, width: dropdownWidth, maxHeight: "min(600px, 75vh)" }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={onPin}
      >
        {tab === "messages" && (
          <div className="px-3 pt-3 pb-2">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`Search ${messages.length} messages...`}
              className="w-full bg-sol-bg-alt/60 border border-sol-border/20 rounded-lg px-3 py-1.5 text-[12px] text-sol-text placeholder:text-sol-text-dim/40 outline-none focus:border-sol-cyan/40 transition-colors"
            />
          </div>
        )}
        {hasComments && (
          <div className="flex border-b border-sol-border/20 px-3">
            <button
              onClick={() => onTabChange("messages")}
              className={`text-[11px] py-1.5 px-2 transition-colors border-b-2 ${
                tab === "messages"
                  ? "text-sol-text border-sol-cyan font-medium"
                  : "text-sol-text-dim hover:text-sol-text-muted border-transparent"
              }`}
            >
              Messages ({messages.length})
            </button>
            <button
              onClick={() => onTabChange("comments")}
              className={`text-[11px] py-1.5 px-2 transition-colors border-b-2 flex items-center gap-1 ${
                tab === "comments"
                  ? "text-sol-text border-sol-cyan font-medium"
                  : "text-sol-text-dim hover:text-sol-text-muted border-transparent"
              }`}
            >
              Comments ({comments.length})
            </button>
          </div>
        )}
        <div ref={scrollRef} className="overflow-y-auto flex-1 py-1" style={{ overscrollBehavior: "contain" }}>
          {tab === "messages" ? (
            filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-sol-text-dim/50">
                {search ? "No matching messages" : "No messages"}
              </div>
            ) : (
            filtered.map((m, filterIdx) => {
              const isCurrent = m._id === currentMessageId;
              const isFocused = filterIdx === focusIndex;
              const isHovered = m._id === hoveredId;
              return (
                <div
                  key={m._id}
                  ref={isCurrent ? currentItemRef : undefined}
                  data-focus-index={filterIdx}
                  onMouseEnter={(e) => handleItemHover(m._id, e.currentTarget, m)}
                  onMouseLeave={handleItemLeave}
                  onClick={() => navigateToMessage(m)}
                  className={`px-3 py-2 cursor-pointer transition-colors border-l-2 ${
                    isCurrent
                      ? "border-sol-cyan bg-sol-bg-alt/50"
                      : isFocused
                      ? "border-sol-text-dim bg-sol-bg-alt/40"
                      : isHovered
                      ? "border-transparent bg-sol-bg-alt/30"
                      : "border-transparent"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`text-[10px] tabular-nums w-4 text-right flex-shrink-0 pt-[2px] ${
                      m.role === "assistant" ? "text-sol-orange/50" : "text-sol-text-dim/40"
                    }`}>
                      {m.originalIndex + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[12px] leading-snug line-clamp-2 ${
                        isCurrent ? "text-sol-text font-medium"
                          : m.role === "assistant" ? "text-sol-text-dim italic"
                          : m.isCmd ? "text-sol-text-muted font-mono"
                          : "text-sol-text-muted"
                      }`}>
                        {m.display}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="text-[10px] text-sol-text-dim/50 tabular-nums">
                          {formatTimeAgo(m.timestamp)}
                        </span>
                        {m.commentCount > 0 && (
                          <>
                            <span className="text-sol-text-dim/20">·</span>
                            <span className="text-[10px] text-sol-cyan flex items-center gap-0.5">
                              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                              </svg>
                              {m.commentCount}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }))
          ) : (
            comments.map((c) => {
              const displayName = c.user?.name || c.user?.github_username || "Unknown";
              const isHovered = c._id === hoveredId;
              return (
                <div
                  key={c._id}
                  onMouseEnter={() => setHoveredId(c._id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => {
                    onPin();
                    if (c.message_id) {
                      if (onScrollToMessage) {
                        onScrollToMessage(c.message_id);
                      } else {
                        useInboxStore.setState({
                          pendingNavigateId: conversationId,
                          pendingScrollToMessageId: c.message_id,
                        });
                      }
                    }
                  }}
                  className={`px-3 py-2 cursor-pointer transition-colors ${
                    isHovered ? "bg-sol-bg-alt/40" : ""
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {c.user?.github_avatar_url ? (
                      <img src={c.user.github_avatar_url} alt="" className="w-4 h-4 rounded-full" />
                    ) : (
                      <div className="w-4 h-4 rounded-full bg-sol-blue/30 flex items-center justify-center text-[8px] text-sol-blue">
                        {displayName[0]?.toUpperCase()}
                      </div>
                    )}
                    <span className="text-[11px] text-sol-text-secondary font-medium">{displayName}</span>
                    <span className="text-[10px] text-sol-text-dim/60 ml-auto">{formatTimeAgo(c.created_at)}</span>
                  </div>
                  <div className="text-[12px] text-sol-text-muted line-clamp-2 pl-[22px]">
                    {c.content}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      {previewMsg && hoveredRect && (
        <HoverPreview message={previewMsg} rect={hoveredRect} onMouseEnter={cancelDismissPreview} onMouseLeave={dismissPreview} onDropdownEnter={onMouseEnter} onDropdownLeave={onMouseLeave} />
      )}
    </>,
    document.body
  );
}

export function MessageNavButton({
  conversationId,
  currentMessageId,
  scrollProgress = 1,
  onScrollToMessage,
}: {
  conversationId: string;
  currentMessageId: string | null;
  scrollProgress?: number;
  onScrollToMessage?: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(false);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [tab, setTab] = useState<"messages" | "comments">("messages");
  const btnRef = useRef<HTMLButtonElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messages = useQuery(
    api.conversations.getUserMessages,
    isConvexId(conversationId)
      ? { conversation_id: conversationId as Id<"conversations"> }
      : "skip"
  );

  const commentSummary = useQuery(
    api.comments.getConversationCommentSummary,
    isConvexId(conversationId)
      ? { conversation_id: conversationId as Id<"conversations"> }
      : "skip"
  );

  const commentsByMessage = new Map<string, number>();
  const topLevelComments: CommentEntry[] = [];
  if (commentSummary) {
    for (const c of commentSummary) {
      if (!c.parent_comment_id) {
        topLevelComments.push({
          _id: c._id,
          message_id: c.message_id as string | undefined,
          content: c.content,
          created_at: c.created_at,
          user: c.user,
        });
      }
      if (c.message_id) {
        const mid = c.message_id as string;
        commentsByMessage.set(mid, (commentsByMessage.get(mid) || 0) + 1);
      }
    }
  }

  const processed: PM[] = messages
    ? messages
        .map((m: { _id: string; role?: string; content: string; timestamp: number }) => ({
          _id: m._id,
          role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
          ...processUserMessage(m.content),
          timestamp: m.timestamp,
          commentCount: commentsByMessage.get(m._id) || 0,
        }))
        .filter((m: PM) => m.display.length > 0 && !isSystemMessage(m.display) && m.role === "user")
    : [];

  const total = processed.length;
  const effectiveId = currentMessageId === "__fallback__" ? null : currentMessageId;
  const currentIndex = effectiveId ? processed.findIndex((m) => m._id === effectiveId) : -1;
  const activeIndex =
    currentIndex >= 0 ? currentIndex : Math.min(total - 1, Math.floor(scrollProgress * total));

  const scheduleOpen = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    openTimerRef.current = setTimeout(() => {
      if (btnRef.current) setTriggerRect(btnRef.current.getBoundingClientRect());
      setOpen(true);
    }, 180);
  }, []);

  const scheduleClose = useCallback(() => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (pinnedRef.current) return;
    closeTimerRef.current = setTimeout(() => setOpen(false), 250);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  const handlePin = useCallback(() => {
    pinnedRef.current = true;
    setPinned(true);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
  }, []);

  const handleClose = useCallback(() => {
    pinnedRef.current = false;
    setPinned(false);
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, handleClose]);

  if (!messages || total <= 1) return null;

  const MAX_BARS = 24;
  const displayCount = Math.min(total, MAX_BARS);
  const hasComments = topLevelComments.length > 0;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => {
          if (open && pinnedRef.current) { handleClose(); }
          else {
            if (!open && btnRef.current) setTriggerRect(btnRef.current.getBoundingClientRect());
            setOpen(true);
            handlePin();
          }
        }}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        className={`flex flex-col gap-[3px] items-end justify-center px-2 py-1.5 rounded transition-colors relative ${
          open ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text-secondary"
        }`}
        title={`${total} message${total !== 1 ? "s" : ""}${hasComments ? ` / ${topLevelComments.length} comment${topLevelComments.length !== 1 ? "s" : ""}` : ""}`}
      >
        {Array.from({ length: displayCount }).map((_, i) => {
          const mappedIndex = total <= MAX_BARS ? i : Math.round((i / (displayCount - 1)) * (total - 1));
          const isActive = mappedIndex === activeIndex;
          const msg = processed[mappedIndex];
          const hasComment = msg && msg.commentCount > 0;
          const isAssistant = msg?.role === "assistant";
          return (
            <span
              key={i}
              className={`block rounded-full transition-all duration-150 ${
                isActive
                  ? "bg-sol-text w-4 h-[2.5px]"
                  : hasComment
                  ? "bg-sol-cyan w-3.5 h-[2px] opacity-70"
                  : isAssistant
                  ? "bg-sol-orange w-2.5 h-px opacity-30"
                  : "bg-current w-3 h-px opacity-35"
              }`}
            />
          );
        })}
      </button>
      {open && triggerRect && (
        <NavDropdown
          messages={processed}
          comments={topLevelComments}
          conversationId={conversationId}
          currentMessageId={effectiveId}
          triggerRect={triggerRect}
          onClose={handleClose}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          pinned={pinned}
          onPin={handlePin}
          onScrollToMessage={onScrollToMessage}
          tab={tab}
          onTabChange={setTab}
        />
      )}
    </>
  );
}
