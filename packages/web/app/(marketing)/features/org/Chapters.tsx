"use client";

import { useState } from "react";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { Tile } from "./kit";
import { INK, LINE, MUTED, PAPER } from "./model";
import type { IconKey } from "./icons";

/*
 * A rail of the page's sections on wide screens, each wearing a role tile.
 * The section in view is lit and named; the rest show their tile alone and
 * name themselves on hover. It appears once the hero has scrolled away.
 */

const CHAPTERS: { id: string; label: string; k: IconKey }[] = [
  { id: "needs-you", label: "What reaches you", k: "speech bubbles" },
  { id: "the-chart", label: "The whole company", k: "app layout" },
  { id: "proposals", label: "Changing the chart", k: "org chart" },
  { id: "a-role", label: "What a role is", k: "rocket launch" },
  { id: "templates", label: "Hiring", k: "briefcase" },
  { id: "faces", label: "Faces", k: "lightbulb" },
  { id: "routing", label: "Where work lands", k: "compass" },
  { id: "control", label: "Pause, split, undo", k: "gauge" },
];

const CSS = `
.og-ch { position: fixed; left: max(10px, calc((100vw - 72rem) / 2 - 150px)); top: 50%; transform: translateY(-50%); z-index: 30; transition: opacity .3s ease, transform .3s ease; }
.og-ch[data-on="false"] { opacity: 0; pointer-events: none; transform: translate(-8px, -50%); }
.og-ch a { display: flex; align-items: center; gap: 10px; padding: 5px 8px 5px 5px; border-radius: 10px; transition: background-color .18s ease; }
.og-ch-label { font: 500 12px/1 var(--font-mono, ui-monospace), monospace; padding: 5px 8px; border-radius: 7px; background: ${PAPER}; box-shadow: 0 0 0 1px ${LINE}; white-space: nowrap; opacity: 0; transform: translateX(-4px); transition: opacity .18s ease, transform .18s ease; }
.og-ch a:hover .og-ch-label, .og-ch a[aria-current="true"] .og-ch-label { opacity: 1; transform: none; }
.og-ch-tile { transition: filter .2s ease, opacity .2s ease; filter: grayscale(.85); opacity: .55; }
.og-ch a:hover .og-ch-tile, .og-ch a[aria-current="true"] .og-ch-tile { filter: none; opacity: 1; }
@media (max-width: 1439px) { .og-ch { display: none; } }
@media (prefers-reduced-motion: reduce) { .og-ch, .og-ch * { transition: none !important; } }
`;

export function Chapters() {
  const [active, setActive] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  useMountEffect(() => {
    const seen = new Map<string, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
      let best: string | null = null;
      let ratio = 0;
      for (const c of CHAPTERS) {
        const r = seen.get(c.id) ?? 0;
        if (r > ratio) { ratio = r; best = c.id; }
      }
      setActive(best);
      setOn(best !== null);
    }, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1], rootMargin: "-30% 0px -40% 0px" });
    for (const c of CHAPTERS) {
      const el = document.getElementById(c.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  });
  return (
    <nav className="og-ch" data-on={on} aria-label="Sections">
      <style>{CSS}</style>
      <div className="flex flex-col gap-0.5">
        {CHAPTERS.map((c) => (
          <a key={c.id} href={`#${c.id}`} aria-current={active === c.id}>
            <Tile k={c.k} size={22} className="og-ch-tile" />
            <span className="og-ch-label" style={{ color: active === c.id ? INK : MUTED }}>{c.label}</span>
          </a>
        ))}
      </div>
    </nav>
  );
}
