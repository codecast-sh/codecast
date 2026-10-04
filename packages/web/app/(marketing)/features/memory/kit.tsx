"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";

export const VIOLET = SOL.violet;

/**
 * The page's motion, scoped under `.mm-root`. Every animated element rests in
 * its final state, so a page whose animations never run (a background tab, a
 * prerender, reduced motion, `?static`) still reads complete. Animations only
 * add the way in.
 */
export const MEMORY_CSS = `
.mm-root { --mm-v: #6c71c4; --mm-ink: #002b36; }
.mm-anim { animation-duration: .6s; animation-timing-function: cubic-bezier(.2,.8,.2,1); animation-fill-mode: both; animation-delay: var(--d, 0s); }
.mm-rise { animation-name: mm-rise; }
.mm-settle { animation-name: mm-settle; animation-duration: .8s; }
.mm-core { animation-name: mm-core; animation-duration: 1.1s; transform-origin: top; }
.mm-open { animation-name: mm-open; animation-duration: .7s; }
.mm-glow { animation-name: mm-glow; animation-duration: 1.4s; }
.mm-type { animation-name: mm-type; animation-duration: .9s; animation-timing-function: steps(32, end); }
@keyframes mm-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes mm-settle { from { opacity: 0; transform: translateY(-16px) scaleY(.7); } to { opacity: 1; transform: none; } }
@keyframes mm-core { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes mm-open { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
@keyframes mm-glow { 0% { background-color: rgba(108,113,196,0); } 40% { background-color: rgba(108,113,196,.28); } 100% { background-color: rgba(108,113,196,.14); } }
@keyframes mm-type { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
.mm-strata { background-color: #fdf6e3; background-image: repeating-linear-gradient(180deg, transparent 0 46px, rgba(108,113,196,.07) 46px 47px, transparent 47px 92px, rgba(181,137,0,.06) 92px 93px); }
.mm-lift { transition: transform .25s cubic-bezier(.2,.8,.2,1), box-shadow .25s ease, border-color .25s ease; }
.mm-lift:hover { transform: translateY(-3px); box-shadow: 0 18px 40px -20px rgba(0,43,54,.4); }
.mm-chip { transition: background-color .18s ease, color .18s ease, transform .12s ease, border-color .18s ease; }
.mm-chip:active { transform: scale(.96); }
.mm-row { transition: background-color .2s ease; }
.mm-root[data-static] .mm-anim { animation: none !important; }
@media (prefers-reduced-motion: reduce) {
  .mm-anim { animation: none !important; }
  .mm-lift, .mm-lift:hover, .mm-chip, .mm-row { transition: none; transform: none; }
}
`;

