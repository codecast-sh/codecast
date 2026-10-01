"use client";

/** Typed text the film driver writes (see filmClock.ts for the rest of the clock). */

import type { CSSProperties } from "react";
import { POSTER_FRAME } from "./filmClock";

/** Text the driver types (a TextBeat), seeded with its poster-frame value. */
export function FlyText({ id, className, style }: { id: string; className?: string; style?: CSSProperties }) {
  return (
    <span data-fly-text={id} className={className} style={style}>
      {POSTER_FRAME.texts[id]}
    </span>
  );
}
