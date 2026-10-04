"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { SOL } from "../../blog/blogChrome";

/**
 * Shared primitives for the cast browser page. The accent is the red of the
 * "Cast" tab group: the extension creates that group in Chrome's red, so the
 * page borrows the one color a reader will actually see in their own browser.
 */
export const CAST_RED = SOL.red;
export const REF_BLUE = SOL.blue;
export const HUMAN_CYAN = SOL.cyan;
export const INK = SOL.base03;
export const MUTED = SOL.base00;
export const DIM = SOL.base1;
export const PAPER = SOL.base3;
export const SAND = SOL.base2;

/**
 * Still mode: reduced motion, or `?static` in the URL (a background tab
 * stalls timers, so captures ask for the finished frame). Mocks render their
 * end state and run no clocks.
 */
export function useStillMode(): boolean {
  const [still, setStill] = useState(false);
  useWatchEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setStill(reduce.matches || new URLSearchParams(window.location.search).has("static"));
    read();
    reduce.addEventListener("change", read);
    return () => reduce.removeEventListener("change", read);
  }, []);
  return still;
}

/**
 * A step clock: advances through `durations` (ms each) and loops, paused by
 * `playing`. In still mode it sits on the last step.
 */
export function useStepClock(durations: number[], still: boolean, playing = true): [number, (n: number) => void] {
  const [step, setStep] = useState(0);
  const last = durations.length - 1;
  useWatchEffect(() => {
    if (still || !playing) return;
    const t = setTimeout(() => setStep(step >= last ? 0 : step + 1), durations[step]);
    return () => clearTimeout(t);
  }, [step, still, playing]);
  return [still ? last : step, setStep];
}

/**
 * A page section. The heading carries a tab-shaped marker on its left: a
 * rounded chip in the section's color, like a Chrome tab group label, so the
 * page reads as a strip of groups you are walking through.
 */
