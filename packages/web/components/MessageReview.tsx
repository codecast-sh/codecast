// Per-message quote/comment review UI. Replaces the plain <MessageMarkdown> for
// assistant message bodies.
//
// Comments live in a LEFT-HAND rail, each card vertically aligned to the block it
// annotates. When the centered conversation column has empty margin to its left
// (wide screens), the rail FLOATS in that margin so the text column keeps its
// full width; when the margin is too tight it falls back to an in-flow left
// column that shrinks the text. The message renders as ONE MessageMarkdown (no
// splitting); we measure each quote unit's offset with a ResizeObserver and place
// the cards + the hover handle at those offsets. A "unit" is a top-level block,
// except a bulleted/numbered list, which is split into one unit per <li> so each
// bullet is independently quotable (see lib/quoteUnits).
//
// Cross-component state is in inboxStore's ephemeral review fields; the store
// choreography is in lib/reviewActions.

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";
import type { PendingComment } from "../lib/quoteFormat";
import { AvatarImg } from "../lib/avatarCache";
import { getQuoteUnits, quoteUnitAt, unitTop } from "../lib/quoteUnits";
import { createReviewComment, exitReviewMode } from "../lib/reviewActions";
import { quoteSelectionIntoReply } from "../lib/quoteSelection";
import { stepReviewBlock } from "../lib/reviewNav";
import { altChordDirection } from "../shortcuts";
import { focusComposer } from "../lib/composerControl";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { KeyCap, MenuKeyCaps } from "./KeyboardShortcutsHelp";
import { RightCommentRail } from "./comments/RightCommentRail";

// Comment-rail sizing (px). When the empty left margin is at least MIN, float the
// rail there at whatever width fits (up to MAX) so the text column keeps its full
// width; below MIN there isn't room for a readable rail, so shrink inline instead.
const RAIL_MAX_PX = 240; // 15rem
const RAIL_MIN_PX = 168; // ~10.5rem — narrowest still-readable margin rail
const RAIL_GAP_PX = 40; // gap between rail and text + clearance from the viewport edge

