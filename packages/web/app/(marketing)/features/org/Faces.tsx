"use client";

import { useCallback, useRef, useState } from "react";
import { useStillMode } from "../kit";
import { Section } from "./kit";
import { SOL } from "./model";
import type { IconKey } from "./icons";
import { accentHex, iconOf, WALL } from "./facesData";
import { Glyph, Inspector } from "./FacesParts";

/*
 * A drawn face for every role. A dark band: the wall of all 32 drawn icons
 * waves in when it scrolls into view; picking a tile opens it in the
 * construction inspector below, which draws its shapes on again.
 *
 * Resting state is the whole wall and Rocket launch in the inspector. Before
 * the wall is armed (server render, ?static, reduced motion) every tile is
 * visible; only a mounted, moving page hides them until the wave plays.
 */

type Phase = "idle" | "armed" | "on";

/** Arms on mount, then turns on when the element scrolls into view. */
function useWave(): [(el: HTMLElement | null) => void, Phase] {
  const [phase, setPhase] = useState<Phase>("idle");
  const io = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    io.current?.disconnect();
    if (!el || typeof IntersectionObserver === "undefined") return;
    setPhase((p) => (p === "idle" ? "armed" : p));
    io.current = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setPhase("on"); io.current?.disconnect(); }
    }, { rootMargin: "0px 0px -18% 0px" });
    io.current.observe(el);
  }, []);
  return [ref, phase];
}

