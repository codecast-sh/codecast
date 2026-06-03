// Pure scroll-decision logic for ConversationView, extracted so it can be
// unit-tested without a DOM. See conversationScroll.test.ts.
//
// Bottom-pinning ("stay glued to the tail while streaming") is NOT here anymore:
// it's owned natively by the virtualizer via anchorTo:'end' (virtual-core 3.17+),
// which can re-pin correctly because it knows whether it or the user moved the
// scroll. The old shouldPinToBottom heuristic guessed that from outside and got
// it wrong. What remains here is pagination/jump gating, which is still ours.

export interface JumpReadyInput {
  /** The in-flight jump's direction, or null when no jump is pending. */
  direction: "start" | "end" | null;
  /** The timeline currently has at least one item to scroll to. */
  hasTimeline: boolean;
  /** The destination page is still being fetched (older side / top). */
  isLoadingOlder: boolean;
  /**
   * The destination page is still being fetched (newer side / bottom). For a
   * jump-to-end this MUST include the normal-mode "LoadingFirstPage" state —
   * the live tail isn't in the store yet, so scrolling now lands on stale
   * content and then jumps again when the real page arrives.
   */
  isLoadingNewer: boolean;
}

/**
 * The single gate for "perform the jump's one scroll now". The whole point of
 * the jump UX is that we MUST NOT scroll until the destination data is actually
 * present — the view stays frozen (spinner up) through the entire load, then
 * this returns true exactly once and we do a single atomic scroll to the edge.
 *
 * Returns false when there's no jump, nothing to scroll to, or either side is
 * still loading. The caller clears the jump direction after acting, so this
 * naturally fires only on the first ready frame.
 */
export function isJumpReadyToScroll(i: JumpReadyInput): boolean {
  if (!i.direction || !i.hasTimeline) return false;
  if (i.isLoadingOlder || i.isLoadingNewer) return false;
  return true;
}

export interface LoadOlderInput {
  /**
   * The content-top is near the viewport: either scrollTop is inside the
   * preload band, or the top sentinel is inside the IntersectionObserver's
   * margin. On a SHORT loaded window (content barely taller than the viewport)
   * this is true even while parked at the very bottom — the content-top never
   * leaves the band — which is exactly why `nearTop` alone is not enough.
   */
  nearTop: boolean;
  /**
   * The user has scrolled up off the live tail. FALSE on initial load and
   * while following the stream at the bottom. This is the discriminator that
   * `nearTop` can't provide on a short window: "reaching back for history"
   * (scrolled up) vs "following the tail" (parked at the bottom).
   */
  userScrolled: boolean;
  hasMoreAbove: boolean;
  isLoadingOlder: boolean;
  /** A jump-to-end / live-tail fetch is in flight; don't fight it. */
  isLoadingNewer: boolean;
  /** A pagination/jump cooldown is active; auto-load must stand down. */
  cooldownActive: boolean;
}

/**
 * Decide whether to auto-load the previous (older) page.
 *
 * The trigger is "the top is approaching" — but acting on that ALONE made the
 * view spontaneously paginate upward and jump: on any conversation whose loaded
 * window is shorter than the preload band, the content-top sits permanently
 * inside the band, so sitting at the live tail satisfied `nearTop` and the rAF
 * pump fired `loadOlder` page after page with no user input (the spinning
 * up-arrow + scroll jumping). Requiring a real scroll-up (`userScrolled`) gates
 * that out: we only pull history once the user has actually left the tail to go
 * looking for it, which is the only time it's wanted.
 */
export function shouldLoadOlder(i: LoadOlderInput): boolean {
  if (!i.hasMoreAbove || i.isLoadingOlder || i.isLoadingNewer || i.cooldownActive) return false;
  if (!i.userScrolled) return false;
  return i.nearTop;
}
