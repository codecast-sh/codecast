/**
 * The page's keyframes. Every animated element's resting CSS is its FINAL
 * state and the keyframes only describe where it comes from, so a page whose
 * animations never run (reduced motion, `?static`, a throttled background
 * tab) still renders complete.
 */
export const NIGHT_SECONDS = 11;
export const NIGHT_LEAD = 0.9;

/** Seconds into the load sequence at which the playhead reaches a percentage of the night. */
export function atPct(p: number): number {
  return NIGHT_LEAD + (NIGHT_SECONDS * p) / 100;
}

export const TRIGGER_CSS = `
@keyframes tg-rise { from { opacity: 0; transform: translateY(10px); } }
@keyframes tg-fade { from { opacity: 0; } }
@keyframes tg-pop { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.2); } 70% { transform: translate(-50%, -50%) scale(1.35); } }
@keyframes tg-ring { 0% { opacity: 0.9; transform: translate(-50%, -50%) scale(0.6); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(2.6); } }
@keyframes tg-sweep { from { left: 0%; } }
@keyframes tg-grow { from { transform: scaleX(0); } }
@keyframes tg-blink { 50% { opacity: 0.25; } }
@keyframes tg-tick { from { opacity: 0.15; } }
@keyframes tg-dash { to { stroke-dashoffset: -24; } }

.tg-rise { animation: tg-rise 0.7s cubic-bezier(.2,.7,.2,1) both; }
.tg-fade { animation: tg-fade 0.6s ease-out both; }
.tg-pop { animation: tg-pop 0.45s cubic-bezier(.2,.7,.3,1.4) both; }
.tg-ring { animation: tg-ring 1.1s ease-out both; opacity: 0; }
.tg-sweep { animation: tg-sweep ${NIGHT_SECONDS}s linear both; }
.tg-grow { animation: tg-grow var(--grow, 1s) linear both; transform-origin: left center; }
.tg-blink { animation: tg-blink 1.6s ease-in-out infinite; }
.tg-flow { stroke-dasharray: 5 7; animation: tg-dash 1.2s linear infinite; }

.tg-marker:hover .tg-tip, .tg-marker:focus-visible .tg-tip { opacity: 1; transform: translate(var(--tx, -50%), 0); }
.tg-tip { opacity: 0; transform: translate(var(--tx, -50%), 4px); transition: opacity .15s ease, transform .15s ease; pointer-events: none; }

.tg-root, .tg-root * { font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0; }

.tg-static *, .tg-static *::before, .tg-static *::after { animation: none !important; }
@media (prefers-reduced-motion: reduce) {
  .tg-root *, .tg-root *::before, .tg-root *::after { animation: none !important; transition: none !important; }
}
`;
