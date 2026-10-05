/**
 * The page's motion, scoped under `.cl-root`. Every animated element's resting
 * style is its final state, so a page whose animations never run (a background
 * tab, a prerender, reduced motion, `?static`) still reads complete. The
 * animations only add the way in, plus the packets that ride the wire.
 */
export const CLOUD_CSS = `
.cl-anim { animation-duration: .6s; animation-timing-function: cubic-bezier(.2,.8,.2,1); animation-fill-mode: both; animation-delay: var(--d, 0s); }
.cl-rise { animation-name: cl-rise; }
.cl-fade { animation-name: cl-fade; }
.cl-type { animation-name: cl-type; animation-duration: 1.1s; animation-timing-function: steps(34, end); }
.cl-land { animation-name: cl-land; animation-duration: 1.4s; }
.cl-tick { animation-name: cl-tick; animation-duration: .45s; }
@keyframes cl-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes cl-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes cl-type { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes cl-land { 0% { background-color: rgba(38,139,210,.35); } 100% { background-color: rgba(38,139,210,0); } }
@keyframes cl-tick { 0% { opacity: 0; transform: scale(.4); } 70% { transform: scale(1.15); } 100% { opacity: 1; transform: none; } }

/* Packets on the wire: hidden at rest, so a still page shows a quiet wire. */
.cl-packet { position: absolute; opacity: 0; animation: var(--pk, cl-out) var(--len, 2.4s) cubic-bezier(.45,0,.2,1) var(--d, 0s) var(--n, 1) both; }
@keyframes cl-out  { 0% { opacity: 0; left: 0%; } 10% { opacity: 1; } 88% { opacity: 1; } 100% { opacity: 0; left: calc(100% - 10px); } }
@keyframes cl-back { 0% { opacity: 0; left: calc(100% - 10px); } 10% { opacity: 1; } 88% { opacity: 1; } 100% { opacity: 0; left: 0%; } }
@keyframes cl-down { 0% { opacity: 0; top: 0%; } 10% { opacity: 1; } 88% { opacity: 1; } 100% { opacity: 0; top: calc(100% - 10px); } }
@keyframes cl-up   { 0% { opacity: 0; top: calc(100% - 10px); } 10% { opacity: 1; } 88% { opacity: 1; } 100% { opacity: 0; top: 0%; } }

.cl-caret::after { content: ""; display: inline-block; width: .5em; height: 1em; margin-left: 2px; vertical-align: -2px; background: currentColor; opacity: .55; animation: cl-caret 1s steps(1) infinite; }
@keyframes cl-caret { 50% { opacity: 0; } }
.cl-breathe { animation: cl-breathe 2.6s ease-in-out infinite; }
@keyframes cl-breathe { 0%, 100% { box-shadow: 0 0 0 0 rgba(42,161,152,.55); } 50% { box-shadow: 0 0 0 5px rgba(42,161,152,0); } }

.cl-lift { transition: transform .25s cubic-bezier(.2,.8,.2,1), box-shadow .25s ease, border-color .25s ease; }
.cl-lift:hover { transform: translateY(-3px); box-shadow: 0 18px 40px -20px rgba(0,43,54,.4); }
.cl-row { transition: background-color .2s ease; }
.cl-row:hover { background-color: rgba(38,139,210,.07); }
.cl-dark .cl-row:hover { background-color: rgba(147,161,161,.07); }

.cl-paper { background-color: #fdf6e3; background-image: radial-gradient(rgba(88,110,117,.13) 1px, transparent 1.2px); background-size: 18px 18px; }
.cl-night { background-color: #002b36; background-image:
  linear-gradient(rgba(131,148,150,.06) 1px, transparent 1px),
  linear-gradient(90deg, rgba(131,148,150,.06) 1px, transparent 1px);
  background-size: 32px 32px; }

.cl-root { font-variant-ligatures: none; }
.cl-root[data-static] .cl-anim, .cl-root[data-static] .cl-caret::after, .cl-root[data-static] .cl-breathe { animation: none !important; }
.cl-root[data-static] .cl-packet { animation: none !important; opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .cl-anim, .cl-caret::after, .cl-breathe { animation: none !important; }
  .cl-packet { animation: none !important; opacity: 0; }
  .cl-lift, .cl-lift:hover { transition: none; transform: none; }
}
`;
