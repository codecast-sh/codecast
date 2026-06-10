// Per-message quote/comment review UI. Replaces the plain <MessageMarkdown> for
// assistant message bodies.
//
// Comments live in a LEFT-HAND rail, each card vertically aligned to the block it
// annotates. When the centered conversation column has empty margin to its left
// (wide screens), the rail FLOATS in that margin so the text column keeps its
// full width; when the margin is too tight it falls back to an in-flow left
// column that shrinks the text. The message renders as ONE MessageMarkdown (no
// splitting); we measure each top-level block's offset with a ResizeObserver and
// place the cards + the hover handle at those offsets.
//
// Cross-component state is in inboxStore's ephemeral review fields; the store
// choreography is in lib/reviewActions.

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";
import type { PendingComment } from "../lib/quoteFormat";
import { createReviewComment, exitReviewMode } from "../lib/reviewActions";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { KeyCap } from "./KeyboardShortcutsHelp";

// Comment-rail sizing (px). When the empty left margin is at least MIN, float the
// rail there at whatever width fits (up to MAX) so the text column keeps its full
// width; below MIN there isn't room for a readable rail, so shrink inline instead.
const RAIL_MAX_PX = 240; // 15rem
const RAIL_MIN_PX = 168; // ~10.5rem — narrowest still-readable margin rail
const RAIL_GAP_PX = 40; // gap between rail and text + clearance from the viewport edge

type Rect = { top: number; height: number };

type Props = {
  conversationId: string;
  messageId: string;
  content: string;
  renderBlock: (content: string) => React.ReactNode;
};

