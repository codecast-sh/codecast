"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNearViewport } from "@/hooks/useNearViewport";
import { SOL } from "./blogChrome";

/**
 * The animation kit behind the blog's and the guides' figures. Every figure is
 * plain SVG or HTML animated by CSS: it plays once when it scrolls into view,
 * and a replay control restarts it. Timing rides two custom properties on each
 * element, `--at` (start) and `--dur` (length), so a figure's data is its whole
 * score. Classes:
 *
 *   bj-draw   a path drawn along its length (give it pathLength={1})
 *   bj-pop    springs in from a point
 *   bj-fade   fades in
 *   bj-grow   grows rightward from its left edge
 *   bj-rise   fades in while rising a few pixels
 *   bj-sweep  slides by `--to` and fades out (a playhead)
 *   bj-pulse  a soft repeating pulse, for something live or waiting
 */

const CSS = `
.bj-draw{stroke-dasharray:1 1;stroke-dashoffset:1}
.bj-pop{opacity:0;transform-box:fill-box;transform-origin:center;transform:scale(.2)}
.bj-fade{opacity:0}
.bj-rise{opacity:0;transform:translateY(6px)}
.bj-grow{transform-box:fill-box;transform-origin:left center;transform:scaleX(0)}
.bj-sweep{opacity:0}
[data-play="1"] .bj-draw{animation:bj-draw var(--dur,.4s) cubic-bezier(.45,0,.25,1) var(--at,0s) forwards}
[data-play="1"] .bj-pop{animation:bj-pop .4s cubic-bezier(.3,1.7,.5,1) var(--at,0s) forwards}
[data-play="1"] .bj-fade{animation:bj-fade .6s ease var(--at,0s) forwards}
[data-play="1"] .bj-rise{animation:bj-rise .5s cubic-bezier(.2,.8,.3,1) var(--at,0s) forwards}
[data-play="1"] .bj-grow{animation:bj-grow var(--dur,.6s) linear var(--at,0s) forwards}
[data-play="1"] .bj-sweep{animation:bj-sweep var(--dur,5s) linear var(--at,0s) forwards}
[data-play="1"] .bj-pulse{animation:bj-pulse 1.6s ease-in-out var(--at,0s) infinite}
@keyframes bj-draw{to{stroke-dashoffset:0}}
@keyframes bj-pop{to{opacity:1;transform:scale(1)}}
@keyframes bj-fade{to{opacity:1}}
@keyframes bj-rise{to{opacity:1;transform:none}}
@keyframes bj-grow{to{transform:scaleX(1)}}
@keyframes bj-sweep{0%{opacity:.9;transform:translateX(0)}97%{opacity:.9}100%{opacity:0;transform:translateX(var(--to))}}
@keyframes bj-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){
  [data-play] *{animation:none!important}
  .bj-draw{stroke-dashoffset:0}.bj-pop,.bj-fade,.bj-rise{opacity:1;transform:none}.bj-grow{transform:none}
}
`;

/** Render once per page, above the first figure. */
export function FigureStyles() {
  return <style>{CSS}</style>;
}

/** Timing for one animated element: start `at` seconds in, last `dur`. */
export const t = (at: number, dur?: number, extra?: Record<string, string>): CSSProperties =>
  ({ "--at": `${at.toFixed(2)}s`, ...(dur !== undefined ? { "--dur": `${dur.toFixed(2)}s` } : {}), ...extra }) as CSSProperties;

/** Plays its children once they are well inside the viewport; replay remounts
 *  them. `minWidth` keeps a wide timeline legible on a phone by letting it
 *  scroll sideways instead of shrinking its text. */
export function Stage({ children, minWidth }: { children: ReactNode; minWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useNearViewport(ref, "0px 0px -20% 0px");
  const [run, setRun] = useState(0);
  return (
    <div ref={ref} className="relative">
      <div className="flex justify-end px-3 pt-2 sm:absolute sm:top-0 sm:right-0 sm:z-10">
        <button
          type="button"
          onClick={() => setRun((n) => n + 1)}
          className="font-mono text-[11px] px-2 py-0.5 rounded hover:opacity-100 opacity-60 transition-opacity"
          style={{ color: SOL.base01, backgroundColor: SOL.base2 }}
        >
          replay
        </button>
      </div>
      <div className={minWidth ? "overflow-x-auto" : undefined}>
        <div key={run} data-play={seen ? "1" : "0"} style={minWidth ? { minWidth } : undefined}>{children}</div>
      </div>
    </div>
  );
}

/** A figure panel's heading: a color swatch, a bold title and a one-line sub. */
export function PanelHead({ title, sub, color }: { title: string; sub: string; color: string }) {
  return (
    <div className="px-5 pt-4">
      <div className="font-mono text-sm font-bold flex items-center gap-2" style={{ color: SOL.base02 }}>
        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
        {title}
      </div>
      <div className="text-[13px] mt-1 leading-snug" style={{ color: SOL.base00 }}>{sub}</div>
    </div>
  );
}
