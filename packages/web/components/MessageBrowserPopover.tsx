"use client";

import { useState, useRef, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ScrollProgressSignal } from "./conversation/scrollProgressSignal";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { MessagePromptPreview } from "./MessagePromptPreview";
import { MachineKindIcon, MachineSourceLabel, AuthorFace, AuthorTag, HoverPreview } from "./MessageNavPreview";
import { AvatarImg } from "../lib/avatarCache";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  buildNavigatorRows,
  filterNavigatorRows,
  hiddenRowsNoun,
  formatTimeAgo,
  sampleTicks,
  activeTickIndex,
  navigatorHeaderLabels,
  countCommentsByMessage,
  mergeNavigatorSources,
  MACHINE_KIND_LABEL,
  resolveNavigatorAuthors,
  authorToneColor,
  possessive,
  type NavigatorRow,
  type NavigatorAuthorship,
} from "../lib/messageNavigator";
import type { SenderContext } from "../lib/messageSender";
import { resolveSessionTitle } from "../lib/sessionTitle";
import { useMountEffect } from "../hooks/useMountEffect";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { shareTokenArg } from "../lib/shareTokenScope";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useConversationCommentSummary } from "../hooks/useConversationCommentsSync";

type CommentEntry = {
  _id: string;
  message_id?: string;
  content: string;
  created_at: number;
  user: { name?: string; github_username?: string; github_avatar_url?: string };
};

