"use client";

import { createContext, useContext, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMountEffect } from "@/hooks/useMountEffect";
import { SOL } from "../../blog/blogChrome";

export { useStepClock } from "../browser/kit";
export { C, CopyCommand, ForScripts, Shot, useStillMode } from "../kit";

/*
 * Shared parts for /features/flows. Colours follow the app's Flows page:
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

/**
 * A page section. The number ties it to a station on the sticky pipeline
 * (`Rail` in Page.tsx); `tone` picks the band.
 */
export function Section({ id, title, lede, children, tone = "plain", wide = false }: {
  id: string;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  tone?: "plain" | "paper" | "sand" | "floor";
  wide?: boolean;
}) {
  const dark = tone === "floor";
  const bg = dark ? FLOOR : tone === "paper" ? PAPER : tone === "sand" ? SAND : SOL.base3;
  return (
    <section id={id} data-station={id} className={`flx-section relative scroll-mt-24 ${dark ? "flx-dark" : ""}`} style={{ backgroundColor: bg }}>
      <div className={`${wide ? "max-w-7xl" : "max-w-6xl"} mx-auto px-5 sm:px-8 pt-20 pb-14 sm:pt-24 sm:pb-16`}>
        <h2 className="font-mono font-bold text-[27px] sm:text-[38px] leading-[1.1] tracking-[-0.035em] max-w-4xl [text-wrap:balance]" style={{ color: dark ? SOL.base3 : INK }}>
          {title}
        </h2>
        {lede ? <div className="flx-prose mt-5 max-w-2xl text-[16.5px] sm:text-[17.5px] leading-[1.7]" style={{ color: dark ? SOL.base1 : TEXT }}>{lede}</div> : null}
        {children ? <div className="mt-12 sm:mt-14">{children}</div> : null}
      </div>
    </section>
  );
}

/** A count chip the way the app draws it: a person's wait in blue, the line's work in cyan. */
export function Mark({ color, children }: { color: string; children: ReactNode }) {
  return <span className="flx-mark" style={{ color, backgroundColor: tint(color, 11) }}>{children}</span>;
}

/** A card surface for mocks of the app (light). */
export function Card({ children, className = "", style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`rounded-xl border ${className}`} style={{ backgroundColor: PAPER, borderColor: HAIR, boxShadow: "0 18px 40px -30px rgba(0,43,54,.45)", ...style }}>
      {children}
    </div>
  );
}

/** A small mono label above a figure panel (sentence case, never uppercase). */
export function Label({ children, color = DIM }: { children: ReactNode; color?: string }) {
  return <div className="font-mono text-[12px] font-semibold" style={{ color }}>{children}</div>;
}
