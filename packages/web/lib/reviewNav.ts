// Walking the transcript's quotable chunks by keyboard, ACROSS message bounds.
// A "chunk" is a quote unit (lib/quoteUnits) inside a reviewable assistant body
// (.cc-msg-review). Three entry points share one walker: the `r` shortcut lands
// on the reply nearest the viewport center; the composer's ↑ (or ⌥K / ⌥↑) climbs
// out of the input onto the LAST chunk of the last reply; and the review region's
// own ↑/↓ step chunk by chunk, hopping to the neighbouring reply at either edge
// and dropping back into the composer past the very last chunk.
//
// DOM-driven on purpose: the transcript is virtualized, so "the messages" are
// whatever is mounted, in document order — the same set the mouse can reach.
// Stepping onto a message scrolls it into view (MessageReview), which mounts
// its neighbours, so a walk at the edge of the window resumes on the next key.

import { useInboxStore } from "../store/inboxStore";
import { getQuoteUnits } from "./quoteUnits";
import { exitReviewMode } from "./reviewActions";
import { focusComposer } from "./composerControl";

export type ReviewRegion = { id: string; el: HTMLElement };

// Every reviewable message currently in the DOM, in transcript order.
export function reviewRegions(): ReviewRegion[] {
  if (typeof document === "undefined") return [];
  const out: ReviewRegion[] = [];
  document.querySelectorAll<HTMLElement>(".cc-msg-review").forEach((el) => {
    const id = (el.closest('[id^="msg-"]') as HTMLElement | null)?.id?.slice(4);
    if (id) out.push({ id, el });
  });
  return out;
}

// Same count MessageReview measures: the region's top-level blocks, lists
// expanded per item. Never 0 — an unmeasured body is still one chunk.
export function reviewBlockCount(region: HTMLElement): number {
  const content = region.querySelector<HTMLElement>(":scope > .cc-content");
  return getQuoteUnits(content).length || 1;
}

// `r` with nothing selected: review the reply nearest the viewport center, so a
// keyboard-only user can start quoting without a mouse.
export function enterReviewNearCenter(): boolean {
  const center = window.innerHeight / 2;
  let best: { id: string; dist: number } | null = null;
  for (const { id, el } of reviewRegions()) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    const dist = Math.abs(rect.top + rect.height / 2 - center);
    if (!best || dist < best.dist) best = { id, dist };
  }
  if (!best) return false;
  useInboxStore.getState().setReviewTarget(best.id, 0);
  return true;
}

// ↑ out of the composer: the last reply becomes the review target at its LAST
// chunk, so the same ↑ keeps walking upward from where the reader's eye was.
export function enterReviewFromComposer(): boolean {
  const regions = reviewRegions();
  const last = regions[regions.length - 1];
  if (!last) return false;
  useInboxStore.getState().setReviewTarget(last.id, reviewBlockCount(last.el) - 1);
  return true;
}

// Move the active chunk by one. Inside a message this is a plain index step;
// at either edge the walk continues on the neighbouring reply (entering it from
// the side it was approached). Down past the last chunk of the last reply is
// the way back into the composer. Up past the first chunk of the first reply
// stays put. Always handles the key: returns false only when `messageId` is not
// a mounted region (nothing sensible to do).
export function stepReviewBlock(messageId: string, delta: -1 | 1): boolean {
  const s = useInboxStore.getState();
  const regions = reviewRegions();
  const pos = regions.findIndex((r) => r.id === messageId);
  if (pos === -1) return false;
  const next = s.reviewActiveBlock + delta;
  if (next >= 0 && next < reviewBlockCount(regions[pos].el)) {
    s.setReviewActiveBlock(next);
    return true;
  }
  const neighbour = regions[pos + delta];
  if (neighbour) {
    s.setReviewTarget(neighbour.id, delta > 0 ? 0 : reviewBlockCount(neighbour.el) - 1);
    return true;
  }
  if (delta > 0) {
    exitReviewMode();
    focusComposer();
  }
  return true;
}
