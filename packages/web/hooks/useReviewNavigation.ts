import { useCallback, useMemo, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { PendingComment } from "../lib/quoteFormat";
import { jumpToReviewComment } from "../lib/reviewNavigation";

export function useReviewNavigation(
  scrollRef: RefObject<HTMLDivElement | null>,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  jumpToMessage: (id: string) => void,
  onNavigate: () => void,
  stickyRef: RefObject<HTMLDivElement | null>,
) {
  const scrollToBlock = useCallback((block: HTMLElement, align: "center" | "nearest") => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const viewport = scroll.getBoundingClientRect();
    const rect = block.getBoundingClientRect();
    const top = viewport.top + (stickyRef.current?.offsetHeight ?? 0) + 40;
    const bottom = viewport.bottom - 40;
    if (align === "nearest" && rect.top >= top && rect.bottom <= bottom) return;
    virtualizer.scrollToOffset(scroll.scrollTop + rect.top - top - Math.max(0, (bottom - top - rect.height) / 2), { behavior: "auto" });
  }, [scrollRef, virtualizer, stickyRef]);
  const jumpToComment = useCallback((comment: PendingComment) => {
    onNavigate();
    jumpToReviewComment(comment, scrollRef.current, jumpToMessage, scrollToBlock);
  }, [onNavigate, scrollRef, jumpToMessage, scrollToBlock]);
  return useMemo(() => ({ jumpToComment, scrollToBlock }), [jumpToComment, scrollToBlock]);
}

