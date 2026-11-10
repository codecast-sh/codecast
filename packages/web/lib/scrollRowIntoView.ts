import { rowScrollDelta, scrollMarginTopOf } from "./rowScroll";

// Bring a session row into view: smooth, but never a long glide — when the
// row is more than one panel-height away, jump most of the distance first so
// the animation stays quick no matter how far the list has scrolled. Hand-rolled
// rAF tween instead of native behavior:"smooth" because the panel re-renders
// constantly (heartbeats, section resorts) and Chromium silently cancels native
// smooth scrolls on any concurrent scroll/layout change. Re-measuring the
// remaining distance every frame self-corrects through that churn.
// The row's scroll-margin-top (the sticky section heading's height on rail
// rows) stays clear at the top, so a followed row never lands under its own
// heading (lib/rowScroll).
export function scrollRowIntoView(container: HTMLElement, el: Element) {
  const marginTop = scrollMarginTopOf(el);
  const remainingDelta = () => rowScrollDelta(container.getBoundingClientRect(), el.getBoundingClientRect(), marginTop);
  const delta = remainingDelta();
  if (delta === 0) return;
  // Hidden/occluded tabs get no animation frames — settle instantly so the
  // row can't be stranded mid-glide until the tab is next viewed.
  if (document.visibilityState !== "visible") {
    container.scrollTop += delta;
    return;
  }
  const maxGlide = container.clientHeight;
  if (Math.abs(delta) > maxGlide) {
    container.scrollTop += delta - Math.sign(delta) * maxGlide;
  }
  let aborted = false;
  const abort = () => { aborted = true; };
  const cleanup = () => {
    container.removeEventListener("wheel", abort);
    container.removeEventListener("touchstart", abort);
  };
  container.addEventListener("wheel", abort, { passive: true, once: true });
  container.addEventListener("touchstart", abort, { passive: true, once: true });
  let frames = 0;
  const step = () => {
    // Row unmounted mid-glide (panel remount/resort) — a detached node
    // measures as all-zeros, so stop rather than chase garbage.
    if (aborted || !el.isConnected) return cleanup();
    const remaining = remainingDelta();
    if (Math.abs(remaining) < 1 || ++frames > 60) {
      container.scrollTop += remaining;
      return cleanup();
    }
    container.scrollTop += remaining * 0.25;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