function NavDropdown({
  messages,
  authorship,
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
  messages: NavigatorRow[];
  authorship: NavigatorAuthorship;
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
  "use no memo"; // formatTimeAgo() reads the clock as this renders; compiled, the time shown would stop moving.
  const [mounted, setMounted] = useState(false);
  const [search, setSearch] = useState("");
  // Automated rows (triggers, sessions, teammates) and bare "continue" nudges
  // start hidden — the list is primarily a human-message navigator; the chip
  // reveals them on demand.
  const [showMachine, setShowMachine] = useState(false);
  // One person's rows only (their key), from the faces beside the search.
  const [authorKey, setAuthorKey] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(-1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewMsg, setPreviewMsg] = useState<NavigatorRow | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentItemRef = useRef<HTMLDivElement>(null);
  useMountEffect(() => setMounted(true));

  // Keep the highlighted row in view so the list lines up with the prompt
  // at the top of the transcript. On first open with no current row yet,
  // park at the newest message.
  const alignedOnceRef = useRef(false);
  useEffect(() => {
    if (!mounted) {
      alignedOnceRef.current = false;
      return;
    }
    requestAnimationFrame(() => {
      const current = currentItemRef.current;
      const sc = scrollRef.current;
      if (current && sc) {
        const row = current.getBoundingClientRect();
        const box = sc.getBoundingClientRect();
        if (row.top < box.top || row.bottom > box.bottom) {
          current.scrollIntoView({ block: alignedOnceRef.current ? "nearest" : "center" });
        }
        alignedOnceRef.current = true;
        return;
      }
      if (sc && !alignedOnceRef.current) sc.scrollTop = sc.scrollHeight;
    });
  }, [mounted, currentMessageId]);

  const { humanCount, hiddenCount: machineCount, chipLabel } = navigatorHeaderLabels(messages);
  const attributed = authorship.attributed;
  const onlyAuthor = attributed && authorKey ? authorship.authors.find((a) => a.key === authorKey) ?? null : null;
  const filtered = filterNavigatorRows(messages, { search, showHidden: showMachine, authors: authorship, authorKey: onlyAuthor?.key });

  useEffect(() => { setFocusIndex(-1); }, [search, authorKey]);

  const navigateToMessage = useCallback((m: NavigatorRow) => {
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

  const handleItemHover = useCallback((id: string, el: HTMLElement, msg: NavigatorRow) => {
    setHoveredId(id);
    if (previewLeaveTimerRef.current) clearTimeout(previewLeaveTimerRef.current);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (!msg.display && !msg.images?.length) return; // nothing to preview (machine row whose parsed body is empty)
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

  const dropdownWidth = Math.min(420, window.innerWidth - 16);
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
        className="fixed z-[9999] bg-sol-bg-alt border border-sol-blue/30 rounded-lg shadow-2xl overflow-hidden flex flex-col"
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
              placeholder={onlyAuthor ? `Search ${possessive(onlyAuthor)} ${onlyAuthor.count} message${onlyAuthor.count === 1 ? "" : "s"}...` : `Search ${humanCount} messages...`}
              className="flex-1 min-w-0 bg-sol-bg-alt/60 border border-sol-border/20 rounded-lg px-3 py-1.5 text-[12px] text-sol-text placeholder:text-sol-text-dim/40 outline-none focus:border-sol-cyan/40 transition-colors"
            />
            {machineCount > 0 && !onlyAuthor && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowMachine(v => !v); }}
                aria-pressed={showMachine}
                title={`${showMachine ? "Hide" : "Show"} ${machineCount} message${machineCount !== 1 ? "s" : ""} delivered by triggers, other sessions, or teammates, plus bare "continue" messages`}
                className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border text-meta tabular-nums transition-colors flex-shrink-0 ${
                  showMachine
                    ? "bg-sol-violet/15 border-sol-violet/40 text-sol-violet hover:bg-sol-violet/20"
                    : "border-sol-border/30 text-sol-text-dim/60 hover:text-sol-text-muted hover:border-sol-border/50"
                }`}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span className={showMachine ? "" : "line-through decoration-[1.5px] opacity-80"}>
                  {chipLabel}
                </span>
              </button>
            )}
          </div>
        )}
        {tab === "messages" && attributed && (
          // Who wrote in this thread, and a way to read one person's
          // messages alone. The face and color match each row and rail tick.
          <div className="px-3 pb-2 flex flex-wrap items-center gap-1" role="group" aria-label="Show one person's messages">
            {authorship.authors.map((a) => {
              const on = onlyAuthor?.key === a.key;
              return (
                <button
                  key={a.key}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setAuthorKey(on ? null : a.key); }}
                  aria-pressed={on}
                  title={on ? "Show everyone\u2019s messages" : `Show only ${possessive(a)} messages${a.label === a.name || a.label === "You" ? "" : ` (${a.name})`}`}
                  className={`flex items-center gap-1.5 h-6 pl-1 pr-2 rounded-md border text-meta transition-colors max-w-[11rem] ${
                    on
                      ? "bg-sol-cyan/10 border-sol-cyan/50 text-sol-text"
                      : onlyAuthor
                      ? "border-transparent text-sol-text-dim/60 hover:text-sol-text-muted"
                      : "border-sol-border/30 text-sol-text-muted hover:text-sol-text hover:border-sol-border/60"
                  }`}
                >
                  <span className={`flex ${onlyAuthor && !on ? "opacity-50" : ""}`}><AuthorFace author={a} size={16} /></span>
                  <span className="truncate font-medium">{a.label}</span>
                  <span className="tabular-nums text-sol-text-dim">{a.count}</span>
                </button>
              );
            })}
          </div>
        )}
        {hasComments && (
          <div className="flex border-b border-sol-border/20 px-3">
            <button
              onClick={() => onTabChange("messages")}
              className={`text-meta py-1.5 px-2 transition-colors border-b-2 ${
                tab === "messages"
                  ? "text-sol-text border-sol-cyan font-medium"
                  : "text-sol-text-dim hover:text-sol-text-muted border-transparent"
              }`}
            >
              Messages ({humanCount})
            </button>
            <button
              onClick={() => onTabChange("comments")}
              className={`text-meta py-1.5 px-2 transition-colors border-b-2 flex items-center gap-1 ${
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
                {search ? "No matching messages" : onlyAuthor ? `No messages from ${onlyAuthor.label === "You" ? "you" : onlyAuthor.label}` : "No messages"}
              </div>
            ) : (
            filtered.map((m, filterIdx) => {
              const isCurrent = m._id === currentMessageId;
              const isFocused = filterIdx === focusIndex;
              const isHovered = m._id === hoveredId;
              const isActive = isFocused || isHovered;
              if (m.kind !== "user") {
                // Machine-delivered row: mirrors the user-row layout — a label
                // line naming what delivered it (kind + source title), then the
                // actual message body. Slightly subdued to keep human messages
                // primary; the hover preview still shows the full body.
                return (
                  <div
                    key={m._id}
                    data-focus-index={filterIdx}
                    onMouseEnter={(e) => handleItemHover(m._id, e.currentTarget, m)}
                    onMouseLeave={handleItemLeave}
                    onClick={() => navigateToMessage(m)}
                    className={`px-3 py-2 cursor-pointer transition-colors ${
                      isActive ? "bg-sol-blue/15" : "hover:bg-sol-bg-highlight"
                    }`}
                  >
                    <div className={`flex items-start gap-2 transition-opacity ${isActive ? "opacity-100" : "opacity-70"}`}>
                      <span className="w-4 flex-shrink-0 flex justify-end text-sol-violet pt-[2px]">
                        <MachineKindIcon kind={m.kind} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-meta text-sol-violet/80 flex-shrink-0">
                            {MACHINE_KIND_LABEL[m.kind]}
                          </span>
                          <span className="text-meta text-sol-text-muted truncate min-w-0">
                            {m.source && <MachineSourceLabel kind={m.kind} source={m.source} />}
                          </span>
                        </div>
                        {m.display && (
                          <div className={`text-[12px] leading-snug line-clamp-2 mt-0.5 ${
                            isActive ? "text-sol-text" : "text-sol-text-secondary"
                          }`}>
                            {m.display}
                          </div>
                        )}
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="text-meta text-sol-text-dim/50 tabular-nums">
                            {formatTimeAgo(m.timestamp)}
                          </span>
                          {m.commentCount > 0 && (
                            <>
                              <span className="text-sol-text-dim/20">·</span>
                              <span className="text-meta text-sol-cyan flex items-center gap-0.5">
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
              }
              const author = attributed ? authorship.byRow.get(m._id) : undefined;
              const commentBadge = m.commentCount > 0 && (
                <>
                  <span className="text-sol-text-dim/20">·</span>
                  <span className="text-meta text-sol-cyan flex items-center gap-0.5">
                    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                    </svg>
                    {m.commentCount}
                  </span>
                </>
              );
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
                    <span className={`text-meta tabular-nums w-4 text-right flex-shrink-0 pt-[2px] ${
                      isActive || isCurrent ? "text-sol-cyan" : "text-sol-blue/40"
                    }`}>
                      {m.originalIndex + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      {/* With more than one sender the row opens like a chat
                          line: who and when, then what they said. */}
                      {author && (
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <AuthorTag author={author} strong={isActive || isCurrent} />
                          <span className="text-sol-text-dim/30">·</span>
                          <span className="text-meta text-sol-text-dim/60 tabular-nums flex-shrink-0">{formatTimeAgo(m.timestamp)}</span>
                          {commentBadge}
                        </div>
                      )}
                      <MessagePromptPreview content={m.display} images={m.images} messageId={m._id} textClassName={`text-[12px] leading-snug line-clamp-2 ${
                        isActive || isCurrent ? "text-sol-text" : "text-sol-text-secondary"
                      } ${m.isCmd ? "font-mono" : ""} ${isCurrent ? "font-medium" : ""}`} />
                      {!author && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="text-meta text-sol-text-dim/50 tabular-nums">
                            {formatTimeAgo(m.timestamp)}
                          </span>
                          {commentBadge}
                        </div>
                      )}
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
                    <AvatarImg
                      src={c.user?.github_avatar_url}
                      alt=""
                      className="w-4 h-4 rounded-full"
                      fallback={
                        <div className="w-[18px] h-[18px] rounded-full bg-sol-blue/30 flex items-center justify-center text-mark text-sol-blue">
                          {displayName[0]?.toUpperCase()}
                        </div>
                      }
                    />
                    <span className="text-meta text-sol-text-secondary font-medium">{displayName}</span>
                    <span className="text-meta text-sol-text-dim/60 ml-auto">{formatTimeAgo(c.created_at)}</span>
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
        <HoverPreview key={previewMsg._id} message={previewMsg} author={attributed ? authorship.byRow.get(previewMsg._id) : undefined} conversationId={conversationId} rect={hoveredRect} onMouseEnter={cancelDismissPreview} onMouseLeave={dismissPreview} onDropdownEnter={onMouseEnter} onDropdownLeave={onMouseLeave} />
      )}
    </>,
    document.body
  );
}

/** The fewest asks a message rail is drawn for. */
const MIN_RAIL = 2;

const NO_PROGRESS = (): (() => void) => () => {};

export function MessageNavButton({
  conversationId,
  senders,
  currentMessageId,
  scrollProgress,
  onScrollToMessage,
  loadedMessages,
}: {
  conversationId: string;
  /** Who sent what: the transcript's sender context (lib/messageSender). */
  senders: SenderContext;
  currentMessageId: string | null;
  /** The transcript's scroll position (1 when absent). Read through a
   *  subscription, so a scroll frame redraws the rail only when it moves the
   *  active tick. */
  scrollProgress?: ScrollProgressSignal;
  onScrollToMessage?: (messageId: string) => void;
  loadedMessages?: Parameters<typeof mergeNavigatorSources>[1];
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
  const queryUserMessages = useQueryNoThrow(
    api.conversations.getUserMessages,
    canQuery && !cachedUserMessages
      ? { conversation_id: conversationId as Id<"conversations">, ...shareTokenArg(conversationId) }
      : "skip"
  ).data;
  const rawUserMessages = cachedUserMessages ?? queryUserMessages;
  const messages = useMemo(
    () => mergeNavigatorSources(rawUserMessages, loadedMessages),
    [rawUserMessages, loadedMessages],
  );
  const loadedImages = useInboxStore(useShallow((s) => Object.fromEntries(
    (s.messages[conversationId] ?? [])
      .filter(message => message.images !== undefined)
      .map(message => [message._id, message.images])
  )));

  // Used only to decide whether to render a loading skeleton while the cache
  // is still empty. `message_count` includes assistant + system messages, so
  // it's an over-estimate of how many *user* messages the indicator will end
  // up showing — fine for "should we reserve space?"
  const storeMsgCount = useInboxStore((s) => {
    const meta = s.conversations[conversationId] ?? s.sessions[conversationId];
    return (meta as { message_count?: number } | undefined)?.message_count ?? 0;
  });

  const commentSummary = useConversationCommentSummary(conversationId).data;

  const commentsByMessage = countCommentsByMessage(commentSummary);
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
    }
  }

  const processed: NavigatorRow[] = messages
    ? buildNavigatorRows(messages, commentsByMessage, resolveSessionTitle, loadedImages)
    : [];

  // Who sent each row: the transcript's own sender context, so a row and its
  // bubble name the same person.
  const authorship = resolveNavigatorAuthors(processed, senders);

  const total = processed.length;
  const humanTotal = processed.filter((m) => m.kind === "user").length;
  const machineTotal = total - humanTotal;
  const effectiveId = currentMessageId === "__fallback__" ? null : currentMessageId;
  const tickAt = () => activeTickIndex(processed, effectiveId, scrollProgress?.get() ?? 1);
  const activeIndex = useSyncExternalStore(scrollProgress?.subscribe ?? NO_PROGRESS, tickAt, tickAt);

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

  const isLoading = rawUserMessages === undefined && messages.length === 0 && isConvexId(conversationId);

  // Skeleton: query in flight on a conversation with multiple messages.
  // Reserves space + gives a subtle pulse so the indicator doesn't pop in
  // late on big/cold conversations.
  if (isLoading && storeMsgCount >= MIN_RAIL) {
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

  if (!messages || total < MIN_RAIL) return null;

  const MAX_BARS = 72;
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
        className={`flex flex-col ${total > 24 ? "gap-[2px]" : "gap-[3px]"} items-end justify-center px-2 py-1.5 rounded transition-colors relative ${
          open ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text-secondary"
        }`}
        title={`${humanTotal} message${humanTotal !== 1 ? "s" : ""}${authorship.attributed ? ` (${authorship.authors.map((a) => `${a.count} ${a.label === "You" ? "yours" : `from ${a.label}`}`).join(", ")})` : ""}${machineTotal > 0 ? ` / ${machineTotal} ${hiddenRowsNoun(processed.filter((m) => m.kind !== "user"))}` : ""}${hasComments ? ` / ${topLevelComments.length} comment${topLevelComments.length !== 1 ? "s" : ""}` : ""}`}
      >
        {(() => {
          const ticks = sampleTicks(
            processed,
            MAX_BARS,
            activeIndex,
            authorship.attributed ? (row) => authorship.byRow.get(row._id)?.key ?? "" : undefined,
          );
          const here = ticks.findIndex((t) => t.active);
          return ticks.map(({ row: msg, active: isActive }, i) => {
            const hasComment = msg.commentCount > 0;
            const isMachine = msg.kind !== "user";
            const isNear = here >= 0 && Math.abs(i - here) === 1;
            // Someone besides the owner sent it: the tick wears their color.
            const tone = authorship.attributed && !isActive ? authorToneColor(authorship.byRow.get(msg._id)?.tone ?? 0) : undefined;
            return (
              <span
                key={i}
                style={tone ? { backgroundColor: tone } : undefined}
                className={`cc-rail-tick block rounded-full ${
                  isActive
                    ? "cc-rail-here"
                    : isNear
                    ? `${hasComment ? "bg-sol-orange h-[2px]" : "bg-current h-px"} cc-rail-near`
                    : tone
                    ? `w-3 ${hasComment ? "h-[2px]" : "h-[1.5px]"} opacity-55`
                    : hasComment
                    ? "bg-sol-orange w-3.5 h-[2px] opacity-50"
                    : isMachine
                    ? "bg-current w-2 h-px opacity-20"
                    : authorship.attributed
                    // Yours, beside other people's colored ticks.
                    ? "bg-current w-3 h-[1.5px] opacity-75"
                    : "bg-current w-3 h-px opacity-35"
                }`}
              />
            );
          });
        })()}
      </button>
      {open && triggerRect && (
        <NavDropdown
          messages={processed}
          authorship={authorship}
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