export function Section({ id, label, color = CAST_RED, title, lede, children, tone = "paper", wide = false }: {
  id: string;
  label: string;
  color?: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  tone?: "paper" | "sand" | "dark";
  wide?: boolean;
}) {
  const bg = tone === "dark" ? SOL.base03 : tone === "sand" ? "#f5eed9" : PAPER;
  const ink = tone === "dark" ? SOL.base2 : INK;
  const sub = tone === "dark" ? SOL.base1 : SOL.base01;
  return (
    <section id={id} className="bx-section relative scroll-mt-20" style={{ backgroundColor: bg }}>
      <div className={`${wide ? "max-w-7xl" : "max-w-6xl"} mx-auto px-5 sm:px-8 py-20 sm:py-28`}>
        <GroupChip label={label} color={color} />
        <h2 className="mt-5 font-mono font-bold tracking-[-0.03em] text-[27px] sm:text-[36px] leading-[1.12] max-w-4xl [text-wrap:balance]" style={{ color: ink }}>
          {title}
        </h2>
        {lede && <p className="mt-4 text-[16.5px] sm:text-[17px] leading-8 max-w-2xl" style={{ color: sub }}>{lede}</p>}
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

/** Chrome's tab group label: a filled rounded rectangle with the group's name. */
export function GroupChip({ label, color = CAST_RED, size = "md", style }: { label: string; color?: string; size?: "sm" | "md"; style?: CSSProperties }) {
  return (
    <span
      className={`inline-flex items-center rounded-[6px] font-sans font-semibold leading-none ${size === "sm" ? "text-[10.5px] px-[6px] py-[3px]" : "text-[12.5px] px-2 py-[5px]"}`}
      style={{ backgroundColor: color, color: "#fff", ...style }}
    >
      {label}
    </span>
  );
}

/** Inline code in prose. */
export function C({ children, tone = "light" }: { children: ReactNode; tone?: "light" | "dark" }) {
  return (
    <code
      className="font-mono text-[0.88em] px-1.5 py-0.5 rounded whitespace-nowrap"
      style={tone === "dark" ? { backgroundColor: SOL.base02, color: SOL.base2 } : { backgroundColor: SAND, color: SOL.base02 }}
    >
      {children}
    </code>
  );
}

/** A snapshot ref, the way it is pinned onto an element: #e7 in a small blue tag. */
export function RefTag({ n, on = true, annotate = false, style, className = "" }: { n: number; on?: boolean; /** Draw it the way `shot --annotate` labels the image: [N]. */ annotate?: boolean; style?: CSSProperties; className?: string }) {
  return (
    <span
      className={`bx-ref pointer-events-none absolute z-10 rounded-[4px] font-mono text-[10px] font-semibold leading-none px-[4px] py-[3px] ${on ? "bx-ref-on" : ""} ${className}`}
      style={{ backgroundColor: annotate ? SOL.orange : REF_BLUE, color: "#fff", boxShadow: "0 2px 6px -2px rgba(38,139,210,.6)", ...style }}
    >
      {annotate ? `[${n}]` : `#e${n}`}
    </span>
  );
}

/** Traffic lights for window chrome. */
export function Lights({ size = 11 }: { size?: number }) {
  return (
    <span className="flex gap-[6px] shrink-0">
      {[SOL.red, SOL.yellow, SOL.green].map((c) => (
        <span key={c} className="rounded-full" style={{ width: size, height: size, backgroundColor: c, opacity: 0.9 }} />
      ))}
    </span>
  );
}

/** Small favicon square for a mock tab. */
export function Favicon({ color, glyph }: { color: string; glyph: string }) {
  return (
    <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] text-[8.5px] font-bold text-white font-sans" style={{ backgroundColor: color }}>
      {glyph}
    </span>
  );
}

/** One Chrome tab in the strip. `active` draws the lifted white tab; `groupColor` adds the group underline. */
export function ChromeTab({ title, fav, active = false, groupColor, badge = false, width = 168, dim = false }: {
  title: string;
  fav: ReactNode;
  active?: boolean;
  groupColor?: string;
  badge?: boolean;
  width?: number;
  dim?: boolean;
}) {
  return (
    <span
      className="relative flex items-center gap-1.5 h-[30px] px-2.5 text-[11.5px] font-sans shrink min-w-0 rounded-t-[9px]"
      style={{
        width,
        backgroundColor: active ? "#ffffff" : "transparent",
        color: active ? "#1f1f1f" : "#4a4a4a",
        opacity: dim ? 0.55 : 1,
      }}
    >
      {fav}
      <span className="truncate min-w-0 flex-1">{title}</span>
      {badge && <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ backgroundColor: CAST_RED }} title="cast is driving this tab" />}
      {groupColor && <span className="absolute left-1 right-1 bottom-0 h-[2.5px] rounded-full" style={{ backgroundColor: groupColor }} />}
    </span>
  );
}

/** The agent's cursor: an orange-red arrow with a press ring. */
export function AgentCursor({ x, y, pressing, visible = true }: { x: string; y: string; pressing?: boolean; visible?: boolean }) {
  return (
    <span
      className="bx-cursor pointer-events-none absolute z-20"
      style={{ left: x, top: y, opacity: visible ? 1 : 0 }}
      aria-hidden
    >
      {pressing && <span className="bx-press absolute -left-[9px] -top-[9px] h-[22px] w-[22px] rounded-full" style={{ border: `2px solid ${CAST_RED}` }} />}
      <svg width="18" height="20" viewBox="0 0 18 20" className="relative drop-shadow-[0_2px_3px_rgba(0,0,0,.25)]">
        <path d="M1 1 L1 15.5 L5 12 L8 18.5 L10.6 17.3 L7.7 11 L13 11 Z" fill={CAST_RED} stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** A dark terminal shell matching the site's Terminal card, with a fixed body we can animate. */
export function TermShell({ label, children, className = "", bodyClassName = "" }: { label: string; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <div className={`rounded-xl overflow-hidden shadow-2xl ${className}`} style={{ backgroundColor: SOL.base03, border: "1px solid #094959" }}>
      <div className="flex items-center gap-2 px-3.5 py-2" style={{ backgroundColor: SOL.base02, borderBottom: "1px solid #094959" }}>
        <Lights size={10} />
        <span className="ml-1.5 text-[11px] font-mono truncate" style={{ color: SOL.base01 }}>{label}</span>
      </div>
      <div className={`font-mono text-[11.5px] leading-[1.6] ${bodyClassName}`} style={{ color: SOL.base0 }}>{children}</div>
    </div>
  );
}

/** A pill on a conversation row ("open tab", "watch"), matching the app's row pills. */
export function RowPill({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "cyan" }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] font-mono whitespace-nowrap"
      style={tone === "cyan" ? { color: HUMAN_CYAN, borderColor: "rgba(42,161,152,.4)" } : { color: SOL.base01, borderColor: "rgba(147,161,161,.45)" }}
    >
      {children}
    </span>
  );
}

