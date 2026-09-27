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

/** Room kept for the card band beside the row, at all times: the tallest
 *  card the float shows (a teammate's card with its unread line and the
 *  float's controls under it) and some. The window never changes size when
 *  a card opens, closes or its controls come and go; only the band inside it
 *  does, and the faces hold still. A card taller than this raises the room
 *  to fit it (floatingRowSize's `band`), once. */
export const FLOAT_BAND_RESERVE = 300;

/** Which side of the faces the float's card opens on: toward the middle of
 *  the screen, so a row tucked in the bottom corner opens its card above
 *  itself instead of off the screen's edge. */
export type FloatBandSide = "below" | "above";

export function floatBandSideFor(faceCentreY: number, area: { top: number; height: number }): FloatBandSide {
  return faceCentreY > area.top + area.height / 2 ? "above" : "below";
}

/**
 * The floating window: the row, and the room its card band opens into.
 *
 * ONE SIZE, WHATEVER THE POINTER DOES. The window used to grow when the
 * pointer brought the controls or a card and shrink when it left. The shell
 * hangs the window from a corner, so a row tucked in the bottom half grew
 * UPWARD and carried its faces up under the pointer on every hover (the
 * founder, 2026-09-28: "the faces MUST be stable when we hover"). Now the
 * room is kept whether or not anything is in it; it is glass, and the glass
 * lets every click through. The size changes only when the row does (a face
 * arrives, the size step), and then `pinY` keeps the faces where they were.
 *
 * `measured` is the row element's own box, faces, bridges, the strip, the
 * call's track and the stack included; the arithmetic stands in only for the
 * frame before the first measure. `band` is the tallest card seen, at least
 * FLOAT_BAND_RESERVE. `pinY` is the row's top inside the window: 0 with the
 * band below the faces, the band's room with it above.
 */
export function floatingRowSize(
  faces: number,
  links: number,
  band: number,
  measured: { width: number; height: number } = { width: 0, height: 0 },
  face: number = FACE_ROW_METRICS.float.face,
  side: FloatBandSide = "below",
): { width: number; height: number; pinY: number } {
  const m = FACE_ROW_METRICS.float;
  const row = faceRowSize("float", faces, links, face);
  // As wide as the wider of the row (with the strip after the faces) and the
  // card. Once measured, the measure alone: a stacked row is narrower than
  // its sum, and a sum beside a stylesheet that drew something wider clipped
  // End and Join off the window's right edge.
  const drawn = measured.width > 0 ? Math.ceil(measured.width) : row.width;
  const width = Math.max(drawn, FACE_CARD_WIDTH + m.pad * 2);
  const rowHeight = Math.max(row.height, Math.ceil(measured.height));
  // The band hangs FLOAT_BAND_GAP off the row, and keeps the row's margin
  // beyond it for its shadow: on a transparent window a clipped shadow is a
  // straight edge in mid-air.
  const room = FLOAT_BAND_GAP + Math.max(FLOAT_BAND_RESERVE, Math.ceil(band)) + m.pad;
  return { width, height: rowHeight + room, pinY: side === "above" ? room : 0 };
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
