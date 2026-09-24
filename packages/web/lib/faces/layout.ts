import { FACES_PADDING, NAME_HEIGHT, ROW_GAP } from "../calls/faceCrop";

// ── layout ──────────────────────────────────────────────────────────────────

export type FaceDensity = "bar" | "float";

/** The row's measurements per density: the circle, the gap between seats,
 *  the bridge a link draws, and the margin around the row. Mirrored in
 *  faceRow.css (`--face`, `--face-gap`, `--link-w`, the float padding); the
 *  layout test holds the two together. */
export const FACE_ROW_METRICS: Record<FaceDensity, { face: number; gap: number; link: number; pad: number }> = {
  bar: { face: 32, gap: 6, link: 14, pad: 0 },
  float: { face: 64, gap: 10, link: 26, pad: FACES_PADDING },
};

/** The linked pair pulls together: a bridge eats this share of the gap on
 *  each side (faceRow.css `.face-link` margin). */
export const LINK_PULL = 0.35;

/** How wide the row is: the seats, the gaps, and each bridge less the pull. */
export function faceRowWidth(density: FaceDensity, faces: number, links: number): number {
  const m = FACE_ROW_METRICS[density];
  if (faces === 0) return m.pad * 2;
  const bridges = Math.min(links, Math.max(0, faces - 1));
  return m.pad * 2 + faces * m.face + (faces - 1) * m.gap + bridges * (m.link - 2 * LINK_PULL * m.gap);
}

/** The window a floating row needs: its circles and their margin, plus the
 *  name row while the pointer is on a face (the same band the call circles
 *  reserve, NAME_HEIGHT). */
/** The window a floating row needs: its circles and their margin, plus the
 *  name band under the chins (ROW_GAP + NAME_HEIGHT), reserved AT ALL TIMES.
 *  A band that came and went with the pointer resized the window under the
 *  hand every 1.5s; the founder called it jumping around. */
export function faceRowSize(density: FaceDensity, faces: number, links: number): { width: number; height: number } {
  const m = FACE_ROW_METRICS[density];
  return {
    width: faceRowWidth(density, faces, links),
    height: m.pad * 2 + m.face + (density === "float" ? ROW_GAP + NAME_HEIGHT : 0),
  };
}

// ── the FLIP ────────────────────────────────────────────────────────────────

/** One face's travel: from where it was to where the layout put it. Null when
 *  it did not move, so a level tick or a mute never starts an animation. */
export function flipKeyframes(
  from: { left: number; top: number },
  to: { left: number; top: number },
): Keyframe[] | null {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (dx === 0 && dy === 0) return null;
  return [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }];
}

// ── the row ─────────────────────────────────────────────────────────────────

/** The dwell before a pointed at face opens its card: a drive by pointer
 *  never flashes one. */
export const CARD_OPEN_MS = 150;

/** The grace after the pointer leaves a face or its card: crossing from the
 *  face into the card, or between faces, never drops it. */
export const CARD_CLOSE_MS = 220;

/** The floating window with a card under the row: as wide as the wider of
 *  the two, as tall as both with the name band between them. Nothing here
 *  reads the pointer: the window changes size only when what it holds
 *  changes (a face arrives, the strip appears, the card opens). */
/** The gap between the last face and the strip beside it (faceRow.css `.face-row-strip`). */
export const STRIP_GAP = 10;

export function floatingRowSize(
  faces: number,
  links: number,
  card: { width: number; height: number },
  strip: { width: number; height: number } = { width: 0, height: 0 },
): { width: number; height: number } {
  const m = FACE_ROW_METRICS.float;
  const row = faceRowSize("float", faces, links);
  // The strip sits in the row after the faces: the row is that much wider,
  // and as tall as the taller of the two.
  const width = row.width + (strip.width > 0 ? STRIP_GAP + strip.width : 0);
  const height = Math.max(row.height, strip.height + m.pad * 2);
  if (card.height === 0) return { width, height };
  // The card's band is under the name band (faceRow.css `.face-row-below`).
  return { width: Math.max(width, card.width + m.pad * 2), height: height + card.height };
}


/** How many faces the header holds before the rest fold into a count. The
 *  model puts me and the faces I am engaged with at the head, so the slice
 *  never cuts a live conversation. */
export const BAR_FACES = 6;


/** The card's width: five words of activity and three buttons in a row. */
export const FACE_CARD_WIDTH = 320;
