// Semantic zoom on the org canvas (docs/architecture/org-staffing.md S37): one
// picture read like a map. The canvas zoom picks how much each card says, in
// three levels. Each level is laid out at its own card sizes, so no level
// leaves room it does not use; when the zoom crosses a stop the cards slide
// to the new layout around the one under the pointer (orgViewport.bandOrigin).
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
