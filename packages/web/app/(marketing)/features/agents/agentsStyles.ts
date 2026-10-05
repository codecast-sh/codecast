/**
 * Page-local CSS for /features/agents. Every rule sits under `.agx`, so it
 * cannot reach a sibling page. The resting styles are the END state of every
 * animation: the keyframes only describe how things arrive, so a page whose
 * animations never run (reduced motion, `?static`, a background tab) still
 * reads complete.
 */
export const AGX_CSS = `
.agx { --agx-lane: 22px; }
.agx .agx-grid-bg {
  background-image:
    radial-gradient(circle at 1px 1px, rgba(88,110,117,0.16) 1px, transparent 0);
  background-size: 22px 22px;
}
.agx .agx-row { animation: agxRowIn .55s cubic-bezier(.2,.7,.2,1) both; animation-delay: calc(var(--i, 0) * 260ms + 200ms); }
.agx .agx-rail-line { transform-origin: top; animation: agxDraw .5s ease-out both; animation-delay: calc(var(--i, 0) * 260ms + 140ms); }
.agx .agx-chips { display: inline-grid; }
.agx .agx-chips > * { grid-area: 1 / 1; }
.agx .agx-chip-working { opacity: 0; animation: agxOut .2s ease-in both; animation-delay: calc(var(--done, 0) * 1ms); }
.agx .agx-chip-done { animation: agxShow .3s ease-out both; animation-delay: calc(var(--done, 0) * 1ms + 150ms); }
.agx .agx-pulse { animation: agxPulse 1.4s ease-in-out infinite; }
.agx .agx-hero-copy > * { animation: agxRowIn .6s cubic-bezier(.2,.7,.2,1) both; }
.agx .agx-hero-copy > *:nth-child(2) { animation-delay: .08s; }
.agx .agx-hero-copy > *:nth-child(3) { animation-delay: .16s; }
.agx .agx-hero-copy > *:nth-child(4) { animation-delay: .24s; }
.agx .agx-hero-copy > *:nth-child(5) { animation-delay: .32s; }
.agx .agx-tree-row:hover .agx-card { transform: translateX(3px); }
.agx .agx-card { transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
.agx .agx-choice { transition: background-color .15s ease, color .15s ease, border-color .15s ease, transform .15s ease; }
.agx .agx-choice:hover { transform: translateX(2px); }
.agx .agx-swap { animation: agxSwap .35s cubic-bezier(.2,.7,.2,1) both; }
.agx .agx-node-ping { animation: agxPing 2.4s ease-out infinite; transform-origin: center; transform-box: fill-box; }
.agx .agx-stream-line { animation: agxRowIn .4s ease-out both; animation-delay: calc(var(--i, 0) * 420ms + 300ms); }
.agx .agx-copy-btn { opacity: .55; transition: opacity .15s ease; }
.agx .agx-copy-wrap:hover .agx-copy-btn, .agx .agx-copy-btn:focus-visible { opacity: 1; }

@keyframes agxRowIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes agxDraw { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes agxOut { from { opacity: 1; } to { opacity: 0; } }
@keyframes agxShow { from { opacity: 0; transform: scale(.8); } to { opacity: 1; transform: none; } }
@keyframes agxPulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes agxSwap { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes agxPing { 0% { opacity: .55; transform: scale(1); } 70%, 100% { opacity: 0; transform: scale(2.4); } }

@media (prefers-reduced-motion: reduce) {
  .agx *, .agx *::before, .agx *::after { animation: none !important; transition: none !important; }
}
.agx[data-static] *, .agx[data-static] *::before, .agx[data-static] *::after { animation: none !important; transition: none !important; }
`;
