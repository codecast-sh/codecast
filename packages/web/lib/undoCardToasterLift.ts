// The undo card and the toaster share the bottom-right corner, and sonner
// stacks above everything. While the card is open the toaster rises above
// it, so no toast (an error, the milestone tip, one that arrives while the
// card is open) covers the card's rows or footer.

import { useEffect, useState, useSyncExternalStore } from "react";
import * as undoTimeline from "./undoTimelineOpen";

const GAP_PX = 8;

/** The toaster's bottom offset that clears a card whose top edge is `cardTop`. */
export function toasterLiftFor(cardTop: number, viewportHeight: number): number {
  return Math.max(0, Math.ceil(viewportHeight - cardTop + GAP_PX));
}

/** Sonner offsets for the current card, or undefined while it is closed. */
export function useUndoCardToasterLift(): { bottom: number } | undefined {
  const open = useSyncExternalStore(undoTimeline.subscribe, () => undoTimeline.isOpen(), () => false);
  const [lift, setLift] = useState<number | null>(null);
  useEffect(() => {
    if (!open) { setLift(null); return; }
    let observer: ResizeObserver | null = null;
    let frame = 0;
    const measure = (card: Element) => setLift(toasterLiftFor(card.getBoundingClientRect().top, window.innerHeight));
    const attach = () => {
      const card = document.querySelector("[data-undo-timeline]");
      if (!card) { frame = requestAnimationFrame(attach); return; }
      measure(card);
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => measure(card));
        observer.observe(card);
      }
    };
    attach();
    const onResize = () => { const card = document.querySelector("[data-undo-timeline]"); if (card) measure(card); };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [open]);
  return open && lift !== null ? { bottom: lift } : undefined;
}