export function Faces() {
  const still = useStillMode();
  const [wallRef, wallPhase] = useWave();
  const [panelRef, panelPhase] = useWave();
  const [sel, setSel] = useState<IconKey>("rocket launch");
  const phase = still ? "idle" : wallPhase;

  return (
    <Section
      id="faces"
      dark
      title="A drawn face for every role"
      lede={
        <p>
          When you hire a role, codecast draws its icon, a picture of what the role looks after. Three drawers sketch in parallel, then a judge picks
          one from a contact sheet and turns down any that look like a sibling's. Pick any tile below to see how it is built.
        </p>
      }
    >
      <style>{CSS}</style>
      <div className="og-faces" data-phase={phase}>
        <div ref={wallRef} className="og-faces-wallwrap relative">
          <div className="og-faces-wall" role="listbox" aria-label="Role icons">
            {WALL.map((k, i) => {
              const c = accentHex(k);
              const col = i % 8, row = Math.floor(i / 8);
              return (
                <button
                  key={k}
                  type="button"
                  role="option"
                  aria-selected={sel === k}
                  aria-label={iconOf(k).concept}
                  onClick={() => setSel(k)}
                  className="og-faces-tile og-faces-a"
                  data-sel={sel === k ? "" : undefined}
                  style={{ ["--fc" as string]: c, ["--d" as string]: `${(col + row) * 0.06}s` }}
                >
                  <span className="og-faces-face">
                    <Glyph k={k} px={64} />
                  </span>
                  <span className="og-faces-tip">{iconOf(k).concept}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div ref={panelRef} className="mt-14">
          <Inspector k={sel} drawKey={`${sel}-${still ? "still" : panelPhase}`} />
        </div>

      </div>
    </Section>
  );
}

// A tile on the wall: the app's geometry (radius 0.28, glyph 0.76 of the side) in the band's dark tint.
const CSS = `
.og-faces-wallwrap { overflow-x: clip; padding: 28px 0 60px; }
.og-faces-wallwrap::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(to right, rgba(147,161,161,.075) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(147,161,161,.075) 1px, transparent 1px);
  background-size: 24px 24px;
  -webkit-mask-image: radial-gradient(ellipse 60% 70% at center, #000 25%, transparent 78%);
  mask-image: radial-gradient(ellipse 60% 70% at center, #000 25%, transparent 78%);
}
.og-faces-wall { position: relative; margin: 0 auto; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 30px 16px; max-width: 320px; }
@media (min-width: 640px) { .og-faces-wall { grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 40px 20px; max-width: 960px; } }
@media (min-width: 1024px) { .og-faces-wall { gap: 44px 40px; } }

.og-faces-tile { position: relative; display: block; width: 100%; max-width: 64px; margin: 0 auto; aspect-ratio: 1; cursor: pointer;
  border-radius: 28%; outline: none; -webkit-tap-highlight-color: transparent; }
.og-faces-face {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border-radius: 28%;
  background: color-mix(in srgb, var(--fc) 24%, ${SOL.base02});
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fc) 55%, ${SOL.base03}),
    0 0 26px -10px color-mix(in srgb, var(--fc) 80%, transparent), 0 12px 22px -16px #000;
  color: color-mix(in srgb, var(--fc) 72%, ${SOL.base3});
  transition: transform .28s var(--og-ease), box-shadow .28s ease, background-color .2s ease;
}
.og-faces-tile::before {
  content: ""; position: absolute; inset: -60%; border-radius: 50%; pointer-events: none; opacity: 0;
  background: radial-gradient(circle, color-mix(in srgb, var(--fc) 42%, transparent) 0%, transparent 62%);
  transition: opacity .3s ease;
}
.og-faces-tile:hover::before, .og-faces-tile:focus-visible::before { opacity: 1; }
.og-faces-tile:hover .og-faces-face, .og-faces-tile:focus-visible .og-faces-face {
  transform: translateY(-5px) scale(1.07);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fc) 80%, ${SOL.base03}),
    0 0 34px -4px color-mix(in srgb, var(--fc) 75%, transparent), 0 18px 26px -16px #000;
}
.og-faces-tile[data-sel] .og-faces-face {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fc) 80%, ${SOL.base03}), 0 0 0 3px ${SOL.base03}, 0 0 0 5px var(--fc),
    0 0 34px -2px color-mix(in srgb, var(--fc) 70%, transparent);
}
.og-faces-tip {
  position: absolute; left: 50%; top: calc(100% + 8px); transform: translate(-50%, -4px); white-space: nowrap; z-index: 2;
  font: 600 11px/1 var(--font-mono, ui-monospace, monospace); padding: 5px 7px; border-radius: 6px;
  background: ${SOL.base3}; color: ${SOL.base02}; opacity: 0; pointer-events: none;
  transition: opacity .16s ease, transform .2s var(--og-ease);
}
.og-faces-tile:hover .og-faces-tip, .og-faces-tile:focus-visible .og-faces-tip { opacity: 1; transform: translate(-50%, 0); }

.og-faces[data-phase="armed"] .og-faces-tile { opacity: 0; }
.og-faces[data-phase="on"] .og-faces-tile { animation: og-faces-wave .75s cubic-bezier(.3,1.35,.5,1) var(--d, 0s) backwards; }
.og-faces[data-phase="on"] .og-faces-tile .og-faces-face { animation: og-faces-flare 1.4s ease-out var(--d, 0s) backwards; }
@keyframes og-faces-wave { from { opacity: 0; transform: translateY(22px) scale(.55) rotate(-8deg); } to { opacity: 1; transform: none; } }
@keyframes og-faces-flare {
  0%, 30% { box-shadow: inset 0 0 0 1px var(--fc), 0 0 46px 4px color-mix(in srgb, var(--fc) 75%, transparent); }
}

.og-faces-panel { background: color-mix(in srgb, ${SOL.base02} 70%, ${SOL.base03}); box-shadow: inset 0 0 0 1px rgba(147,161,161,.16), 0 40px 80px -50px #000; }
.og-faces-canvas {
  background: radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--fc) 16%, ${SOL.base03}) 0%, ${SOL.base03} 72%);
  box-shadow: inset 0 0 0 1px rgba(147,161,161,.18);
  transition: background .4s ease;
}
.og-faces-num { font: 0.9px var(--font-mono, ui-monospace, monospace); fill: ${SOL.base01}; }
.og-faces-cross { position: relative; display: inline-block; width: 11px; height: 11px; }
.og-faces-cross::before, .og-faces-cross::after { content: ""; position: absolute; background: ${SOL.base1}; }
.og-faces-cross::before { left: 0; right: 0; top: 5px; height: 1px; }
.og-faces-cross::after { top: 0; bottom: 0; left: 5px; width: 1px; }
.og-faces-draw { animation: og-faces-draw .85s var(--og-ease) var(--d, 0s) backwards; }
.og-faces-dot { transform-box: fill-box; transform-origin: center; animation: og-faces-dot .45s cubic-bezier(.3,1.5,.5,1) calc(var(--d, 0s) + .3s) backwards; }
.og-faces-swap { animation: og-faces-swap .45s var(--og-ease) backwards; }
@keyframes og-faces-draw { from { stroke-dasharray: 1 2; stroke-dashoffset: 1; } to { stroke-dasharray: 1 2; stroke-dashoffset: 0; } }
@keyframes og-faces-dot { from { transform: scale(0); } to { transform: none; } }
@keyframes og-faces-swap { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }

.og-root[data-static] .og-faces-a, .og-root[data-static] .og-faces-face { animation: none !important; }
.og-root[data-static] .og-faces-tile { opacity: 1 !important; }
@media (prefers-reduced-motion: reduce) {
  .og-faces-a, .og-faces-face { animation: none !important; }
  .og-faces-tile { opacity: 1 !important; }
  .og-faces-face, .og-faces-tip { transition: none; }
  .og-faces-tile:hover .og-faces-face { transform: none; }
}
`;
