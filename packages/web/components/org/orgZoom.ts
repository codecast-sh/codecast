// Semantic zoom on the org canvas (docs/architecture/org-staffing.md S37): one
// picture read like a map. The canvas zoom picks how much each card says, in
// three levels. Each level is laid out at its own card sizes, so no level
// leaves room it does not use; when the zoom crosses a stop the cards slide
// to the new layout around the one under the pointer (orgViewport.bandOrigin).
import { createContext, useContext } from "react";
import { useStore } from "@xyflow/react";

export type ZoomLevel = "far" | "mid" | "close";

/** Below `mid` a card is its name and a two-line summary in large type; from
 *  `mid` up it is the full card. `mid` sits where the full card's 10.5px text
 *  falls under about 8px on screen. */
export const ZOOM_STOPS = { mid: 0.8, close: 1.15 } as const;

export const zoomLevelOf = (zoom: number): ZoomLevel => (zoom < ZOOM_STOPS.mid ? "far" : zoom < ZOOM_STOPS.close ? "mid" : "close");

/** A chart that keeps one layout at every zoom (the people chart) pins its
 *  cards' level here; zooming it scales the picture and the text keeps itself
 *  readable (zoomText), so nothing reflows under the pointer. */
export const PinnedZoomLevel = createContext<ZoomLevel | null>(null);

/** The level the canvas is at, unless the chart pinned one. The selector
 *  returns the level, not the zoom, so a card re-renders when it crosses a
 *  stop and never on a zoom tick. */
export function useZoomLevel(): ZoomLevel {
  const pinned = useContext(PinnedZoomLevel);
  const live = useStore((s) => zoomLevelOf(s.transform[2]));
  return pinned ?? live;
}

/** A font size that holds its size on screen as the canvas zooms out, from
 *  `px` at 100% up to `max` (the size the card's box is booked for), then
 *  shrinks with the canvas. `--orgz` is the canvas zoom, set on every move. */
export const zoomText = (px: number, max: number) => `clamp(${px}px, calc(${px}px / var(--orgz, 1)), ${max}px)`;
