import { FACES_PADDING } from "../calls/faceCrop";

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

/** The float's face sizes, small to large: the row's own 64px, and the old
 *  call circles' two tiers (TIER_DIAMETER: row 128, between them 96). The
 *  person picks one from the float's chrome; it is remembered per device
 *  (`float_face_size`), because a face that suits a laptop is a stamp on an
 *  ultrawide. The header is always 32px. */
export const FLOAT_FACE_SIZES = [64, 96, 128] as const;
export type FloatFaceSize = (typeof FLOAT_FACE_SIZES)[number];

/** The stored size, or the row's own when nothing (or nonsense) is stored. */
export function floatFaceSizeOf(stored: unknown): FloatFaceSize {
  return (FLOAT_FACE_SIZES as readonly unknown[]).includes(stored) ? (stored as FloatFaceSize) : FLOAT_FACE_SIZES[0];
}

/** One step bigger or smaller, stopping at either end. */
export function stepFloatFaceSize(size: FloatFaceSize, dir: 1 | -1): FloatFaceSize {
  const i = FLOAT_FACE_SIZES.indexOf(size) + dir;
  return FLOAT_FACE_SIZES[Math.max(0, Math.min(FLOAT_FACE_SIZES.length - 1, i))];
}

/** The linked pair pulls together: a bridge eats this share of the gap on
 *  each side (faceRow.css `.face-link` margin). */
export const LINK_PULL = 0.35;

/** How wide the row is: the seats, the gaps, and each bridge less the pull.
 *  A bridge is a flex item of its own, so it brings one more gap with it. */
export function faceRowWidth(density: FaceDensity, faces: number, links: number, face = FACE_ROW_METRICS[density].face): number {
  const m = FACE_ROW_METRICS[density];
  if (faces === 0) return m.pad * 2;
  const bridges = Math.min(links, Math.max(0, faces - 1));
  return m.pad * 2 + faces * face + (faces - 1) * m.gap + bridges * (m.gap + m.link - 2 * LINK_PULL * m.gap);
}

/** The row's own box: its circles and their margin. Nothing hangs under a
 *  face at rest; the card band is added by floatingRowSize while it is up. */
export function faceRowSize(
  density: FaceDensity,
  faces: number,
  links: number,
  face = FACE_ROW_METRICS[density].face,
): { width: number; height: number } {
  const m = FACE_ROW_METRICS[density];
  return { width: faceRowWidth(density, faces, links, face), height: m.pad * 2 + face };
}

/** In the float, the card band's top edge sits this far under the row's box
 *  (faceRow.css `.face-row-below` top). The row's 8px margin plus this is the
 *  room the band's notch needs to reach up to the face's paper ring without
 *  touching it: the card reads as hanging from the face, not parked under
 *  the row. */
export const FLOAT_BAND_GAP = 6;

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
 *  the two, as tall as both with the notch's gap between them. Nothing here
 *  reads the pointer: the window changes size only when what it holds
 *  changes (a face arrives, the strip appears, the card opens).
 *
 *  THE ROW IS MEASURED. `measured` is the row element's own box, faces,
 *  bridges, the strip, the call's track and the stack included; the
 *  arithmetic stands in only for the frame before the first measure. A width summed from
 *  constants beside a stylesheet that drew something wider clipped End and
 *  Join off the window's right edge. */
export function floatingRowSize(
  faces: number,
  links: number,
  card: { width: number; height: number },
  measured: { width: number; height: number } = { width: 0, height: 0 },
  face: number = FACE_ROW_METRICS.float.face,
): { width: number; height: number } {
  const m = FACE_ROW_METRICS.float;
  const row = faceRowSize("float", faces, links, face);
  // ONE WIDTH, WHETHER OR NOT A CARD IS UP: the wider of the row (with the
  // strip after the faces) and the card. The window is anchored at a corner
  // and grows away from it, so a window that widened when the card opened
  // slid every face sideways under the pointer on each hover (the founder's
  // "jumping around like crazy", 2026-09-23). The old overlay held
  // max(row, CHROME_WIDTH) for the same reason. Only the height follows the
  // card, and it grows down, away from the faces.
  // Once measured, the measure alone: a stacked row is narrower than its sum.
  const drawn = measured.width > 0 ? Math.ceil(measured.width) : row.width;
  const width = Math.max(drawn, FACE_CARD_WIDTH + m.pad * 2);
  const height = Math.max(row.height, Math.ceil(measured.height));
  if (card.height === 0) return { width, height };
  // The band hangs FLOAT_BAND_GAP under the row, and keeps the row's margin
  // below it for its shadow: on a transparent window a clipped shadow is a
  // straight edge in mid-air.
  return { width, height: height + FLOAT_BAND_GAP + card.height + m.pad };
}

/** Where the float's card band sits across the row, and where its notch
 *  points inside it: centred under the pointed face, held inside the row's
 *  margins. The window is at least as wide as the band (floatingRowSize), so
 *  the band always fits; the notch keeps clear of the band's round corners.
 *  With no face pointed at, the band sits at the row's left margin. */
export function floatBandPlacement(anchor: number | null, rowWidth: number): { left: number; notch: number | null } {
  const pad = FACE_ROW_METRICS.float.pad;
  if (anchor == null) return { left: pad, notch: null };
  const max = Math.max(pad, rowWidth - pad - FACE_CARD_WIDTH);
  const left = Math.round(Math.min(max, Math.max(pad, anchor - FACE_CARD_WIDTH / 2)));
  const notch = Math.min(FACE_CARD_WIDTH - 18, Math.max(18, anchor - left));
  return { left, notch };
}


/** How many faces the header holds before the rest fold into a count. The
 *  model puts me and the faces I am engaged with at the head, so the slice
 *  never cuts a live conversation. */
export const BAR_FACES = 6;


/** The card's width: five words of activity and three buttons in a row. */
export const FACE_CARD_WIDTH = 320;
