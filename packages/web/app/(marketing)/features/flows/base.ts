import { createContext, useContext, useRef, useState, type CSSProperties } from "react";
import { useMountEffect } from "@/hooks/useMountEffect";
import { SOL } from "../../blog/blogChrome";

export { useStepClock } from "../browser/kit";
export { useStillMode } from "../kit";

/*
 * Shared values and hooks for /features/flows (the components are in kit.tsx,
 * which stays a Fast Refresh boundary by exporting components only). Colours follow the app's Flows page:
 * a person is blue, the line (agent work, live) is cyan, the ways back to the
 * session are violet, failures are red, a clean finish is green.
 *
 * Motion rule for every section: an element's resting CSS is its FINAL state;
 * keyframes only play the way in. A section's figure starts playing when it
 * first comes near the viewport (`usePlayOnView`), and in still mode
 * (`?static`, reduced motion) it renders the end frame and runs no clock.
 */

export const PERSON = SOL.blue;
export const LINE = SOL.cyan;
export const BACK = SOL.violet;
export const BAD = SOL.red;
export const GOOD = SOL.green;
export const WARN = SOL.yellow;
export const INK = SOL.base03;
export const TEXT = SOL.base01;
export const MUTED = SOL.base00;
export const DIM = SOL.base1;
export const HAIR = "rgba(88,110,117,.22)";
export const PAPER = "#fffaf0";
export const SAND = "#f5eed9";
/** The dark "floor" bands. */
export const FLOOR = SOL.base03;
export const FLOOR_2 = "#06323d";
export const FLOOR_LINE = "rgba(147,161,161,.18)";

export const tint = (c: string, pct = 12) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

/** Animation delay as a CSS variable, read by the `--d` keyframe classes in flows.css. */
export const at = (d: number, extra?: CSSProperties) => ({ ["--d" as string]: `${d}s`, ...extra }) as CSSProperties;

/** Still mode for the whole page, provided once by Page.tsx. */
export const StillContext = createContext(false);
export const useStill = () => useContext(StillContext);

/**
 * Plays once the element is well inside the viewport, and stays played. In
 * still mode it is always "played" (the end frame). Use the returned ref on
 * the figure's root and gate clocks and `data-play` on `playing`.
 */
export function usePlayOnView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  // Not playing on the server and on the first client render alike, so the
  // prerendered markup hydrates without a mismatch; the resting CSS is the
  // finished frame either way.
  const [seen, setSeen] = useState(false);
  useMountEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver((entries) => {
      if (!entries[entries.length - 1]?.isIntersecting) return;
      setSeen(true);
      io.disconnect();
    }, { rootMargin: "0px 0px -22% 0px" });
    io.observe(el);
    return () => io.disconnect();
  });
  const still = useStill();
  return [ref, still || seen];
}
