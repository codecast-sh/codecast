"use client";

/** What the film driver writes beyond styles: typed text, and veils (see filmClock.ts for the rest of the clock). */

import type { CSSProperties } from "react";
import { fly, POSTER_FRAME } from "./filmClock";

/** Text the driver types (a TextBeat), seeded with its poster-frame value. */
export function FlyText({ id, className, style }: { id: string; className?: string; style?: CSSProperties }) {
  return (
    <span data-fly-text={id} className={className} style={style}>
      {POSTER_FRAME.texts[id]}
    </span>
  );
}

/** A wash of the page colour over a surface (a `scrim` region), faded by its beats: it steps the surface back while the camera frames something else. */
export function Veil({ id }: { id: string }) {
  return <div {...fly(id)} aria-hidden className="pointer-events-none h-full w-full bg-sol-bg/70" />;
}
