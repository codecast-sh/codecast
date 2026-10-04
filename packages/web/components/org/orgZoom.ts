// Semantic zoom on the org canvas (docs/architecture/org-staffing.md S37): one
// picture read like a map. The canvas zoom picks how much each card says, in
// three levels, and nothing else changes: the layout reserves every card's
// close size, so zooming never moves a card.
import type { CSSProperties } from "react";
import { useStore } from "@xyflow/react";

export type ZoomLevel = "far" | "mid" | "close";

/** Below `mid` a card is a title and a dot; from `close` up it is the full card. */
export const ZOOM_STOPS = { mid: 0.55, close: 1.15 } as const;

export const zoomLevelOf = (zoom: number): ZoomLevel => (zoom < ZOOM_STOPS.mid ? "far" : zoom < ZOOM_STOPS.close ? "mid" : "close");

/** The level the canvas is at. The selector returns the level, not the zoom,
 *  so a card re-renders when it crosses a stop and never on a zoom tick. */
export function useZoomLevel(): ZoomLevel {
  return useStore((s) => zoomLevelOf(s.transform[2]));
}

/** A card's height at a level. The node's box is the close card's size: the
 *  far and middle cards keep the middle height (`mid`) at the top of it, and
 *  the close card fills it. */
export const levelHeight = (level: ZoomLevel, mid: number | undefined): CSSProperties => (level !== "close" && mid ? { height: mid } : {});
