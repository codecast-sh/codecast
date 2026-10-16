"use client";

import { Fragment, type CSSProperties, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";

/** The page's accent: the violet every mod object's pill and page wear in the app. */
export const V = SOL.violet;
export const LINE = "rgba(88,110,117,.2)";
export const TEXT = SOL.base02;
export const MUTED = SOL.base01;
export const DIM = SOL.base1;

/** A soft fill of `c`, as the app tints a pill or a strip. */
export function tint(c: string, pct: number): string {
  return `color-mix(in srgb, ${c} ${pct}%, transparent)`;
}

/** A CSS custom property for an animation delay on a `.md-in` element (seconds). */
export function at(d: number, extra?: CSSProperties): CSSProperties {
  return { ...(extra ?? {}), ["--d" as string]: `${d}s` } as CSSProperties;
}

/**
 * Motion for /features/mods, scoped under `.md-root`. Every element rests in
 * its final state and animations only play the way in, so `?static`, reduced
 * motion, a prerender and a background tab whose timers never run all read
 * complete.
 */
export const MODS_CSS = `
.md-root { --md-v: #6c71c4; }
.md-in { animation: md-rise .6s cubic-bezier(.2,.7,.2,1) var(--d, 0s) both; }
.md-pop { animation: md-pop .45s cubic-bezier(.2,.8,.2,1.05) var(--d, 0s) both; transform-origin: 12% 0; }
.md-raw { opacity: 0; animation: md-raw-out .35s ease var(--d, 0s) both; }
.md-dev { animation: md-develop .5s cubic-bezier(.2,.7,.2,1) var(--d, 0s) both; }
.md-flash { animation: md-flash 1.2s ease var(--d, 0s) both; }
.md-grow { transform-origin: left; animation: md-grow 1s cubic-bezier(.2,.7,.2,1) var(--d, 0s) both; }
.md-draw { stroke-dasharray: 400; animation: md-draw 1.4s cubic-bezier(.4,0,.2,1) var(--d, 0s) both; }
.md-tick { animation: md-tick .5s ease var(--d, 0s) both; }
.md-gone { opacity: 0; visibility: hidden; animation: md-gone .3s ease var(--d, 0s) both; }
@keyframes md-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes md-pop { from { opacity: 0; transform: translateY(-4px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes md-raw-out { 0%, 99% { opacity: 1; } 100% { opacity: 0; } }
@keyframes md-develop {
  0% { opacity: 0; filter: blur(3px); transform: scale(.94); }
  60% { opacity: 1; filter: blur(0); box-shadow: 0 0 0 4px rgba(108,113,196,.22); }
  100% { opacity: 1; transform: none; box-shadow: 0 0 0 0 rgba(108,113,196,0); }
}
@keyframes md-flash { 0% { background-color: rgba(108,113,196,0); } 25% { background-color: rgba(108,113,196,.22); } 100% { background-color: rgba(108,113,196,.06); } }
@keyframes md-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes md-draw { from { stroke-dashoffset: 400; } to { stroke-dashoffset: 0; } }
@keyframes md-tick { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes md-gone { from { opacity: 1; visibility: visible; } to { opacity: 0; visibility: hidden; } }
.md-lift { transition: transform .22s cubic-bezier(.2,.8,.2,1), box-shadow .22s ease, border-color .22s ease, background-color .22s ease; }
.md-lift:hover { transform: translateY(-2px); box-shadow: 0 16px 34px -22px rgba(0,43,54,.45); }
.md-pill { transition: background-color .15s ease, box-shadow .15s ease; }
.md-tile { transition: border-color .18s ease, background-color .18s ease, transform .12s ease; }
.md-tile:active { transform: scale(.98); }
.md-hot { transition: background-color .15s ease, box-shadow .15s ease, opacity .15s ease; border-radius: 5px; }
.md-hot[data-on="true"] { background-color: rgba(108,113,196,.18); box-shadow: 0 0 0 2px rgba(108,113,196,.55); }
.md-dim[data-dim="true"] { opacity: .35; }
.md-grid-bg {
  background-image:
    radial-gradient(circle at 1px 1px, rgba(108,113,196,.16) 1px, transparent 1.4px);
  background-size: 22px 22px;
}
.md-root[data-static] *, .md-root[data-static] *::before, .md-root[data-static] *::after { animation: none !important; transition: none !important; }
.md-root[data-static] .md-raw, .md-root[data-static] .md-gone { opacity: 0 !important; visibility: hidden !important; }
@media (prefers-reduced-motion: reduce) {
  .md-root *, .md-root *::before, .md-root *::after { animation: none !important; transition: none !important; }
  .md-root .md-raw, .md-root .md-gone { opacity: 0 !important; visibility: hidden !important; }
}
`;

/**
 * A page section: a heading and lede, an optional margin note on wide screens,
 * then the section's figure. `marker` is the small reference-shaped tag above
 * the heading, drawn like the pills the page is about.
 */
export function Section({ id, marker, title, lede, children, tone = "paper", aside, dark = false }: {
  id: string; marker?: ReactNode; title: ReactNode; lede: ReactNode; children: ReactNode; tone?: "paper" | "sand" | "grid"; aside?: ReactNode; dark?: boolean;
}) {
  const bg = dark ? SOL.base03 : tone === "sand" ? SOL.base2 : SOL.base3;
  return (
    <section id={id} className={`scroll-mt-20 ${tone === "grid" ? "md-grid-bg" : ""}`} style={{ backgroundColor: bg }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-24">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_280px] gap-x-14 gap-y-5 items-end">
          <div className="min-w-0">
            {marker && <div className="mb-4">{marker}</div>}
            <h2 className="font-mono font-bold text-[26px] sm:text-[34px] leading-[1.15] tracking-[-0.03em] max-w-3xl [text-wrap:balance]" style={{ color: dark ? SOL.base3 : SOL.base03 }}>
              {title}
            </h2>
            <div className="mt-4 text-[17px] leading-8 max-w-2xl space-y-4" style={{ color: dark ? SOL.base1 : SOL.base01 }}>{lede}</div>
          </div>
          {aside && (
            <div className="text-[14px] leading-6 pl-4 border-l-2" style={{ color: dark ? SOL.base1 : SOL.base00, borderColor: V }}>{aside}</div>
          )}
        </div>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

/** Inline code in prose, tinted violet. */
export function C({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  const short = typeof children === "string" && children.length <= 26;
  return (
    <code
      className={`font-mono text-[0.86em] px-1.5 py-0.5 rounded ${short ? "whitespace-nowrap" : "[overflow-wrap:anywhere]"}`}
      style={{ backgroundColor: dark ? SOL.base02 : "rgba(108,113,196,.12)", color: dark ? SOL.base2 : SOL.base02 }}
    >
      {children}
    </code>
  );
}

/** A small mono label above a figure. */
export function Label({ children, color = DIM }: { children: ReactNode; color?: string }) {
  return <div className="font-mono text-[12px] mb-3" style={{ color }}>{children}</div>;
}

/** The app's window chrome around a mock: a title strip, then the body on the card surface. */
export function AppFrame({ title, right, children, className = "", style }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`rounded-xl border ${className}`} style={{ borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 24px 60px -34px rgba(0,43,54,.45)", ...style }}>
      <div className="h-9 px-3.5 rounded-t-xl flex items-center gap-2 border-b text-[11.5px] font-mono" style={{ borderColor: LINE, color: DIM, backgroundColor: "rgba(238,232,213,.45)" }}>
        <span className="flex gap-1.5 mr-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgba(147,161,161,.45)" }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgba(147,161,161,.45)" }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgba(147,161,161,.45)" }} />
        </span>
        <span className="truncate">{title}</span>
        {right && <span className="ml-auto shrink-0">{right}</span>}
      </div>
      {children}
    </div>
  );
}

/* ── Code ────────────────────────────────────────────────────────────────── */

const KEYWORDS = new Set(["on", "async", "await", "return", "const", "export", "import", "from", "true", "false", "null"]);

/** A tiny highlighter for the page's TSX and JSON snippets, in Solarized dark. */
function Highlight({ line }: { line: string }) {
  if (/^\s*(\/\/|#)/.test(line)) return <span style={{ color: SOL.base01 }}>{line}</span>;
  const parts = line.match(/"[^"]*"|'[^']*'|`[^`]*`|<\/?[A-Z][A-Za-z]*|\b\d+(?:\.\d+)?\b|\b[a-z][A-Za-z]*\b|[^"'`<\w]+|./g) ?? [line];
  return (
    <>
      {parts.map((p, i) => {
        let color: string | undefined;
        if (/^["'`]/.test(p)) color = SOL.cyan;
        else if (/^<\/?[A-Z]/.test(p)) color = SOL.blue;
        else if (/^\d/.test(p)) color = SOL.magenta;
        else if (KEYWORDS.has(p)) color = SOL.green;
        else if (p.startsWith("$")) color = SOL.yellow;
        return <Fragment key={i}>{color ? <span style={{ color }}>{p}</span> : p}</Fragment>;
      })}
    </>
  );
}

/** A dark code panel with a file name strip. `mark` lines get a violet gutter. */
export function Code({ file, code, mark = [], className = "", size = 12.5 }: { file: string; code: string; mark?: number[]; className?: string; size?: number }) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <div className={`rounded-xl overflow-hidden border ${className}`} style={{ backgroundColor: SOL.base03, borderColor: "#0b4a5a", boxShadow: "0 24px 60px -32px rgba(0,0,0,.55)" }}>
      <div className="h-9 px-4 flex items-center border-b font-mono text-[11.5px]" style={{ borderColor: "#0b4a5a", color: SOL.base01, backgroundColor: SOL.base02 }}>
        {file}
      </div>
      <pre className="py-3.5 overflow-x-auto font-mono leading-[1.7]" style={{ fontSize: size, color: SOL.base0 }}>
        {lines.map((l, i) => (
          <div key={i} className="px-4 border-l-2" style={{ borderColor: mark.includes(i + 1) ? V : "transparent", backgroundColor: mark.includes(i + 1) ? "rgba(108,113,196,.12)" : undefined }}>
            <Highlight line={l || " "} />
          </div>
        ))}
      </pre>
    </div>
  );
}
