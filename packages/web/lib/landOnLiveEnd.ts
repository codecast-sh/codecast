// After the reader's own action adds to the end of a transcript (a send, an
// Escape interrupt), the view goes to the end so they see what they did.
//
// "The end" depends on what is loaded. Opened at a deep link or a search hit,
// the transcript is a paged window (`hasMoreBelow`): the newest rows, the one
// just added among them, are not loaded, and scrolling to the loaded end leaves
// it out of view. Then the view jumps to the live end the way "Scroll to
// bottom" does (`jumpToLiveEnd`). Otherwise it scrolls to the loaded end, which
// is the live end, without leaving the window or refetching anything.
export type LiveEndDeps = {
  hasMoreBelow: boolean;
  /** A jump to the live end is already under way. */
  jumpingToEnd: boolean;
  /** Undefined when the view has no paged window to leave. */
  jumpToLiveEnd: (() => void) | undefined;
  scrollToLoadedEnd: () => void;
  resumeFollow: () => void;
};

export function landOnLiveEnd(d: LiveEndDeps): "live" | "loaded" {
  d.resumeFollow();
  if (d.hasMoreBelow && d.jumpToLiveEnd) {
    if (!d.jumpingToEnd) d.jumpToLiveEnd();
    return "live";
  }
  d.scrollToLoadedEnd();
  return "loaded";
}