function MessageReviewImpl({ conversationId, messageId, content, renderBlock }: Props) {
  const { user: author } = useCurrentUser();

  const isReviewTarget = useInboxStore((s) => s.reviewMessageId === messageId);
  const activeBlock = useInboxStore((s) => (s.reviewMessageId === messageId ? s.reviewActiveBlock : -1));
  const editingId = useInboxStore((s) => s.reviewEditingId);
  const myComments = useInboxStore(
    useShallow((s) => (s.reviewComments[conversationId] ?? []).filter((c) => c.messageId === messageId)),
  );

  // MODELESS: there is no review mode to enter or exit. Hovering any block always
  // offers Quote/Comment; the rail (and the content-shrink it causes) exists
  // exactly while this message has pending comments — submit/cancel/removing the
  // last comment collapses it back to full width automatically. The keyboard
  // layer (r/arrows/c/q) still uses reviewMessageId, but it's optional sugar.
  const engaged = myComments.length > 0;
  const measureActive = engaged || isReviewTarget;

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const hoverClear = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverTop, setHoverTop] = useState(0);
  const [peekBlock, setPeekBlock] = useState<number | null>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const [stackTops, setStackTops] = useState<Record<string, number>>({});
  // Float the rail in the left margin (content keeps full width) when there's
  // room; otherwise shrink the text column with an in-flow left rail. railPx is
  // the rail width to use in margin mode (clamped to the available margin).
  const [railInMargin, setRailInMargin] = useState(false);
  const [railPx, setRailPx] = useState(RAIL_MAX_PX);

  // Drop a stuck peek highlight: removing a chip via its Remove button unmounts it
  // before onMouseLeave fires, so clear the peek when its block no longer has any
  // comment (or all comments are gone) — otherwise the overlay lingers.
  useEffect(() => {
    if (peekBlock !== null && !myComments.some((c) => c.blockIndex === peekBlock)) setPeekBlock(null);
  }, [myComments, peekBlock]);

  // ----- measure each top-level block's vertical position + available left margin -----
  const measure = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const next = (Array.from(el.children) as HTMLElement[]).map((c) => ({ top: c.offsetTop, height: c.offsetHeight }));
    setRects((prev) =>
      prev.length === next.length && prev.every((r, i) => r.top === next[i].top && r.height === next[i].height)
        ? prev
        : next,
    );
    // Empty space to the left of the content, inside the scroll viewport. Use it
    // for the rail (at whatever width fits) so the text column keeps full width;
    // fall back to shrinking inline only when the margin is too small to be useful.
    const region = containerRef.current;
    if (region) {
      let scroller: HTMLElement | null = region;
      while (scroller && getComputedStyle(scroller).overflowY === "visible") scroller = scroller.parentElement;
      const left = scroller ? scroller.getBoundingClientRect().left : 0;
      const avail = region.getBoundingClientRect().left - left - RAIL_GAP_PX;
      const inMargin = avail >= RAIL_MIN_PX;
      setRailInMargin(inMargin);
      if (inMargin) setRailPx(Math.min(RAIL_MAX_PX, Math.round(avail)));
    }
  }, []);

  // Only measure block offsets while the rail or keyboard nav needs them. Idle
  // messages (the common case) do no measurement work — the hover affordance
  // positions itself from the hovered element directly.
  useLayoutEffect(() => {
    if (measureActive) measure();
  }, [content, measureActive, measure]);

  useEffect(() => {
    if (!measureActive) return;
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    if (containerRef.current) ro.observe(containerRef.current); // catches margin changes (panel toggles, resize)
    Array.from(el.children).forEach((c) => ro.observe(c));
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [content, measureActive, measure]);

  const blockCount = rects.length || 1;

  // ----- stack rail cards: anchor to their block, push down to avoid overlap -----
  const sortedComments = useMemo(
    () => [...myComments].sort((a, b) => a.blockIndex - b.blockIndex || a.createdAt - b.createdAt),
    [myComments],
  );

  useLayoutEffect(() => {
    if (!engaged) return;
    const GAP = 8;
    let prevBottom = -Infinity;
    const tops: Record<string, number> = {};
    for (const c of sortedComments) {
      const anchor = rects[c.blockIndex]?.top ?? 0;
      const top = Math.max(anchor, prevBottom + GAP);
      const h = cardRefs.current.get(c.id)?.offsetHeight ?? 90;
      tops[c.id] = top;
      prevBottom = top + h;
    }
    setStackTops((prev) => {
      const same = Object.keys(tops).length === Object.keys(prev).length && Object.entries(tops).every(([k, v]) => prev[k] === v);
      return same ? prev : tops;
    });
  }, [sortedComments, rects, engaged, editingId]);

  const setActiveBlock = useCallback((i: number) => useInboxStore.getState().setReviewActiveBlock(i), []);

  const blockText = useCallback((i: number): string => {
    const el = contentRef.current?.children?.[i] as HTMLElement | undefined;
    return el ? el.innerText : "";
  }, []);

  const startComment = useCallback(
    (blockIndex: number) => createReviewComment(conversationId, messageId, blockIndex, blockText(blockIndex)),
    [conversationId, messageId, blockText],
  );

  // ----- hover: track the block under the cursor; keep it alive over the rail -----
  const cancelClear = useCallback(() => {
    if (hoverClear.current) {
      clearTimeout(hoverClear.current);
      hoverClear.current = null;
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    cancelClear();
    const content = contentRef.current;
    if (!content) return;
    // Over the rail / a card / the + button → keep the current hover target.
    if (railRef.current?.contains(e.target as Node)) return;
    let el = e.target as HTMLElement | null;
    while (el && el.parentElement !== content) el = el.parentElement;
    if (!el || el.parentElement !== content) return;
    const idx = Array.from(content.children).indexOf(el);
    if (idx >= 0) {
      setHoverIndex(idx);
      setHoverTop(el.offsetTop);
    }
  }, [cancelClear]);

  const handleMouseLeave = useCallback(() => {
    cancelClear();
    hoverClear.current = setTimeout(() => setHoverIndex(null), 140);
  }, [cancelClear]);

  // ----- keyboard nav (only while this message is the review target) -----
  // ↑/↓ (or j/k) move between blocks; c/Enter quotes the active block (like
  // clicking ❝); n/e adds or opens its note; x/⌫ removes it; Esc leaves. The
  // outgoing message auto-attaches the batch on send, so there's no submit key.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isReviewTarget) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      const last = blockCount - 1;
      const cur = useInboxStore.getState().reviewActiveBlock;
      const blockComments = myComments.filter((c) => c.blockIndex === cur);
      const key = e.key;
      if (key === "ArrowDown" || key === "j") {
        e.preventDefault();
        setActiveBlock(Math.min(last, cur + 1));
      } else if (key === "ArrowUp" || key === "k") {
        e.preventDefault();
        setActiveBlock(Math.max(0, cur - 1));
      } else if (key === "c" || key === "Enter") {
        // Quote the active block, or open its note if it's already quoted.
        e.preventDefault();
        if (blockComments.length) useInboxStore.getState().setReviewEditingId(blockComments[0].id);
        else startComment(cur);
      } else if (key === "n" || key === "e") {
        // Add note: open the active block's note editor (quoting it first if needed).
        e.preventDefault();
        const id = blockComments.length ? blockComments[0].id : startComment(cur);
        useInboxStore.getState().setReviewEditingId(id);
      } else if (key === "x" || key === "Delete" || key === "Backspace") {
        if (blockComments.length) {
          e.preventDefault();
          useInboxStore.getState().removeReviewComment(conversationId, blockComments[blockComments.length - 1].id);
        }
      } else if (key === "Escape") {
        e.preventDefault();
        exitReviewMode();
      }
    },
    [isReviewTarget, blockCount, myComments, conversationId, setActiveBlock, startComment],
  );

  // keep active block in view + hold focus so single-letter keys are captured here
  useEffect(() => {
    if (!isReviewTarget || editingId) return;
    (contentRef.current?.children?.[activeBlock] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
    if (containerRef.current && !containerRef.current.contains(document.activeElement)) {
      containerRef.current.focus({ preventScroll: true } as any);
    }
  }, [isReviewTarget, activeBlock, editingId]);

  const focusRegion = useCallback(() => containerRef.current?.focus({ preventScroll: true } as any), []);

  return (
    <div
      ref={containerRef}
      className={"cc-msg-review" + (engaged ? (railInMargin ? " cc-rail-margin" : " cc-rail-inline") : "")}
      style={engaged && railInMargin ? ({ "--cc-rail-w": railPx + "px" } as React.CSSProperties) : undefined}
      data-review-region={isReviewTarget ? "active" : undefined}
      tabIndex={isReviewTarget ? -1 : undefined}
      onKeyDown={isReviewTarget ? handleKeyDown : undefined}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {(() => {
        // Highlight the block a card refers to: the peeked (hovered) card wins,
        // else the keyboard-active block. Replaces the in-card quote as the
        // "what does this comment point at" cue.
        const hi = peekBlock != null ? peekBlock : isReviewTarget ? activeBlock : -1;
        return hi >= 0 && rects[hi] ? (
          <div className="cc-active-overlay" style={{ top: rects[hi].top, height: rects[hi].height }} />
        ) : null;
      })()}

      <div ref={contentRef} className="cc-content">
        {renderBlock(content)}
      </div>

      {/* Modeless single verb: hover any block → one Quote handle in the LEFT
          gutter (separated from the meta actions in the top-right corner). Click
          quotes the block into your reply and opens an optional note; leave the
          note blank for a bare quote. */}
      {hoverIndex !== null && editingId === null && (
        <button
          type="button"
          data-cc-gutter
          className="cc-block-quote"
          style={{ top: hoverTop }}
          title="Quote into your reply"
          aria-label="Quote this block into your reply"
          onMouseEnter={cancelClear}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => startComment(hoverIndex)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9.6 6C7 7.5 5.2 9.9 5.2 13.1c0 2.4 1.5 4 3.5 4 1.8 0 3.1-1.3 3.1-3 0-1.6-1.1-2.8-2.7-2.8-.3 0-.6 0-.7.1.3-1.6 1.6-3.2 3-4.1L9.6 6zm8 0c-2.6 1.5-4.4 3.9-4.4 7.1 0 2.4 1.5 4 3.5 4 1.8 0 3.1-1.3 3.1-3 0-1.6-1.1-2.8-2.7-2.8-.3 0-.6 0-.7.1.3-1.6 1.6-3.2 3-4.1L17.6 6z" />
          </svg>
        </button>
      )}

      {engaged && (
        <div ref={railRef} className="cc-rail">
          {sortedComments.map((c) => (
            <div
              key={c.id}
              ref={(el) => {
                if (el) cardRefs.current.set(c.id, el);
                else cardRefs.current.delete(c.id);
              }}
              className="cc-rail-item"
              style={{ top: stackTops[c.id] ?? rects[c.blockIndex]?.top ?? 0 }}
            >
              {c.id === editingId ? (
                <CommentEditor conversationId={conversationId} comment={c} author={author} onDone={focusRegion} />
              ) : (
                <CommentChip
                  comment={c}
                  author={author}
                  active={isReviewTarget && activeBlock === c.blockIndex}
                  onEdit={() => useInboxStore.getState().setReviewEditingId(c.id)}
                  onRemove={() => { setPeekBlock(null); useInboxStore.getState().removeReviewComment(conversationId, c.id); }}
                  onPeek={() => setPeekBlock(c.blockIndex)}
                  onPeekEnd={() => setPeekBlock(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentAvatar({ author }: { author: any }) {
  const name: string = author?.name || author?.email?.split("@")[0] || "You";
  const src: string | undefined = author?.avatar_url || author?.image || undefined;
  if (src) return <img className="cc-comment-avatar" src={src} alt={name} title={name} />;
  return (
    <span className="cc-comment-avatar cc-comment-avatar-fallback" title={name}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const CommentChip = memo(function CommentChip({
  comment,
  author,
  active,
  onEdit,
  onRemove,
  onPeek,
  onPeekEnd,
}: {
  comment: PendingComment;
  author: any;
  active: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onPeek: () => void;
  onPeekEnd: () => void;
}) {
  return (
    <div
      className={"cc-comment-chip" + (active ? " cc-comment-chip-active" : "")}
      onClick={onEdit}
      onMouseEnter={onPeek}
      onMouseLeave={onPeekEnd}
    >
      <CommentAvatar author={author} />
      <div className="cc-comment-main">
        {comment.body ? (
          <div className="cc-comment-body">{comment.body}</div>
        ) : (
          // Committed bare quote (no note): mark it as a quote of the block so it
          // doesn't read as if the quoted text were the note.
          <div className="cc-comment-quote">
            <span className="cc-comment-quote-mark">❝</span>
            {(comment.quote || "").replace(/\s+/g, " ").trim().slice(0, 90)}
          </div>
        )}
        <div className="cc-comment-actions">
          <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }} className="cc-comment-btn">
            {comment.body ? "Edit" : "Add note"}
            {active && <KeyCap size="xs">N</KeyCap>}
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }} className="cc-comment-btn cc-comment-btn-danger">
            Remove
            {active && <KeyCap size="xs">⌫</KeyCap>}
          </button>
        </div>
      </div>
    </div>
  );
});

function CommentEditor({
  conversationId,
  comment,
  author,
  onDone,
}: {
  conversationId: string;
  comment: PendingComment;
  author: any;
  onDone: () => void;
}) {
  const [value, setValue] = useState(comment.body);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, []);

  const close = useCallback(() => {
    useInboxStore.getState().setReviewEditingId(null);
    onDone();
  }, [onDone]);

  // The quote is committed on first click, so the note editor only edits the
  // optional note: Save stores it (empty keeps it a bare quote), Cancel just
  // closes and leaves the quote untouched. Removing is the chip's explicit Remove.
  const save = useCallback(() => {
    useInboxStore.getState().commitReviewComment(conversationId, comment.id, value.trim());
    close();
  }, [value, conversationId, comment.id, close]);

  const cancel = close;

  return (
    <div className="cc-comment-editor">
      <CommentAvatar author={author} />
      <div className="cc-comment-main">
        <textarea
          ref={ref}
          value={value}
          placeholder="Add a note… (optional)"
          className="cc-comment-textarea"
          onChange={(e) => {
            setValue(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = e.target.scrollHeight + "px";
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={save}
        />
        <div className="cc-comment-editor-footer">
          <button type="button" className="cc-comment-btn" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
            Cancel
            <KeyCap size="xs">Esc</KeyCap>
          </button>
          <button type="button" className="cc-comment-btn cc-comment-btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={save}>
            Save
            <span className="cc-bar-keys"><KeyCap size="xs">⌘</KeyCap><KeyCap size="xs">↵</KeyCap></span>
          </button>
        </div>
      </div>
    </div>
  );
}

export const MessageReview = memo(MessageReviewImpl);
