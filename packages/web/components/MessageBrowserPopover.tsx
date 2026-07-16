"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isCommandMessage, cleanContent } from "../lib/conversationProcessor";
import { parseMachineDeliveredMessage, type MachineDeliveredKind } from "./sessionMessage";
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

const MACHINE_KIND_LABEL: Record<MachineDeliveredKind, string> = {
  schedule: "schedule",
  session: "session",
  teammate: "teammate",
};

function MachineKindIcon({ kind }: { kind: MachineDeliveredKind }) {
  const d =
    kind === "schedule"
      ? "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      : kind === "session"
      ? "M13 7l5 5m0 0l-5 5m5-5H6"
      : "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z";
  return (
    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
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

type PM = {
  _id: string;
  display: string;
  isCmd: boolean;
  timestamp: number;
  commentCount: number;
  kind: "user" | MachineDeliveredKind;
  source?: string;
};

type CommentEntry = {
  _id: string;
  message_id?: string;
  content: string;
  created_at: number;
  user: { name?: string; github_username?: string; github_avatar_url?: string };
};

// originalIndex is the human-message ordinal (what the row numbers show);
// machine-delivered rows carry -1 and render unnumbered.
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
          {message.kind === "user" ? (
            <span className="text-[10px] text-sol-text-dim tabular-nums">#{message.originalIndex + 1}</span>
          ) : (
            <span className="text-[10px] text-sol-violet/80 flex items-center gap-1">
              <MachineKindIcon kind={message.kind} />
              {message.source}
            </span>
          )}
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
  const [showMachine, setShowMachine] = useState(true);
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

  // On open, default to the latest message (bottom). The current message stays
  // highlighted via currentItemRef, but we don't scroll to center on it —
  // newest-first is what's most relevant when the browser pops.
  useEffect(() => {
    if (mounted) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [mounted]);

  let humanOrdinal = 0;
  const indexed: IndexedPM[] = messages.map((m) => ({
    ...m,
    originalIndex: m.kind === "user" ? humanOrdinal++ : -1,
  }));
  const humanCount = humanOrdinal;
  const machineCount = indexed.length - humanCount;
  const pool = showMachine ? indexed : indexed.filter((m) => m.kind === "user");
  const filtered = search
    ? pool.filter(m => `${m.display} ${m.source ?? ""}`.toLowerCase().includes(search.toLowerCase()))
    : pool;

  useEffect(() => { setFocusIndex(-1); }, [search]);

  const navigateToMessage = useCallback((m: PM) => {
    onPin();
    if (onScrollToMessage) {
      onScrollToMessage(m._id);
    } else {
      useInboxStore.getState().requestNavigate(conversationId, { scrollToMessageId: m._id });
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
    if (!msg.display) return; // nothing to preview (machine row whose parsed body is empty)
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
  // Top-align the panel to the trigger. The nav button itself sits below the
  // header's sticky-message banner, so top-aligning here keeps the panel clear
  // of that banner without pushing it unnecessarily far down.
  const top = Math.max(margin, triggerRect.top);

  const hasComments = comments.length > 0;

  return createPortal(
    <>
      {pinned && <div className="fixed inset-0 z-[9998] pointer-events-auto" onClick={onClose} />}
      <div
        className="fixed z-[9999] bg-sol-bg-alt/99 backdrop-blur-md border border-sol-blue/30 rounded-lg shadow-2xl overflow-hidden flex flex-col"
        style={{ top, left, width: dropdownWidth, maxHeight: "min(600px, 75vh)" }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={onPin}
      >
        {tab === "messages" && (
          <div className="px-3 pt-3 pb-2 flex items-center gap-1.5">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`Search ${humanCount} messages...`}
              className="flex-1 min-w-0 bg-sol-bg-alt/60 border border-sol-border/20 rounded-lg px-3 py-1.5 text-[12px] text-sol-text placeholder:text-sol-text-dim/40 outline-none focus:border-sol-cyan/40 transition-colors"
            />
            {machineCount > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowMachine(v => !v); }}
                title={showMachine
                  ? `Hide ${machineCount} automated message${machineCount !== 1 ? "s" : ""} (schedules, sessions, teammates)`
                  : `Show ${machineCount} automated message${machineCount !== 1 ? "s" : ""}`}
                className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[10px] tabular-nums transition-colors flex-shrink-0 ${
                  showMachine
                    ? "border-sol-violet/30 text-sol-violet/80 hover:text-sol-violet"
                    : "border-sol-border/20 text-sol-text-dim/40 hover:text-sol-text-dim"
                }`}
              >
                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {machineCount}
              </button>
            )}
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
              Messages ({humanCount})
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
              const isActive = isFocused || isHovered;
              if (m.kind !== "user") {
                // Machine-delivered row: one subdued line naming what delivered it
                // and from where — the body stays behind the hover preview.
                return (
                  <div
                    key={m._id}
                    data-focus-index={filterIdx}
                    onMouseEnter={(e) => handleItemHover(m._id, e.currentTarget, m)}
                    onMouseLeave={handleItemLeave}
                    onClick={() => navigateToMessage(m)}
                    className={`px-3 py-1 cursor-pointer transition-colors ${
                      isActive ? "bg-sol-blue/15" : "hover:bg-sol-bg-highlight"
                    }`}
                  >
                    <div className={`flex items-center gap-2 transition-opacity ${isActive ? "opacity-90" : "opacity-45"}`}>
                      <span className="w-4 flex-shrink-0 flex justify-end text-sol-violet">
                        <MachineKindIcon kind={m.kind} />
                      </span>
                      <span className="text-[10px] text-sol-text-dim flex-shrink-0">
                        {MACHINE_KIND_LABEL[m.kind]}
                      </span>
                      <span className="text-[11px] text-sol-text-muted truncate min-w-0">{m.source}</span>
                      {m.commentCount > 0 && (
                        <span className="text-[10px] text-sol-cyan flex items-center gap-0.5 flex-shrink-0">
                          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                          </svg>
                          {m.commentCount}
                        </span>
                      )}
                      <span className="text-[10px] text-sol-text-dim/50 tabular-nums ml-auto flex-shrink-0">
                        {formatTimeAgo(m.timestamp)}
                      </span>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={m._id}
                  ref={isCurrent ? currentItemRef : undefined}
                  data-focus-index={filterIdx}
                  onMouseEnter={(e) => handleItemHover(m._id, e.currentTarget, m)}
                  onMouseLeave={handleItemLeave}
                  onClick={() => navigateToMessage(m)}
                  className={`px-3 py-2 cursor-pointer transition-colors ${
                    isActive
                      ? "bg-sol-blue/20"
                      : isCurrent
                      ? "bg-sol-blue/10"
                      : "hover:bg-sol-bg-highlight"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`text-[10px] tabular-nums w-4 text-right flex-shrink-0 pt-[2px] ${
                      isActive || isCurrent ? "text-sol-cyan" : "text-sol-blue/40"
                    }`}>
                      {m.originalIndex + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[12px] leading-snug line-clamp-2 ${
                        isActive || isCurrent ? "text-sol-text" : "text-sol-text-secondary"
                      } ${m.isCmd ? "font-mono" : ""} ${isCurrent ? "font-medium" : ""}`}>
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
                        useInboxStore.getState().requestNavigate(conversationId, { scrollToMessageId: c.message_id });
                      }
                    }
                  }}
                  className={`px-3 py-2 cursor-pointer transition-colors ${
                    isHovered ? "bg-sol-blue/20" : "hover:bg-sol-bg-highlight"
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

  const canQuery = isConvexId(conversationId);

  // Source from the complete, pagination-independent user-message cache that
  // useConversationMessages keeps populated (same list the rewind navigator
  // uses). The indicator must reflect the WHOLE conversation regardless of
  // which message window is scrolled in — reading the paginated array instead
  // meant it stayed empty (or hidden) until earlier pages were loaded.
  const cachedUserMessages = useInboxStore((s) => s.userMessages[conversationId]);
  // Fallback query only while the shared cache hasn't landed yet (Convex dedups
  // it against useConversationMessages' identical subscription). Never falls
  // back to the truncated paginated set.
  const queryUserMessages = useQuery(
    api.conversations.getUserMessages,
    canQuery && !cachedUserMessages ? { conversation_id: conversationId as Id<"conversations"> } : "skip"
  );
  const messages = cachedUserMessages ?? queryUserMessages;

  // Used only to decide whether to render a loading skeleton while the cache
  // is still empty. `message_count` includes assistant + system messages, so
  // it's an over-estimate of how many *user* messages the indicator will end
  // up showing — fine for "should we reserve space?"
  const storeMsgCount = useInboxStore((s) => {
    const meta = s.conversations[conversationId] ?? s.sessions[conversationId];
    return (meta as { message_count?: number } | undefined)?.message_count ?? 0;
  });

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
        .map((m: { _id: string; content?: string; timestamp: number }): PM => {
          const content = m.content ?? "";
          const commentCount = commentsByMessage.get(m._id) || 0;
          // Machine-delivered messages (cast send, teammate broadcasts, schedule
          // triggers) list as compact subdued rows rather than being dropped —
          // human rows keep their numbering regardless.
          const machine = parseMachineDeliveredMessage(content);
          if (machine) {
            return {
              _id: m._id,
              display: machine.body,
              isCmd: false,
              timestamp: m.timestamp,
              commentCount,
              kind: machine.kind,
              source: machine.source,
            };
          }
          return {
            _id: m._id,
            ...processUserMessage(content),
            timestamp: m.timestamp,
            commentCount,
            kind: "user" as const,
          };
        })
        .filter((m: PM) => m.kind !== "user" || m.display.length > 0)
    : [];

  const total = processed.length;
  const humanTotal = processed.filter((m) => m.kind === "user").length;
  const machineTotal = total - humanTotal;
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

  const isLoading = messages === undefined && isConvexId(conversationId);

  // Skeleton: query in flight on a conversation with multiple messages.
  // Reserves space + gives a subtle pulse so the indicator doesn't pop in
  // late on big/cold conversations.
  if (isLoading && storeMsgCount > 1) {
    const skeletonCount = Math.min(Math.max(storeMsgCount, 6), 16);
    return (
      <div
        className="flex flex-col gap-[3px] items-end justify-center px-2 py-1.5 rounded text-sol-text-dim animate-pulse"
        aria-hidden
      >
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <span key={i} className="block rounded-full bg-current w-3 h-px opacity-50" />
        ))}
      </div>
    );
  }

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
        title={`${humanTotal} message${humanTotal !== 1 ? "s" : ""}${machineTotal > 0 ? ` / ${machineTotal} automated` : ""}${hasComments ? ` / ${topLevelComments.length} comment${topLevelComments.length !== 1 ? "s" : ""}` : ""}`}
      >
        {Array.from({ length: displayCount }).map((_, i) => {
          const mappedIndex = total <= MAX_BARS ? i : Math.round((i / (displayCount - 1)) * (total - 1));
          const isActive = mappedIndex === activeIndex;
          const msg = processed[mappedIndex];
          const hasComment = msg && msg.commentCount > 0;
          const isMachine = msg && msg.kind !== "user";
          return (
            <span
              key={i}
              className={`block rounded-full transition-all duration-150 ${
                isActive
                  ? "bg-sol-text w-4 h-[2.5px]"
                  : hasComment
                  ? "bg-sol-cyan w-3.5 h-[2px] opacity-70"
                  : isMachine
                  ? "bg-current w-2 h-px opacity-20"
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