// Right-hand teammate-comment rail (mirror of the left quote rail). Same idea:
// float in the right margin when it fits; otherwise shrink the text into a right
// column so the comments still sit beside the message instead of below it.
const RIGHT_MAX_PX = 300;
const RIGHT_MIN_PX = 188;

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
  // Opt-in: the gutter "comment" handle (starting a NEW thread on a message) only
  // shows when the user has turned comment tools on. Seeing/replying to existing
  // comments doesn't depend on it.
  const commentsEnabled = useInboxStore((s) => s.clientState.ui?.comments_enabled ?? false);
  const myComments = useInboxStore(
    useShallow((s) => (s.reviewComments[conversationId] ?? []).filter((c) => c.messageId === messageId)),
  );
  // The footer belongs to the BATCH, not to keyboard mode. Escape drops the review
  // target but KEEPS the quotes (exitReviewMode), and that is exactly the moment a
  // user steps back and asks "now what?" — so the footer has to outlive the target.
  // Exactly one message carries it: the review target while there is one, else the
  // message holding the newest quote. Returns a plain id, so the selector is cheap.
  const footerOwner = useInboxStore((s) => {
    const list = s.reviewComments[conversationId] ?? [];
    if (!list.length) return null;
    const target = s.reviewMessageId;
    if (target && list.some((c) => c.messageId === target)) return target;
    return list[list.length - 1].messageId;
  });

  // MODELESS: there is no review mode to enter or exit. Hovering any block always
  // offers Quote/Comment; the rail (and the content-shrink it causes) exists
  // exactly while this message has pending comments — submit/cancel/removing the
  // last comment collapses it back to full width automatically. The keyboard
  // layer (r/arrows/c/q) still uses reviewMessageId, but it's optional sugar.
  const engaged = myComments.length > 0;

  // Persisted teammate comments on THIS message drive the right rail. A primitive
  // count keeps the selector cheap (re-renders only when it changes); the anchor
  // lets the gutter handle open the rail on a message that has none yet.
  const teamCount = useInboxStore((s) => {
    const cs = s.comments as Record<string, { conversation_id?: string; message_id?: string }>;
    let n = 0;
    for (const id in cs) {
      const c = cs[id];
      if (c.conversation_id === conversationId && c.message_id === messageId) n++;
    }
    return n;
  });
  const teamAnchor = useInboxStore((s) => s.commentRailAnchor === messageId);
  const rightActive = teamCount > 0 || teamAnchor;

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
  // Bottom of the last stacked card — where the rail footer (what happens next
  // with these quotes) hangs.
  const [railBottom, setRailBottom] = useState(0);
  // Float the rail in the left margin (content keeps full width) when there's
  // room; otherwise shrink the text column with an in-flow left rail. railPx is
  // the rail width to use in margin mode (clamped to the available margin).
  const [railInMargin, setRailInMargin] = useState(false);
  const [railPx, setRailPx] = useState(RAIL_MAX_PX);
  // Right comment rail placement: "margin" floats in the empty right margin;
  // "column" shrinks the text into a readable right column (only when the text can
  // spare the width); "below" drops clean cards under the message when it's too
  // narrow to sit beside. rightW is the rail/column width.
  const [rightMode, setRightMode] = useState<"margin" | "column" | "below">("below");
  const [rightW, setRightW] = useState(RIGHT_MAX_PX);
  // In margin mode the rail floats absolutely (top:0) in the right margin. If a
  // comment thread is TALLER than its (short) message, the rail overflows below
  // the message — and absolute overflow still grows the scroll CONTAINER's
  // height, so it paints empty scrollable space under the transcript (most
  // visible on the last message). Reserve the rail's height as the row's
  // min-height so the row measures to include it: no overflow, no phantom space.
  const [rightReserveH, setRightReserveH] = useState(0);

  // Measure block offsets while the rail/keyboard nav needs them OR while hovering:
  // the hover handle must track its block live, because content above can reflow
  // after the mouse stops (web font load, syntax highlighting, image settle) and a
  // frozen offset would leave the handle stranded on the block's lower lines.
  const measureActive = engaged || isReviewTarget || hoverIndex !== null || rightActive;

  // Drop a stuck peek highlight: removing a chip via its Remove button unmounts it
  // before onMouseLeave fires, so clear the peek when its block no longer has any
  // comment (or all comments are gone) — otherwise the overlay lingers.
  useEffect(() => {
    if (peekBlock !== null && !myComments.some((c) => c.blockIndex === peekBlock)) setPeekBlock(null);
  }, [myComments, peekBlock]);

  // ----- measure each quote unit's vertical position + available left margin -----
  const measure = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    // Layout-space offsets (offsetTop/offsetHeight), not bounding rects, so the
    // rail cards + hover handle stay aligned under browser zoom — see unitTop.
    const next = getQuoteUnits(el).map((u) => ({ top: unitTop(el, u), height: u.offsetHeight }));
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
      const rr = region.getBoundingClientRect();
      const sr = scroller ? scroller.getBoundingClientRect() : null;
      const left = sr ? sr.left : 0;
      const avail = rr.left - left - RAIL_GAP_PX;
      const inMargin = avail >= RAIL_MIN_PX;
      setRailInMargin(inMargin);
      if (inMargin) setRailPx(Math.min(RAIL_MAX_PX, Math.round(avail)));

      // Publish the visible gutter on each side so the hover handles can clamp
      // to it: the scroller clips (left) or grows scrollable overflow (right)
      // past these edges. Simple view flattens the pl-8 indent the handles'
      // fixed offsets assumed, so their CSS reads these to hug the edge instead
      // of getting cut or covering text.
      region.style.setProperty("--cc-gutter-l", Math.max(0, Math.round(rr.left - left)) + "px");
      const clipRight = sr && scroller ? sr.left + scroller.clientLeft + scroller.clientWidth : window.innerWidth;
      region.style.setProperty("--cc-gutter-r", Math.max(0, Math.round(clipRight - rr.right)) + "px");

      // Mirror on the right: float in the empty right margin when it fits (the
      // text keeps full width, exactly like the left quote rail). When there's no
      // margin — the right edge already carries the toolbar + "files changed" chip
      // and a squeezed column would collide with them — drop clean cards below so
      // the message stays readable. (column mode kept in the union for later.)
      const availR = (sr ? sr.right : window.innerWidth) - rr.right - RAIL_GAP_PX;
      const inMarginR = availR >= RIGHT_MIN_PX;
      setRightMode(inMarginR ? "margin" : "below");
      if (inMarginR) setRightW(Math.min(RIGHT_MAX_PX, Math.round(availR)));
      // Reserve the floating margin rail's height so it can't overflow below the
      // message (see rightReserveH). Only margin mode floats — "below" is in-flow
      // and already measured, so it needs no reservation.
      const railEl = region.querySelector(".cc-rright") as HTMLElement | null;
      setRightReserveH(inMarginR && railEl ? railEl.offsetHeight : 0);
    }
  }, []);

  // Measure block offsets only while needed (rail open, keyboard nav, or hovering).
  // Idle messages — the common case — do no measurement work; the ResizeObserver
  // below keeps rects fresh against reflow for the whole time the handle is shown.
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
    getQuoteUnits(el).forEach((u) => ro.observe(u));
    // Re-reserve when the comment thread itself grows/shrinks: the rail floats
    // absolutely, so its size changes don't resize containerRef on their own.
    const railEl = containerRef.current?.querySelector(".cc-rright");
    if (railEl) ro.observe(railEl);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [content, measureActive, measure]);

  // ----- stack rail cards: anchor to their block, push down to avoid overlap -----
  const sortedComments = useMemo(
    () => [...myComments].sort((a, b) => a.blockIndex - b.blockIndex || a.createdAt - b.createdAt),
    [myComments],
  );

  const restack = useCallback(() => {
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
    if (Number.isFinite(prevBottom)) setRailBottom(prevBottom + GAP * 2);
  }, [sortedComments, rects, engaged]);

  useLayoutEffect(() => { restack(); }, [restack, editingId]);

  // The open editor autosizes its textarea on every keystroke — a height change
  // local to that card, invisible to this component's render cycle — so watch
  // the cards themselves; otherwise the stack (and the footer hanging under it)
  // freezes while the editor grows over it.
  useEffect(() => {
    if (!engaged) return;
    const ro = new ResizeObserver(() => restack());
    cardRefs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [engaged, restack]);

  const blockText = useCallback((i: number): string => {
    const el = getQuoteUnits(contentRef.current)[i];
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
    const hit = quoteUnitAt(content, e.target as HTMLElement);
    if (hit) {
      setHoverIndex(hit.index);
      setHoverTop(unitTop(content, hit.el));
    }
  }, [cancelClear]);

  const handleMouseLeave = useCallback(() => {
    cancelClear();
    hoverClear.current = setTimeout(() => setHoverIndex(null), 140);
  }, [cancelClear]);

  // ----- keyboard nav (only while this message is the review target) -----
  // ↑/↓ (j/k, ⌥J/⌥K) walk chunks, crossing into the neighbouring reply at
  // either edge and back into the composer past the last; c/Enter (or n/e) quotes
  // the active block and opens its note (like clicking ❝); x/⌫ removes it; Esc leaves. The
  // outgoing message auto-attaches the batch on send, so there's no submit key.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isReviewTarget) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      const cur = useInboxStore.getState().reviewActiveBlock;
      const blockComments = myComments.filter((c) => c.blockIndex === cur);
      const key = e.key;
      // `r` quotes the current text selection — the same key the floating
      // selection button advertises. The global conv.review shortcut can't reach
      // us here: this region owns its single-letter keys (data-review-region),
      // so the dispatcher skips it once focus is inside.
      if (key === "r") {
        if (quoteSelectionIntoReply(conversationId)) {
          e.preventDefault();
          return;
        }
      }
      // ↑/↓, j/k and the ⌥J/⌥K chords all walk chunks; the walker crosses into
      // the neighbouring reply at either edge and drops back into the composer
      // past the last chunk (lib/reviewNav).
      const chord = altChordDirection(e.nativeEvent);
      const dir = chord === "up" || chord === "down" ? chord
        : key === "ArrowDown" || key === "j" ? "down"
        : key === "ArrowUp" || key === "k" ? "up"
        : null;
      if (dir) {
        e.preventDefault();
        stepReviewBlock(messageId, dir === "down" ? 1 : -1);
      } else if (key === "c" || key === "Enter" || key === "n" || key === "e") {
        // Quote the active block and write its note: quoting opens the editor
        // (createReviewComment); on an already-quoted block just reopen it.
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
    [isReviewTarget, myComments, conversationId, messageId, startComment],
  );

  // keep active block in view + hold focus so single-letter keys are captured here
  useEffect(() => {
    if (!isReviewTarget || editingId) return;
    getQuoteUnits(contentRef.current)[activeBlock]?.scrollIntoView({ block: "nearest" });
    if (containerRef.current && !containerRef.current.contains(document.activeElement)) {
      containerRef.current.focus({ preventScroll: true } as any);
    }
  }, [isReviewTarget, activeBlock, editingId]);

  const focusRegion = useCallback(() => containerRef.current?.focus({ preventScroll: true } as any), []);

  // Walk between YOUR quote cards while writing notes (⌘↑ / ⌘↓ in the editor):
  // open the neighbour's note, or close and hand focus back to the region when
  // you step past either end. The editor saves before calling this.
  const stepEditor = useCallback(
    (from: number, delta: number) => {
      const next = sortedComments[from + delta];
      const s = useInboxStore.getState();
      if (!next) {
        s.setReviewEditingId(null);
        focusRegion();
        return;
      }
      s.setReviewEditingId(next.id);
      s.setReviewActiveBlock(next.blockIndex);
    },
    [sortedComments, focusRegion],
  );

  return (
    <div
      ref={containerRef}
      className={
        "cc-msg-review" +
        (engaged ? (railInMargin ? " cc-rail-margin" : " cc-rail-inline") : "") +
        (rightActive && rightMode === "column" ? " cc-rright-host-inline" : "")
      }
      style={{
        ...(engaged && railInMargin ? { "--cc-rail-w": railPx + "px" } : {}),
        ...(rightActive && rightMode !== "below" ? { "--cc-rright-w": rightW + "px" } : {}),
        ...(rightActive && rightMode === "margin" && rightReserveH ? { minHeight: rightReserveH } : {}),
      } as React.CSSProperties}
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
        if (hi < 0 || !rects[hi]) return null;
        // The keyboard-lit chunk names its verb: an unquoted block shows the
        // quote key at its top-right (a quoted one already shows N / ⌫ on its
        // chip). A sibling of the overlay, not a child — the overlay sits behind
        // the text, and this must sit above it.
        const hint = peekBlock == null && isReviewTarget && !editingId && !myComments.some((c) => c.blockIndex === hi);
        return (
          <>
            <div className="cc-active-overlay" style={{ top: rects[hi].top, height: rects[hi].height }} />
            {hint && (
              <div className="cc-active-hint" style={{ top: rects[hi].top }}>
                <KeyCap size="xs">C</KeyCap>
                quote
              </div>
            )}
          </>
        );
      })()}

      <div ref={contentRef} className="cc-content">
        {renderBlock(content)}
      </div>

      {/* Modeless single verb: hover any block → one Quote handle in the LEFT
          gutter (separated from the meta actions in the top-right corner). Click
          quotes the block into your reply and opens its note focused; leave the
          note blank for a bare quote. */}
      {hoverIndex !== null && editingId === null && (
        <button
          type="button"
          data-cc-gutter
          className="cc-block-quote"
          // Prefer the live measured offset (re-measured on reflow) over the
          // mousemove snapshot, so the handle stays pinned to its block's top
          // even if content above shifts after the cursor stops. hoverTop is the
          // first-frame fallback before rects has measured.
          style={{ top: rects[hoverIndex]?.top ?? hoverTop }}
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

      {/* Mirror of the quote handle on the RIGHT gutter: open a teammate comment
          thread anchored to this whole message in the comment rail. */}
      {commentsEnabled && hoverIndex !== null && editingId === null && (
        <button
          type="button"
          data-cc-gutter
          className="cc-block-comment"
          style={{ top: hoverTop }}
          title="Comment for your team"
          aria-label="Comment on this message for your team"
          onMouseEnter={cancelClear}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useInboxStore.getState().openCommentThread(messageId)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
      )}

      {engaged && (
        <div ref={railRef} className="cc-rail">
          {sortedComments.map((c, i) => (
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
                <CommentEditor
                  conversationId={conversationId}
                  comment={c}
                  author={author}
                  onDone={focusRegion}
                  onStep={sortedComments.length > 1 ? (delta) => stepEditor(i, delta) : undefined}
                />
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

          {/* One quiet line: the quotes ride along on the next send, so the only
              thing worth saying is how to get to the input. Clicking it does the
              same as the key. Everything else the rail used to spell out — the
              count, a send button, the per-card keys — was noise beside cards
              that already show all of it. */}
          {footerOwner === messageId && (
            <button
              type="button"
              className="cc-rail-foot"
              style={{ top: railBottom }}
              // Without this, mousedown blurs an open note editor, the stack
              // collapses, and this button jumps away before mouseup — the click
              // never lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={focusComposer}
            >
              <MenuKeyCaps action="compose.focus" />
              to reply
            </button>
          )}
        </div>
      )}

      {/* Teammate comments for this message, mirrored to the RIGHT of the text:
          floating in the margin when it fits, else a shrink-the-text column. */}
      {rightActive && (
        <RightCommentRail conversationId={conversationId} messageId={messageId} mode={rightMode} />
      )}
    </div>
  );
}

function CommentAvatar({ author }: { author: any }) {
  const name: string = author?.name || author?.email?.split("@")[0] || "You";
  const src: string | undefined = author?.avatar_url || author?.image || undefined;
  return (
    <AvatarImg
      className="cc-comment-avatar"
      src={src}
      alt={name}
      title={name}
      fallback={
        <span className="cc-comment-avatar cc-comment-avatar-fallback" title={name}>
          {name.slice(0, 1).toUpperCase()}
        </span>
      }
    />
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
      {/* Avatar = authorship of a note. A bare quote (no body) is you pointing at
          the agent's text, not saying something, so it carries no profile pic —
          only a note, or the editor where you're actively writing one, does. */}
      {comment.body ? <CommentAvatar author={author} /> : null}
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
  onStep,
}: {
  conversationId: string;
  comment: PendingComment;
  author: any;
  onDone: () => void;
  // Move to the previous/next quote's note. Absent when this is the only quote.
  onStep?: (delta: number) => void;
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

  // Only close if this card still owns the editor. Stepping to the next note
  // hands ownership over while this textarea is still mounted; a late blur must
  // not then shut the editor that just opened.
  // `refocus`: hand focus back to the region only on an explicit close (Esc,
  // ⌘↵, the footer buttons). A blur-driven close means focus already went where
  // the user pointed it — the composer via ⌃M, another card — and yanking it
  // back would undo that gesture.
  const close = useCallback((refocus: boolean) => {
    const s = useInboxStore.getState();
    if (s.reviewEditingId !== comment.id) return;
    s.setReviewEditingId(null);
    if (refocus) onDone();
  }, [comment.id, onDone]);

  // The quote is committed on first click, so the note editor only edits the
  // optional note: Save stores it (empty keeps it a bare quote), Cancel just
  // closes and leaves the quote untouched. Removing is the chip's explicit Remove.
  const save = useCallback((refocus: boolean) => {
    useInboxStore.getState().commitReviewComment(conversationId, comment.id, value.trim());
    close(refocus);
  }, [value, conversationId, comment.id, close]);

  const cancel = close;

  // Save what's typed, then open the neighbour's editor.
  const step = useCallback(
    (delta: number) => {
      useInboxStore.getState().commitReviewComment(conversationId, comment.id, value.trim());
      onStep?.(delta);
    },
    [value, conversationId, comment.id, onStep],
  );

  // Plain ↑/↓ move between notes, but only once the caret has nowhere left to go
  // inside this one: on the first line ↑ steps back, on the last line ↓ steps
  // forward, and in between the arrows edit text as usual. That is how a list of
  // fields behaves everywhere else, and it is what "I can't go up and down while
  // typing a note" was asking for. A selection always belongs to the textarea.
  const arrowLeavesNote = useCallback((el: HTMLTextAreaElement, up: boolean) => {
    if (el.selectionStart !== el.selectionEnd) return false;
    const at = el.selectionStart;
    return up ? el.value.lastIndexOf("\n", at - 1) === -1 : el.value.indexOf("\n", at) === -1;
  }, []);

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
              save(true);
            } else if (onStep && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
              const up = e.key === "ArrowUp";
              // ⌘ jumps out of the note from anywhere; a bare arrow only once the
              // caret is against that edge, so it still edits multi-line notes.
              if (e.metaKey || e.ctrlKey || arrowLeavesNote(e.currentTarget, up)) {
                e.preventDefault();
                step(up ? -1 : 1);
              }
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel(true);
            }
          }}
          onBlur={() => save(false)}
        />
        <div className="cc-comment-editor-footer">
          {/* Closing keeps the quote either way. On a fresh quote say so — "Cancel"
              read as cancelling the quote itself; on a saved note it discards the edit. */}
          <button type="button" className="cc-comment-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => cancel(true)}>
            {comment.body ? "Cancel" : "Skip note"}
            <KeyCap size="xs">Esc</KeyCap>
          </button>
          <button type="button" className="cc-comment-btn cc-comment-btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={() => save(true)}>
            Save
            <span className="cc-bar-keys"><KeyCap size="xs">⌘</KeyCap><KeyCap size="xs">↵</KeyCap></span>
          </button>
        </div>
      </div>
    </div>
  );
}

export const MessageReview = memo(MessageReviewImpl);
