/**
 * The page's motion, scoped under `.pb-root`. Every animated element's
 * resting style IS its final state, so a page whose timers never run (a
 * background tab, a prerender, reduced motion, `?static`) still reads complete.
 * Animations only add the way in.
 */
export const PUBLISH_CSS = `
.pb-root { --pb-cyan: #2aa198; --pb-ink: #002b36; }
.pb-anim { animation-duration: .55s; animation-timing-function: cubic-bezier(.2,.8,.2,1); animation-fill-mode: both; animation-delay: var(--d, 0s); }
.pb-rise { animation-name: pb-rise; }
.pb-drop { animation-name: pb-drop; animation-duration: .7s; }
.pb-type { animation-name: pb-type; animation-duration: .9s; animation-timing-function: steps(28, end); }
.pb-blip { animation-name: pb-blip; animation-timing-function: linear; animation-duration: var(--len, 1s); opacity: 0; }
.pb-pulse { animation-name: pb-pulse; animation-duration: .9s; }
.pb-pin { animation-name: pb-pin; animation-duration: .5s; }
.pb-mark { animation-name: pb-mark; animation-duration: .7s; }
@keyframes pb-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes pb-drop { from { opacity: 0; transform: translate(-18px,-26px) rotate(-2.5deg); } to { opacity: 1; transform: none; } }
@keyframes pb-type { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes pb-blip { 0% { opacity: 0; } 8% { opacity: 1; } 92% { opacity: 1; } 100% { opacity: 0; } }
@keyframes pb-pulse { 0% { box-shadow: 0 0 0 0 rgba(42,161,152,.55); } 100% { box-shadow: 0 0 0 10px rgba(42,161,152,0); } }
@keyframes pb-pin { 0% { opacity: 0; transform: translateY(-14px) scale(.6); } 70% { transform: translateY(2px) scale(1.05); } 100% { opacity: 1; transform: none; } }
@keyframes pb-mark { from { background-size: 0% 100%; } to { background-size: 100% 100%; } }
.pb-caret::after { content: ""; display: inline-block; width: .55em; height: 1.05em; margin-left: 2px; vertical-align: -2px; background: #93a1a1; animation: pb-caret 1s steps(1) infinite; }
@keyframes pb-caret { 50% { opacity: 0; } }
.pb-hl { background-image: linear-gradient(rgba(42,161,152,.22), rgba(42,161,152,.22)); background-repeat: no-repeat; background-size: 100% 100%; }
.pb-lift { transition: transform .25s cubic-bezier(.2,.8,.2,1), box-shadow .25s ease; }
.pb-lift:hover { transform: translateY(-3px); box-shadow: 0 18px 40px -18px rgba(0,43,54,.35); }
.pb-copy:active { transform: scale(.97); }
.pb-paper { background-color: #fdf6e3; background-image:
  linear-gradient(rgba(42,161,152,.07) 1px, transparent 1px),
  linear-gradient(90deg, rgba(42,161,152,.07) 1px, transparent 1px);
  background-size: 28px 28px; }
.pb-root[data-static] .pb-anim, .pb-root[data-static] .pb-caret::after { animation: none !important; }
@media (prefers-reduced-motion: reduce) {
  .pb-anim, .pb-caret::after { animation: none !important; }
  .pb-lift, .pb-lift:hover { transition: none; transform: none; }
}
`;