export const OPEN_TAB_ICON = (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

export const EYE_ICON = (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

export const GLOBE_ICON = (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
  </svg>
);

/** Keyframes and shared classes for the whole page, prefixed bx-. */
export const BX_CSS = `
.bx-cursor { transition: left .9s cubic-bezier(.22,.8,.24,1), top .9s cubic-bezier(.22,.8,.24,1), opacity .3s; }
.bx-press { animation: bx-press .7s ease-out both; }
@keyframes bx-press { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }
.bx-ref { opacity: 0; transform: translateY(3px) scale(.85); transition: opacity .25s, transform .35s cubic-bezier(.3,1.6,.5,1); }
.bx-ref-on { opacity: 1; transform: none; }
.bx-fade { animation: bx-fade .45s ease-out both; }
@keyframes bx-fade { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
.bx-pop { animation: bx-pop .5s cubic-bezier(.3,1.5,.5,1) both; }
@keyframes bx-pop { from { opacity: 0; transform: translateY(-8px) scale(.96) } to { opacity: 1; transform: none } }
.bx-shutter { animation: bx-shutter .6s ease-out both; }
@keyframes bx-shutter { 0% { opacity: .85 } 100% { opacity: 0 } }
.bx-caret::after { content: ""; display: inline-block; width: .55em; height: 1.05em; margin-left: 1px; vertical-align: -0.15em; background: currentColor; animation: bx-blink 1s steps(1) infinite; }
@keyframes bx-blink { 50% { opacity: 0 } }
.bx-blink-human { animation: bx-blink 1.1s steps(1) infinite; }
.bx-spin { animation: bx-spin .8s linear infinite; }
@keyframes bx-spin { to { transform: rotate(360deg) } }
.bx-load { animation: bx-load 1.1s cubic-bezier(.4,0,.2,1) both; transform-origin: left; }
@keyframes bx-load { from { transform: scaleX(0) } to { transform: scaleX(1); opacity: 0 } }
.bx-rise { animation: bx-rise .8s cubic-bezier(.2,.8,.2,1) both; animation-delay: var(--d, 0s); }
@keyframes bx-rise { from { opacity: 0; transform: translateY(18px) } to { opacity: 1; transform: none } }
.bx-ring { animation: bx-ring 2.4s ease-in-out infinite; }
@keyframes bx-ring { 0%,100% { box-shadow: 0 0 0 0 rgba(220,50,47,.0) } 50% { box-shadow: 0 0 0 4px rgba(220,50,47,.18) } }
.bx-still .bx-ref { transition: none; }
.bx-still .bx-cursor, .bx-still .bx-fade, .bx-still .bx-pop, .bx-still .bx-rise { transition: none; animation: none; }
@media (prefers-reduced-motion: reduce) {
  .bx-cursor, .bx-ref { transition: none !important; }
  .bx-press, .bx-fade, .bx-pop, .bx-shutter, .bx-rise, .bx-ring, .bx-load, .bx-caret::after, .bx-blink-human { animation: bx-blink 1.1s steps(1) infinite; }
.bx-spin { animation: none !important; }
}
`;

/**
 * A screenshot: renders `children` at a fixed page size (w x h) and scales it
 * to the box's measured width, so a shot in the thread is the same page,
 * just smaller.
 */
export function Scaled({ w, h, children, className = "", style }: { w: number; h: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useWatchEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => { if (el.clientWidth) setScale(el.clientWidth / w); };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w]);
  return (
    <div ref={ref} className={`relative w-full overflow-hidden rounded-md ${className}`} style={{ aspectRatio: `${w}/${h}`, border: "1px solid rgba(147,161,161,.35)", ...style }}>
      <div className="absolute left-0 top-0 origin-top-left" style={{ width: w, height: h, transform: `scale(${scale})` }}>{children}</div>
    </div>
  );
}
