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

type PM = { _id: string; display: string; isCmd: boolean; timestamp: number; commentCount: number };

type CommentEntry = {
  _id: string;
  message_id?: string;
  content: string;
  created_at: number;
  user: { name?: string; github_username?: string; github_avatar_url?: string };
};

function HoverPreview({ message, rect }: { message: PM; rect: DOMRect }) {
  const previewWidth = 360;
  const left = Math.max(8, rect.left - previewWidth - 12);
  const top = Math.max(8, rect.top - 20);

  return createPortal(
    <div
      className="fixed z-[10000] bg-sol-bg border border-sol-border/40 rounded-lg shadow-2xl p-3 max-h-[300px] overflow-y-auto"
      style={{ top, left, width: previewWidth }}
    >
      <div className="flex items-center gap-2 mb-2">
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
      <div className="text-[13px] text-sol-text whitespace-pre-wrap break-words leading-relaxed">
        {message.display}
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
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewMsg, setPreviewMsg] = useState<PM | null>(null);
  useMountEffect(() => setMounted(true));

  const handleItemHover = useCallback((id: string, el: HTMLElement, msg: PM) => {
    setHoveredId(id);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredRect(el.getBoundingClientRect());
      setPreviewMsg(msg);
    }, 400);
  }, []);

  const handleItemLeave = useCallback(() => {
    setHoveredId(null);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setPreviewMsg(null);
    setHoveredRect(null);
  }, []);

  if (!mounted || typeof document === "undefined") return null;

  const dropdownWidth = 340;
  const margin = 8;
  const left = Math.max(margin, triggerRect.left - dropdownWidth - 8);
  const top = Math.max(margin, triggerRect.top);

  const hasComments = comments.length > 0;

  return createPortal(
    <>
      {pinned && <div className="fixed inset-0 z-[9998] pointer-events-auto" onClick={onClose} />}
      <div
        className="fixed z-[9999] bg-sol-bg border border-sol-border/30 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        style={{ top, left, width: dropdownWidth, maxHeight: "min(500px, 70vh)" }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {hasComments && (
          <div className="flex border-b border-sol-border/20 px-1 pt-1">
            <button
              onClick={() => onTabChange("messages")}
              className={`flex-1 text-[11px] py-1.5 rounded-t transition-colors ${
                tab === "messages"
                  ? "text-sol-text bg-sol-bg-alt/50 font-medium"
                  : "text-sol-text-dim hover:text-sol-text-muted"
              }`}
            >
              Messages ({messages.length})
            </button>
            <button
              onClick={() => onTabChange("comments")}
              className={`flex-1 text-[11px] py-1.5 rounded-t transition-colors flex items-center justify-center gap-1 ${
                tab === "comments"
                  ? "text-sol-text bg-sol-bg-alt/50 font-medium"
                  : "text-sol-text-dim hover:text-sol-text-muted"
              }`}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              Comments ({comments.length})
            </button>
          </div>
        )}
        <div className="overflow-y-auto flex-1 py-1">
          {tab === "messages" ? (
            messages.map((m) => {
              const isCurrent = m._id === currentMessageId;
              const isHovered = m._id === hoveredId;
              return (
                <div
                  key={m._id}
                  onMouseEnter={(e) => handleItemHover(m._id, e.currentTarget, m)}
                  onMouseLeave={handleItemLeave}
                  onClick={() => {
                    onPin();
                    if (onScrollToMessage) {
                      onScrollToMessage(m._id);
                    } else {
                      useInboxStore.setState({
                        pendingNavigateId: conversationId,
                        pendingScrollToMessageId: m._id,
                      });
                    }
                  }}
                  className={`px-3 py-1.5 cursor-pointer transition-colors flex items-center gap-2 min-w-0 ${
                    isCurrent
                      ? "bg-sol-bg-alt/60"
                      : isHovered
                      ? "bg-sol-bg-alt/40"
                      : ""
                  }`}
                >
                  <div className={`flex-1 min-w-0 text-[12px] truncate leading-snug ${
                    isCurrent
                      ? "text-sol-text font-medium"
                      : m.isCmd
                      ? "text-sol-text-muted font-mono"
                      : "text-sol-text-muted"
                  }`}>
                    {m.display.length > 60 ? m.display.slice(0, 60) + "..." : m.display}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {m.commentCount > 0 && (
                      <span className="text-[10px] text-sol-cyan flex items-center gap-0.5">
                        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                        </svg>
                        {m.commentCount}
                      </span>
                    )}
                    <span className="text-[10px] text-sol-text-dim/60 tabular-nums">{formatTimeAgo(m.timestamp)}</span>
                  </div>
                </div>
              );
            })
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
                  <div className="text-[12px] text-sol-text-muted truncate pl-[22px]">
                    {c.content.length > 80 ? c.content.slice(0, 80) + "..." : c.content}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      {previewMsg && hoveredRect && (
        <HoverPreview message={previewMsg} rect={hoveredRect} />
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
        .map((m: { _id: string; content: string; timestamp: number }) => ({
          _id: m._id,
          ...processUserMessage(m.content),
          timestamp: m.timestamp,
          commentCount: commentsByMessage.get(m._id) || 0,
        }))
        .filter((m: PM) => m.display.length > 0 && !isSystemMessage(m.display))
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

  if (!messages || total === 0) return null;

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
          return (
            <span
              key={i}
              className={`block rounded-full transition-all duration-150 ${
                isActive
                  ? "bg-sol-text w-4 h-[2.5px]"
                  : hasComment
                  ? "bg-sol-cyan w-3.5 h-[2px] opacity-70"
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
