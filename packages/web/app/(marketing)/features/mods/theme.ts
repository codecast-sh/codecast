import type { CSSProperties } from "react";
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


/** What the agent typed for the rollout block: three fields. */
export const ROLLOUT_SOURCE = '```rollout\n{ "service": "payments-api", "build": "v412", "canary": 25 }\n```';
