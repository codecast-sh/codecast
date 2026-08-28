// THE UPGRADE IS ONE NODE CHANGING SHAPE, not one surface dying and another
// being born.
//
// A burst becoming a call is the same room, the same seat and the same open
// microphone. The strip used to be a separate mount in a separate portal from
// the dock, so the only way to connect them was to fade one out over the other
// and hope the eye joined them up. It did not: two surfaces appeared, and
// nothing on screen said they were the same thing.
//
// So the strip and the dock are two CONTENTS of one root (CallSurfaceRoot), and
// this module moves that root between the two shapes with a FLIP:
//
//   First   the root's resting rectangle, remembered after every commit.
//   Last    the rectangle it has just been given by the new content.
//   Invert  transform and size it back onto the first rectangle.
//   Play    let it travel, 240ms, ease-out.
//
// The content crossfades INSIDE the travelling box: the outgoing layer keeps
// its own size and scales toward the incoming one, the incoming layer starts
// scaled to the outgoing one's box. Both are anchored to the bottom-right
// corner, which is the corner the strip and the dock share, so what the eye
// follows is one card growing out of the place it was already looking at.
//
// Reduced motion is not a shorter animation, it is no animation: the new shape
// is simply there. Nothing here is load-bearing for correctness — the surface
// is already committed before a single frame plays — so skipping it is free.
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** The rectangle a FLIP is measured in: the corner the surfaces share, and a size. */
export type MorphRect = { right: number; bottom: number; width: number; height: number };

/** 240ms, the duration the plan asked for: long enough to read as one thing
 *  moving, short enough that nobody waits for it. About 14 frames at 60Hz. */
export const MORPH_MS = 240;

/** Out of the gate fast, settling slow — a thing arriving, not a thing easing. */
export const MORPH_EASING = "cubic-bezier(0.2, 0.7, 0.3, 1)";

/** The old surface is gone before the new one is fully there, so the crossfade
 *  never shows two readable cards at once. */
const FADE_OUT_MS = 150;

export function rectOf(el: Element): MorphRect {
  const r = el.getBoundingClientRect();
  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  const vh = typeof window === "undefined" ? 0 : window.innerHeight;
  return { right: vw - r.right, bottom: vh - r.bottom, width: r.width, height: r.height };
}

/** Motion is off, or the browser cannot animate: either way, no morph. */
export function canMorph(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof Element === "undefined" || typeof Element.prototype.animate !== "function") return false;
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

/**
 * The three keyframe sets of one morph. Pure, so the geometry can be checked
 * without a browser: the root is inverted onto `from` and released, and each
 * layer carries the scale that makes its own box look like the other one's.
 */
export function morphKeyframes(from: MorphRect, to: MorphRect): {
  root: Keyframe[];
  incoming: Keyframe[];
  leaving: Keyframe[];
} {
  const ratio = (a: number, b: number) => (a > 0 && b > 0 ? a / b : 1);
  const sx = ratio(from.width, to.width);
  const sy = ratio(from.height, to.height);
  // The corner is the anchor, so the offsets are between the two right/bottom
  // edges and a shared corner means a translation of exactly zero.
  const dx = to.right - from.right;
  const dy = to.bottom - from.bottom;
  return {
    root: [
      { transform: `translate(${dx}px, ${dy}px)`, width: `${from.width}px`, height: `${from.height}px` },
      { transform: "none", width: `${to.width}px`, height: `${to.height}px` },
    ],
    incoming: [
      { opacity: 0, transform: `scale(${sx}, ${sy})` },
      { opacity: 1, transform: "none" },
    ],
    leaving: [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: `scale(${ratio(to.width, from.width)}, ${ratio(to.height, from.height)})` },
    ],
  };
}

type Pending = { id: number; from: MorphRect };

/**
 * Watch `key` (which surface the root is showing) and play the FLIP when it
 * changes.
 *
 * `morphing` is true for exactly the length of the animation, and it is what
 * tells the root to keep the outgoing content mounted — the root asks this
 * hook, the hook never reaches into the tree. When it goes false the corpse
 * goes with it.
 */
export function useSurfaceMorph(
  key: string,
  refs: {
    root: RefObject<HTMLElement | null>;
    incoming: RefObject<HTMLElement | null>;
    leaving: RefObject<HTMLElement | null>;
  },
): { morphing: boolean; from: MorphRect | null } {
  const seenKey = useRef(key);
  const nextId = useRef(1);
  const playedId = useRef(0);
  const running = useRef<Animation[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);

  // Settled during the render that SEES the change, the way this component
  // family settles everything else: React re-runs and throws the first pass
  // away, so there is no committed frame showing the new surface without its
  // morph — and no effect whose dependency list would have to carry the same
  // edge anyway.
  //
  // "First" is measured HERE, in the render phase, because the render phase is
  // the last moment the old surface is still the one on screen: React has not
  // touched the DOM yet, so the rectangle is what the eye is looking at —
  // including one already part-way through an earlier morph, which is exactly
  // where an interrupted animation should continue from.
  if (seenKey.current !== key) {
    seenKey.current = key;
    const el = refs.root.current;
    if (el && canMorph()) setPending({ id: nextId.current++, from: rectOf(el) });
  }

  useLayoutEffect(() => {
    const el = refs.root.current;
    if (!el || !pending || playedId.current === pending.id) return;
    playedId.current = pending.id;
    for (const a of running.current) a.cancel();

    const frames = morphKeyframes(pending.from, rectOf(el));
    // Only the root's animation is asked when the morph is over. The layers
    // are decoration on top of it and one of them is deliberately shorter.
    const done = () => setPending((p) => (p?.id === pending.id ? null : p));
    const root = el.animate(frames.root, { duration: MORPH_MS, easing: MORPH_EASING });
    const incoming = refs.incoming.current?.animate(frames.incoming, {
      duration: MORPH_MS,
      easing: MORPH_EASING,
    });
    const leaving = refs.leaving.current?.animate(frames.leaving, {
      duration: FADE_OUT_MS,
      easing: "ease-in",
    });
    running.current = [root, incoming, leaving].filter(Boolean) as Animation[];
    if (!root) {
      done();
      return;
    }
    root.addEventListener("finish", done);
    root.addEventListener("cancel", done);
    return () => {
      root.removeEventListener("finish", done);
      root.removeEventListener("cancel", done);
    };
  }, [pending, refs.root, refs.incoming, refs.leaving]);

  return { morphing: pending !== null, from: pending?.from ?? null };
}
