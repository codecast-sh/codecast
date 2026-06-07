// Per-message quote/comment review UI. Replaces the plain <MessageMarkdown> for
// assistant message bodies.
//
// Comments live in a RIGHT-HAND MARGIN RAIL (Google-Docs style), each card
// vertically aligned to the block it annotates — not pushed inline into the text
// flow. To do that the message renders as ONE MessageMarkdown (no splitting), we
// measure each top-level block's offset with a ResizeObserver, and float the rail
// cards + the hover "+" at those offsets. When the rail is active the text column
// shrinks to make room (there's no spare horizontal space beside it).
//
// Cross-component state is in inboxStore's ephemeral review fields; the store
// choreography is in lib/reviewActions.

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";
import type { PendingComment } from "../lib/quoteFormat";
import { createReviewComment, discardIfEmpty, exitReviewMode } from "../lib/reviewActions";
import { useReviewComposer } from "./reviewContext";
import { KeyCap } from "./KeyboardShortcutsHelp";

type Rect = { top: number; height: number };

type Props = {
  conversationId: string;
  messageId: string;
  content: string;
  renderBlock: (content: string) => React.ReactNode;
};

function MessageReviewImpl({ conversationId, messageId, content, renderBlock }: Props) {
  const composer = useReviewComposer();

  const isReviewTarget = useInboxStore((s) => s.reviewMessageId === messageId);
  const activeBlock = useInboxStore((s) => (s.reviewMessageId === messageId ? s.reviewActiveBlock : -1));
  const editingId = useInboxStore((s) => s.reviewEditingId);
  const myComments = useInboxStore(
    useShallow((s) => (s.reviewComments[conversationId] ?? []).filter((c) => c.messageId === messageId)),
  );

  // The rail (and the content-shrinking it causes) is shown only WHILE actively
  // reviewing this message. Esc/Cancel clears reviewMessageId → rail collapses →
  // content returns to full width. Pending comments persist in the store and stay
  // visible in the ReviewBar; re-opening review on the message shows them again.
  const engaged = isReviewTarget;

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

  // ----- measure each top-level block's vertical position -----
  const measure = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const next = (Array.from(el.children) as HTMLElement[]).map((c) => ({ top: c.offsetTop, height: c.offsetHeight }));
    setRects((prev) =>
      prev.length === next.length && prev.every((r, i) => r.top === next[i].top && r.height === next[i].height)
        ? prev
        : next,
    );
  }, []);

  // Only measure block offsets while engaged — that's the only time rects feed
  // the rail/overlay. Idle messages (the common case) do no measurement work.
  useLayoutEffect(() => {
    if (engaged) measure();
  }, [content, engaged, measure]);

  useEffect(() => {
    if (!engaged) return;
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [content, engaged, measure]);

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
      } else if ((key === "c" || key === "Enter") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        composer?.submit();
      } else if (key === "c" || key === "Enter") {
        e.preventDefault();
        startComment(cur);
      } else if (key === "q") {
        e.preventDefault();
        composer?.quote(blockText(cur));
      } else if (key === "e") {
        e.preventDefault();
        if (blockComments.length) useInboxStore.getState().setReviewEditingId(blockComments[0].id);
        else startComment(cur);
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
    [isReviewTarget, blockCount, myComments, conversationId, composer, setActiveBlock, startComment, blockText],
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
      className={"cc-msg-review" + (engaged ? " cc-rail-on" : "")}
      data-review-region={isReviewTarget ? "active" : undefined}
      tabIndex={isReviewTarget ? -1 : undefined}
      onKeyDown={isReviewTarget ? handleKeyDown : undefined}
      onMouseMove={engaged ? handleMouseMove : undefined}
      onMouseLeave={engaged ? handleMouseLeave : undefined}
    >
      {isReviewTarget && rects[activeBlock] && (
        <div className="cc-active-overlay" style={{ top: rects[activeBlock].top, height: rects[activeBlock].height }} />
      )}

      <div ref={contentRef} className="cc-content">
        {renderBlock(content)}
      </div>

      {engaged && (
        <div ref={railRef} className="cc-rail">
          {sortedComments.length === 0 && (
            <div className="cc-rail-empty">Hover a block and click +, or press c, to comment</div>
          )}
          {hoverIndex !== null && editingId === null && (
            <button
              type="button"
              data-cc-gutter
              className="cc-block-add"
              style={{ top: hoverTop }}
              title="Comment on this block"
              aria-label="Comment on this block"
              onMouseEnter={cancelClear}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => startComment(hoverIndex)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
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
                <CommentEditor conversationId={conversationId} comment={c} onDone={focusRegion} />
              ) : (
                <CommentChip
                  comment={c}
                  active={isReviewTarget && activeBlock === c.blockIndex}
                  onEdit={() => useInboxStore.getState().setReviewEditingId(c.id)}
                  onRemove={() => useInboxStore.getState().removeReviewComment(conversationId, c.id)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CommentChip = memo(function CommentChip({
  comment,
  active,
  onEdit,
  onRemove,
  onPeek,
  onPeekEnd,
}: {
  comment: PendingComment;
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
      <div className="cc-comment-body">{comment.body || <span className="cc-comment-empty">Add a comment…</span>}</div>
      <div className="cc-comment-actions">
        <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }} className="cc-comment-btn">Edit</button>
        <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }} className="cc-comment-btn cc-comment-btn-danger">Remove</button>
      </div>
    </div>
  );
});

function CommentEditor({
  conversationId,
  comment,
  onDone,
}: {
  conversationId: string;
  comment: PendingComment;
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

  const save = useCallback(() => {
    const body = value.trim();
    if (!body) useInboxStore.getState().removeReviewComment(conversationId, comment.id);
    else useInboxStore.getState().updateReviewComment(conversationId, comment.id, body);
    close();
  }, [value, conversationId, comment.id, close]);

  const cancel = useCallback(() => {
    discardIfEmpty(conversationId, comment.id);
    close();
  }, [conversationId, comment.id, close]);

  return (
    <div className="cc-comment-editor">
      <textarea
        ref={ref}
        value={value}
        placeholder="Add a comment…"
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
        onBlur={() => {
          if (!value.trim()) discardIfEmpty(conversationId, comment.id);
        }}
      />
      <div className="cc-comment-editor-footer">
        <button type="button" className="cc-comment-btn" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>Cancel</button>
        <button type="button" className="cc-comment-btn cc-comment-btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={save}>Save</button>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  const flat = (s || "").replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

export const MessageReview = memo(MessageReviewImpl);