/** A wide section with a numbered margin label: the page reads as a stack of layers. */
export function Layer({ n, id, title, lede, children, tint = false, wide = false }: {
  n: string; id: string; title: ReactNode; lede: ReactNode; children: ReactNode; tint?: boolean; wide?: boolean;
}) {
  if (wide) {
    return (
      <section id={id} className="relative py-16 sm:py-24" style={{ backgroundColor: tint ? SOL.base2 : "transparent" }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-6">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14 mb-10 items-start">
            <div>
              <LayerNum n={n} />
              <h2 className="font-mono text-2xl sm:text-3xl font-bold tracking-tight leading-tight" style={{ color: SOL.base03 }}>{title}</h2>
            </div>
            <div className="text-[16px] sm:text-[17px] leading-7 space-y-4" style={{ color: SOL.base01 }}>{lede}</div>
          </div>
          <div className="min-w-0">{children}</div>
        </div>
      </section>
    );
  }
  return (
    <section id={id} className="relative py-16 sm:py-24" style={{ backgroundColor: tint ? SOL.base2 : "transparent" }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14 items-start">
          <div className="lg:sticky lg:top-24">
            <LayerNum n={n} />
            <h2 className="font-mono text-2xl sm:text-3xl font-bold tracking-tight leading-tight mb-4" style={{ color: SOL.base03 }}>{title}</h2>
            <div className="text-[16px] sm:text-[17px] leading-7 space-y-4" style={{ color: SOL.base01 }}>{lede}</div>
          </div>
          <div className="min-w-0">{children}</div>
        </div>
      </div>
    </section>
  );
}

function LayerNum({ n }: { n: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="font-mono text-sm font-bold tabular-nums px-2 py-0.5 rounded" style={{ color: SOL.base3, backgroundColor: VIOLET }}>{n}</span>
      <span className="h-px flex-1 max-w-[80px]" style={{ backgroundColor: `color-mix(in srgb, ${VIOLET} 40%, transparent)` }} />
    </div>
  );
}

/** Inline code in prose. */
export function C({ children }: { children: ReactNode }) {
  // Short tokens never split across lines; long commands may wrap so they fit a phone.
  const long = typeof children === "string" && children.length > 24;
  return (
    <code className={`font-mono text-[0.86em] px-1.5 py-0.5 rounded ${long ? "break-words" : "whitespace-nowrap"}`} style={{ backgroundColor: `color-mix(in srgb, ${VIOLET} 10%, ${SOL.base3})`, color: SOL.base02 }}>
      {children}
    </code>
  );
}

/** A dark terminal pane: title bar plus a scrollable pre. Lighter than the blog's, so several fit in one section. */
export function Pane({ label, children, className = "", right, wrap = false }: { label: string; children: ReactNode; className?: string; right?: ReactNode; wrap?: boolean }) {
  return (
    <div className={`rounded-xl overflow-hidden shadow-[0_24px_60px_-30px_rgba(0,43,54,.55)] ${className}`} style={{ backgroundColor: SOL.base03, border: "1px solid #0a4352" }}>
      <div className="flex items-center gap-2 px-4 py-2" style={{ backgroundColor: SOL.base02, borderBottom: "1px solid #0a4352" }}>
        <div className="flex gap-1.5" aria-hidden>
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SOL.red }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SOL.yellow }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SOL.green }} />
        </div>
        <span className="text-[11px] font-mono ml-1 truncate" style={{ color: SOL.base01 }}>{label}</span>
        {right && <span className="ml-auto text-[11px] font-mono" style={{ color: SOL.base01 }}>{right}</span>}
      </div>
      <div className="overflow-x-auto">
        <pre className={`px-4 py-3.5 font-mono text-[11.5px] sm:text-[12px] leading-[1.7]${wrap ? " whitespace-pre-wrap break-words" : ""}`} style={{ color: SOL.base0 }}>{children}</pre>
      </div>
    </div>
  );
}

/** `$ command` line inside a Pane. */
export function Run({ children }: { children: ReactNode }) {
  return (
    <span>
      <span style={{ color: SOL.green }}>$ </span>
      <span style={{ color: SOL.base2 }}>{children}</span>
      {"\n"}
    </span>
  );
}

/** Colored spans for terminal output. */
export const t = {
  dim: (s: ReactNode) => <span style={{ color: SOL.base01 }}>{s}</span>,
  id: (s: ReactNode) => <span style={{ color: SOL.cyan }}>{s}</span>,
  head: (s: ReactNode) => <span style={{ color: SOL.base1 }}>{s}</span>,
  v: (s: ReactNode) => <span style={{ color: "#9a9ee6" }}>{s}</span>,
  y: (s: ReactNode) => <span style={{ color: SOL.yellow }}>{s}</span>,
  g: (s: ReactNode) => <span style={{ color: SOL.green }}>{s}</span>,
  o: (s: ReactNode) => <span style={{ color: SOL.orange }}>{s}</span>,
  m: (s: ReactNode) => <span style={{ color: SOL.magenta }}>{s}</span>,
  ink: (s: ReactNode) => <span style={{ color: SOL.base2 }}>{s}</span>,
};

/** A light callout card: a fact with a short label. */
export function Note({ label, children, color = VIOLET }: { label: string; children: ReactNode; color?: string }) {
  return (
    <div className="rounded-lg px-4 py-3 text-[14px] leading-6" style={{ backgroundColor: `color-mix(in srgb, ${color} 7%, ${SOL.base3})`, border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`, color: SOL.base01 }}>
      <span className="font-mono font-semibold mr-2" style={{ color }}>{label}</span>
      {children}
    </div>
  );
}

/** Click-to-copy command, used in the reference and CTA. */
export function CopyCmd({ cmd, className = "" }: { cmd: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(cmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className={`mm-chip group inline-flex items-center gap-2 max-w-full rounded-lg px-3 py-2 font-mono text-[12.5px] text-left ${className}`}
      style={{ backgroundColor: SOL.base03, color: SOL.base2, border: `1px solid #0a4352` }}
      title="Copy"
    >
      <span style={{ color: SOL.green }}>$</span>
      <span className="truncate">{cmd}</span>
      <span className="ml-auto pl-2 text-[10.5px] shrink-0 transition-opacity" style={{ color: copied ? SOL.green : SOL.base01 }}>{copied ? "copied" : "copy"}</span>
    </button>
  );
}
