import { useCallback, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";
import type { PendingComment } from "../lib/quoteFormat";
import { getQuoteUnits } from "../lib/quoteUnits";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useReviewComposer } from "./reviewContext";
import "./ReviewNavigation.css";

function reviewRegion(scroll: HTMLElement, messageId: string) {
  return Array.from(scroll.querySelectorAll<HTMLElement>("[data-review-message]"))
    .find((el) => el.dataset.reviewMessage === messageId);
}

export function reviewSourceMessageId(messageId: string) {
  return messageId.replace(/#plan$/, "");
}

export function jumpToReviewComment(comment: PendingComment, scroll: HTMLElement | null, jumpToMessage: (id: string) => void) {
  const state = useInboxStore.getState();
  state.setReviewEditingId(null);
  state.setReviewTarget(comment.messageId, comment.blockIndex);
  const region = scroll && reviewRegion(scroll, comment.messageId);
  if (region) {
    const block = getQuoteUnits(region.querySelector(":scope > .cc-content"))[comment.blockIndex];
    (block ?? region).scrollIntoView({ block: "center", behavior: "auto" });
    region.focus({ preventScroll: true });
  } else {
    jumpToMessage(reviewSourceMessageId(comment.messageId));
  }
}

type Edge = { count: number; comment: PendingComment; position: number };
type Edges = { above?: Edge; below?: Edge };
type Props = {
  conversationId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  messageIds: (string | null)[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
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
    if (scroll && scroll.clientHeight > 0) {
      const viewport = scroll.getBoundingClientRect();
      const top = viewport.top + topInset + 36;
      const bottom = viewport.bottom - 36;
      const cards = new Map(Array.from(scroll.querySelectorAll<HTMLElement>("[data-review-comment]"), (el) => [el.dataset.reviewComment, el]));
      for (const comment of comments) {
        const card = cards.get(comment.id);
        const index = indices.get(reviewSourceMessageId(comment.messageId));
        const row = index === undefined ? undefined : virtualizer.measurementsCache[index];
        const rect = card?.getBoundingClientRect();
        const start = rect?.top ?? (row ? viewport.top + row.start - scroll.scrollTop : undefined);
        const end = rect?.bottom ?? (row ? viewport.top + row.end - scroll.scrollTop : undefined);
        if (start === undefined || end === undefined) continue;
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
    }
    setEdges((previous) => ["above", "below"].every((key) => {
      const direction = key as keyof Edges;
      return previous[direction]?.count === next[direction]?.count && previous[direction]?.comment === next[direction]?.comment;
    }) ? previous : next);
  }, [comments, indices, scrollRef, virtualizer, topInset]);

  useLayoutEffect(measure);
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
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      scroll.removeEventListener("scroll", schedule);
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
      style={direction === "above" ? { top: topInset + 8 } : undefined}
      aria-label={`${label}. Jump to nearest reply ${direction}`}
      title={`Jump to nearest reply ${direction}`}
      onClick={() => composer.jumpToComment?.(edge.comment)}
    ><Arrow size={12} aria-hidden="true" />{label}</button>;
  })}</>;
}
