"use client";

/**
 * Stand-ins for chapter parts and flyers that have not been built yet. Each
 * names its chapter, where it sits and the real views it will render, so a
 * seek shows every chapter's surfaces in place before their content exists.
 */

import { SCENES, type ChapterId, type RegionKey } from "./world";

export function Placeholder({ chapter, label, region, components, height }: { chapter: ChapterId; label: string; region: RegionKey; components: string[]; height?: number }) {
  const n = SCENES.findIndex((s) => s.id === chapter) + 1;
  return (
    <div
      className="m-2 flex min-h-0 flex-col gap-1.5 overflow-hidden rounded-lg border border-dashed border-sol-border/60 bg-sol-bg-alt/40 p-3 font-mono"
      style={height ? { height, flexShrink: 0 } : { flex: 1 }}
    >
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className="text-sol-yellow">{n}</span>
        <span className="text-sol-text">{label}</span>
        <span className="ml-auto text-[10px] text-sol-text-dim">{region}</span>
      </div>
      <div className="text-[10px] leading-relaxed text-sol-text-muted">{components.join(" · ")}</div>
    </div>
  );
}

/** A flyer stand-in: a pill naming what will fly there. */
export function PlaceholderFlyer({ label }: { label: string }) {
  return (
  <div className="-translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-sol-border/60 bg-sol-card px-3.5 py-2 font-mono text-[13px] text-sol-text shadow-lg">
    {label}
  </div>
  );
}
