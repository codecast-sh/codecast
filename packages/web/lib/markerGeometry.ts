// Where each numbered marker of a pinned picture goes, in the picture's own
// pixels: the one geometry the web's canvas (lib/markedImage) and the phone's
// SVG (packages/mobile/lib/markPicture) both draw, so a note's marker lands on
// the same spot in the same shape wherever the picture was marked. Pure: no
// DOM, no react-native.

export type ImageMarker = { x: number; y: number; number: number };

// Solarized yellow, the gallery's pin color.
export const MARKER_FILL = "#b58900";
// A dark under-stroke, then the yellow, so the ring and stem read on any
// background (and on a grayscale screen); widths are fractions of the radius.
export const MARKER_STROKES = [["rgba(0,0,0,0.6)", 0.5], [MARKER_FILL, 0.22]] as const;
export const BADGE_EDGE = { color: "rgba(0,0,0,0.7)", width: 0.18 } as const;
export const BADGE_TEXT = "#000";

export type MarkerShape = {
  number: number;
  r: number;
  /** The ring around the point: what it points at stays visible. */
  ring: { x: number; y: number; r: number };
  /** The stem from the ring's edge to the badge's center. */
  stem: { x1: number; y1: number; x2: number; y2: number };
  /** The numbered badge, and its text's middle (the canvas's "middle" baseline). */
  badge: { x: number; y: number; r: number };
  text: { x: number; y: number; size: number };
};

export function markerRadius(w: number, h: number): number {
  return Math.max(11, Math.round(Math.min(w, h) * 0.022));
}

export function markerShapes(markers: readonly ImageMarker[], w: number, h: number): MarkerShape[] {
  const r = markerRadius(w, h);
  return markers.map((m) => {
    const px = m.x * w;
    const py = m.y * h;
    // The badge sits up and to the right of the point, flipped near an edge
    // so it stays on the picture.
    const dx = px + r * 3.2 > w ? -1 : 1;
    const dy = py - r * 3.2 < 0 ? 1 : -1;
    const bx = px + dx * r * 2;
    const by = py + dy * r * 2;
    const k = r * 0.55;
    return {
      number: m.number,
      r,
      ring: { x: px, y: py, r: k },
      stem: { x1: px + dx * k * Math.SQRT1_2, y1: py + dy * k * Math.SQRT1_2, x2: bx, y2: by },
      badge: { x: bx, y: by, r },
      text: { x: bx, y: by + r * 0.06, size: Math.round(r * 1.15) },
    };
  });
}
