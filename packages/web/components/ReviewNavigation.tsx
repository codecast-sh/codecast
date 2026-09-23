import { useCallback, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";
import type { PendingComment } from "../lib/quoteFormat";
import { reviewSourceMessageId } from "../lib/reviewNavigation";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useReviewComposer } from "./reviewContext";
import "./ReviewNavigation.css";

type ScrollVirtualizer = Virtualizer<HTMLDivElement, Element>;

/** Height of the strip at each edge of the viewport where an edge marker sits. */
const EDGE_STRIP = 40;

type Edge = { count: number; comment: PendingComment; position: number };
type Edges = { above?: Edge; below?: Edge; left?: number };
type Props = {
  conversationId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  messageIds: (string | null)[];
  virtualizer: ScrollVirtualizer;
  topInset?: number;
};

export function ReviewScrollIndicators({ conversationId, scrollRef, messageIds, virtualizer, topInset = 0 }: Props) {
  const comments = useInboxStore(useShallow((s) => s.reviewComments[conversationId] ?? []));
  const composer = useReviewComposer();
  const [edges, setEdges] = useState<Edges>({});
  const indices = useMemo(() => new Map(messageIds.map((id, index) => [id, index])), [messageIds]);
  const measure = useCallback(() => {
    const scroll = scrollRef.current;
    const next: Edges = {};
    if (comments.length && scroll && scroll.clientHeight > 0) {
      const viewport = scroll.getBoundingClientRect();
      const region = scroll.querySelector<HTMLElement>(".cc-msg-review");
      const rail = scroll.querySelector<HTMLElement>(".cc-rail");
      const regionLeft = region ? region.getBoundingClientRect().left - viewport.left : 12;
      next.left = Math.max(12, rail ? rail.getBoundingClientRect().left - viewport.left
        : regionLeft >= 208 ? regionLeft - Math.min(240, regionLeft - 40) - 36 : regionLeft);
      // A card counts as off screen only once it has fully left the viewport,
      // and the marker stands in for it only while nothing else occupies the
      // strip of rail it would sit on: a card still showing there is the
      // better cue, and the marker must never cover one.
      const top = viewport.top + topInset;
      const bottom = viewport.bottom;
      const blocked = { above: false, below: false };
      const cards = new Map(Array.from(scroll.querySelectorAll<HTMLElement>("[data-review-comment]"), (el) => [el.dataset.reviewComment, el]));
      for (const comment of comments) {
        const card = cards.get(comment.id);
        const index = indices.get(reviewSourceMessageId(comment.messageId));
        const row = index === undefined ? undefined : virtualizer.measurementsCache[index];
        const rect = card?.getBoundingClientRect();
        const start = rect?.top ?? (row ? viewport.top + row.start - scroll.scrollTop : undefined);
        const end = rect?.bottom ?? (row ? viewport.top + row.end - scroll.scrollTop : undefined);
        if (start === undefined || end === undefined) continue;
        if (rect && rect.top < top + EDGE_STRIP && rect.bottom > top) blocked.above = true;
        if (rect && rect.top < bottom && rect.bottom > bottom - EDGE_STRIP) blocked.below = true;
        const direction = end <= top ? "above" : start >= bottom ? "below" : null;
        if (!direction) continue;
        const position = direction === "above" ? end : start;
        const edge = next[direction];
        if (!edge) next[direction] = { count: 1, comment, position };
        else {
          edge.count++;
          const nearerBlock = comment.messageId === edge.comment.messageId && (direction === "above"
            ? comment.blockIndex > edge.comment.blockIndex
            : comment.blockIndex < edge.comment.blockIndex);
          if ((direction === "above" ? position > edge.position : position < edge.position) || (position === edge.position && nearerBlock)) {
            edge.comment = comment;
            edge.position = position;
          }
        }
      }
      if (blocked.above) delete next.above;
      if (blocked.below) delete next.below;
    }
    setEdges((previous) => previous.left === next.left && (["above", "below"] as const).every((direction) => {
      return previous[direction]?.count === next[direction]?.count && previous[direction]?.comment === next[direction]?.comment;
    }) ? previous : next);
  }, [comments, indices, scrollRef, virtualizer, topInset]);

  useLayoutEffect(measure, [measure]);
  useWatchEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !comments.length) return;
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(scroll);
    if (scroll.firstElementChild) resize.observe(scroll.firstElementChild);
    const mutations = new MutationObserver(schedule);
    mutations.observe(scroll, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "data-review-comment"] });
    scroll.addEventListener("scroll", schedule, { passive: true });
    scroll.addEventListener("transitionend", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      scroll.removeEventListener("scroll", schedule);
      scroll.removeEventListener("transitionend", schedule);
    };
  }, [scrollRef, comments.length, measure]);

  return <>{(["above", "below"] as const).map((direction) => {
    const edge = edges[direction];
    if (!edge || !composer?.jumpToComment) return null;
    const Arrow = direction === "above" ? ArrowUp : ArrowDown;
    const label = `${edge.count} ${edge.count === 1 ? "reply" : "replies"} ${direction}`;
    return <button
      key={direction}
      type="button"
      className="cc-review-edge"
      data-direction={direction}
      style={{ left: edges.left, ...(direction === "above" ? { top: topInset + 6 } : {}) }}
      aria-label={`${label}. Jump to nearest reply ${direction}`}
      title={`Jump to nearest reply ${direction}`}
      onClick={() => composer.jumpToComment?.(edge.comment)}
    ><Arrow size={12} aria-hidden="true" />{label}</button>;
  })}</>;
}
