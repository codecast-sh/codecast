// The math behind the floating faces: turn a video frame into a circle that
// holds a person's face, and keep that circle steady while the person moves.
//
// Everything here is pure. The face detector is a sampler running at 3Hz, the
// draw loop runs at the display's rate, and neither may go near React state —
// so the component keeps the numbers in refs and pushes them to the DOM as CSS
// custom properties. Pure functions are what makes that arrangement testable:
// the jitter, the drift and the swap timing are all decided in here.

/**
 * A square crop of a video frame, in the frame's own normalized coordinates.
 *
 * `cx`/`cy` are the crop's center as a fraction of the frame's width and
 * height. `size` is the crop's side as a fraction of the frame's HEIGHT — one
 * number for a square, because a circle is square and a face is roughly as
 * wide as it is tall. `size: 1` is the full height of the frame, which is the
 * ordinary center crop a webcam gives you when nobody is found.
 */
export type Crop = { cx: number; cy: number; size: number };

/** A face box as the Shape Detection API reports it: video pixels. */
export type FaceBox = { x: number; y: number; width: number; height: number };

/** What to show when no face was found: the middle of the frame, full height. */
export const CENTER_CROP: Crop = { cx: 0.5, cy: 0.5, size: 1 };

/**
 * How much room to leave around the detected face.
 *
 * A face box is the face alone — chin to hairline, ear to ear. Cropped to it,
 * the circle is a pair of eyes and nostrils filling the frame, which reads as
 * a security camera rather than a person. 2.1 puts the head in the circle with
 * the top of the shoulders, which is how a person is normally framed.
 */
export const FACE_PADDING = 2.1;

/**
 * The crop that frames a detected face.
 *
 * The box arrives in video pixels because that is what FaceDetector measures
 * in, and the frame's dimensions vary per camera; normalizing here means every
 * consumer downstream works in one coordinate system.
 */
export function cropFromFace(box: FaceBox, videoW: number, videoH: number, pad = FACE_PADDING): Crop {
  if (!(videoW > 0) || !(videoH > 0)) return CENTER_CROP;
  return {
    cx: (box.x + box.width / 2) / videoW,
    cy: (box.y + box.height / 2) / videoH,
    size: (box.height * pad) / videoH,
  };
}

/**
 * Pull a crop back inside the frame it is cropping.
 *
 * A face near the edge of the frame asks for a crop that runs off it, and a
 * crop that runs off the frame shows the page through the circle — on a
 * transparent window that is a hole, not a letterbox. So the square is first
 * shrunk to something the frame can contain, then slid in.
 *
 * `aspect` is the frame's width over its height, which is what decides how
 * much of the width a height-relative square costs.
 */
export function clampCrop(crop: Crop, aspect: number): Crop {
  const a = aspect > 0 ? aspect : 1;
  // The square is `size` tall in height units and `size / a` wide in width
  // units, so a frame wider than it is tall (every webcam) constrains height.
  const size = Math.min(Math.max(crop.size, 0.05), Math.min(1, a));
  const halfW = size / (2 * a);
  const halfH = size / 2;
  return {
    size,
    cx: Math.min(Math.max(crop.cx, halfW), 1 - halfW),
    cy: Math.min(Math.max(crop.cy, halfH), 1 - halfH),
  };
}

/**
 * Ease a crop toward where the face now is.
 *
 * FaceDetector's box shivers by a few pixels between samples even on a face
 * that has not moved, and at 3Hz that shiver arrives as a visible twitch every
 * third of a second. Two things settle it: a deadzone that ignores movement
 * too small to be real, and a lerp that spreads the movement that survives
 * across the frames between samples.
 *
 * Returns the SAME object when nothing moved, so a caller can skip the write.
 */
export function lerpCrop(cur: Crop, target: Crop, alpha: number, deadzone = 0.004): Crop {
  const dx = target.cx - cur.cx;
  const dy = target.cy - cur.cy;
  const ds = target.size - cur.size;
  if (Math.abs(dx) < deadzone && Math.abs(dy) < deadzone && Math.abs(ds) < deadzone) return cur;
  const a = Math.min(Math.max(alpha, 0), 1);
  return { cx: cur.cx + dx * a, cy: cur.cy + dy * a, size: cur.size + ds * a };
}

/** Where the video element sits inside a circle of `diameter` px. */
export type CropBox = { width: number; height: number; left: number; top: number };

/**
 * Place and scale the video so its crop fills the circle.
 *
 * The circle is a fixed box with `overflow: hidden`; the video inside it is
 * blown up until the crop's side equals the circle's diameter, then slid until
 * the crop's center sits at the circle's center. Everything outside the circle
 * is clipped, which is what makes the window read as a floating face rather
 * than a floating video.
 */
export function cropBox(crop: Crop, diameter: number, aspect: number): CropBox {
  const a = aspect > 0 ? aspect : 1;
  const size = crop.size > 0 ? crop.size : 1;
  const height = diameter / size;
  const width = height * a;
  return {
    width,
    height,
    left: diameter / 2 - crop.cx * width,
    top: diameter / 2 - crop.cy * height,
  };
}

/**
 * The crop as a CSS transform, which is how it actually reaches the screen.
 *
 * The video element is laid out as a plain `diameter × diameter` square with
 * `object-fit: fill` and `transform-origin: 0 0`; this scales that square back
 * out to the frame's real proportions and slides the crop's center to the
 * circle's. One composited property per frame, so the smoothing loop never
 * touches layout — with several circles running at the display's rate, writing
 * width/left/top instead would be a layout on every video on every frame.
 *
 * `mirror` is for your own camera. A self-view that is not mirrored reads as
 * somebody else's face doing the opposite of what you do.
 */
export function cropTransform(box: CropBox, diameter: number, mirror = false): string {
  const sx = box.width / diameter;
  const sy = box.height / diameter;
  if (!mirror) {
    return `translate3d(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  }
  // Flipped horizontally about the circle: the frame now runs right to left, so
  // it starts where it used to end.
  const left = diameter - box.left;
  return `translate3d(${left.toFixed(2)}px, ${box.top.toFixed(2)}px, 0) scale(${(-sx).toFixed(4)}, ${sy.toFixed(4)})`;
}

// ── Who the speaker circle shows ──────────────────────────────────────────

/** The face speaker mode is currently showing, and when it started showing it. */
export type SpeakerPick = { id: string | null; since: number };

/** How long a new voice must hold the floor before the circle swaps to it. */
export const SPEAKER_HOLD_MS = 1500;

/**
 * Decide whose face the single circle shows.
 *
 * Two rules, both about not flapping. Silence never empties the circle: in a
 * conversation the gaps between sentences are constant, and a circle that
 * cleared itself in every gap would blink all call. And a new voice has to
 * hold the floor for `holdMs` before the circle follows it, so the "mhm" over
 * somebody's sentence does not steal the frame and hand it back.
 *
 * The first voice of a call is the exception: there is nothing on screen to
 * protect, so it lands immediately.
 */
export function pickSpeaker(
  prev: SpeakerPick,
  active: string[],
  now: number,
  holdMs = SPEAKER_HOLD_MS,
): SpeakerPick {
  const candidate = active.length > 0 ? active[0] : null;
  if (candidate === null) return prev;
  if (candidate === prev.id) return prev;
  if (prev.id === null) return { id: candidate, since: now };
  return now - prev.since >= holdMs ? { id: candidate, since: now } : prev;
}

// ── Who gets a circle ─────────────────────────────────────────────────────

/** A person in the room, as a circle needs them. */
export type FacePerson = {
  id: string;
  name: string;
  image?: string;
  isLocal: boolean;
  muted: boolean;
  hasVideo: boolean;
};

/** An occupancy row (convex `call_members`), loosely typed as the store holds it. */
export type RosterRow = { user_id?: unknown; user_name?: string; user_image?: string; muted?: boolean };
/** A camera tile, as callManager publishes them. */
export type TileRow = { identity: string; name: string; image?: string; isLocal: boolean };

/**
 * The people in the room, merged from the two sources that each know half.
 *
 * Occupancy is the roster — it has everyone, including the people whose camera
 * is off, and it is the only side that knows who is muted. The video tiles know
 * who is actually on screen. Neither is a superset: occupancy can lag a join by
 * a moment, and a camera track can arrive before the row does, so a person
 * present in either gets a circle.
 *
 * Roster order comes first and is kept. A circle that moved when somebody
 * started talking would make a row of faces shuffle all call.
 */
export function facePeople(roster: RosterRow[], tiles: TileRow[], selfId: string | null): FacePerson[] {
  const withVideo = new Set(tiles.map((t) => t.identity));
  const seen = new Set<string>();
  const out: FacePerson[] = [];
  for (const m of roster) {
    const id = m.user_id == null ? "" : String(m.user_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: m.user_name || "teammate",
      image: m.user_image,
      isLocal: id === selfId,
      muted: m.muted === true,
      hasVideo: withVideo.has(id),
    });
  }
  for (const t of tiles) {
    if (seen.has(t.identity)) continue;
    seen.add(t.identity);
    out.push({
      id: t.identity,
      name: t.name || "teammate",
      image: t.image,
      isLocal: t.isLocal || t.identity === selfId,
      muted: false,
      hasVideo: true,
    });
  }
  return out;
}

/**
 * Which of them the window actually shows.
 *
 * The other people, not you. The floating faces exist so you can see who you
 * are talking to while you work in something else; your own face floating over
 * your own screen is a mirror you did not ask for, and in speaker mode it would
 * take the circle every time you spoke. Your mic and camera are still yours to
 * control — they live on the hover chrome, which is where controls belong.
 *
 * Alone in the room, you get the circle: an empty window would read as broken,
 * and seeing yourself is the honest picture of a call nobody has joined yet.
 */
export function facesToShow(people: FacePerson[]): FacePerson[] {
  const others = people.filter((p) => !p.isLocal);
  return others.length > 0 ? others : people;
}

// ── Click-through ─────────────────────────────────────────────────────────

/**
 * A region of the window that takes the mouse. Circles are the faces; the rect
 * is the hover chrome, which is a row of buttons rather than a disc.
 */
export type HitRegion =
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "rect"; x: number; y: number; width: number; height: number };

/**
 * Is the pointer over something in this window that should respond?
 *
 * The window covers a rectangle but the product is a few circles; everywhere
 * else the click belongs to whatever application is underneath. The shell
 * cannot answer this — it knows the window's bounds, not where the circles
 * are — so the renderer answers it here and tells the shell, which is the
 * ordinary Electron arrangement for a partly transparent window.
 */
export function hitsInteractive(regions: HitRegion[], x: number, y: number): boolean {
  for (const r of regions) {
    if (r.kind === "circle") {
      const dx = x - r.cx;
      const dy = y - r.cy;
      if (dx * dx + dy * dy <= r.r * r.r) return true;
    } else if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
      return true;
    }
  }
  return false;
}

// ── How big the circles are, and how big the window is ────────────────────

/**
 * The three sizes a circle comes in.
 *
 * `speaker` is one face, big enough to read across a desk. `row` is everybody,
 * smaller because a row of them has to stay a strip. `mini` is what the window
 * becomes when somebody drags it down past the row: a face the size of a menu
 * bar icon, which is the smallest thing that is still recognizably a person.
 */
export type FaceTier = "speaker" | "row" | "mini";

export const TIER_DIAMETER: Record<FaceTier, number> = { speaker: 96, row: 64, mini: 40 };

/** The gap between circles in a row. */
export const FACE_GAP = 8;

/**
 * The only margin around the circles.
 *
 * It is not decoration and it is not a reserve for controls: it is the room
 * the speaking ring and its glow need. The ring is 3px outside the circle and
 * the glow blurs a few pixels past that, and a window sized to the circle
 * alone would clip both — on a transparent window a clipped glow is a straight
 * edge in mid-air, which is worse than no glow.
 */
export const FACES_PADDING = 8;

/**
 * The two rows hovering adds under the circles, and what they measure.
 *
 * Kept here rather than only in the stylesheet because they are what the WINDOW
 * has to know: nothing reserves them while the pointer is away, so the window
 * grows to hold them at the moment they appear and shrinks back when it leaves.
 * The chrome is four 28px buttons, their gaps and its own padding; the name is
 * one line of 9.5px mono in a pill.
 */
export const CHROME_BUTTON = 28;
/** The chrome's width for a row of `buttons` of them — the buttons, their 4px
 *  gaps and the pill's own 3px padding. Both floating circle surfaces size
 *  their hover chrome from this, whatever buttons each one carries. */
export function chromeWidth(buttons: number): number {
  return CHROME_BUTTON * buttons + 4 * (buttons - 1) + 3 * 2;
}
export const CHROME_WIDTH = chromeWidth(4);
export const CHROME_HEIGHT = CHROME_BUTTON + 3 * 2;
export const NAME_HEIGHT = 18;
/** Between the circles and the name, and between the name and the chrome. */
export const ROW_GAP = 4;
/** Everything hovering adds below the circles. */
export const HOVER_ROWS = ROW_GAP + NAME_HEIGHT + ROW_GAP + CHROME_HEIGHT;

export type FacesMode = "speaker" | "everyone";

/** The tier a mode sits at when nobody has resized the window. */
export function naturalTier(mode: FacesMode): FaceTier {
  return mode === "everyone" ? "row" : "speaker";
}

/**
 * Which tier a window of this width lands on.
 *
 * This is the whole of the fourth state. The window has three sizes of its own
 * — the panel, the row of circles, one speaker circle — and dragging it below
 * the width its circles want does not clip them and does not stop at the last
 * size: it drops the circles to `mini`. Mode is untouched by the drop, so a
 * squeezed row is a row of small circles and a squeezed speaker is one small
 * circle, which is the thing the smallest window was always meant to be.
 */
export function tierForWidth(width: number, mode: FacesMode, faces: number): FaceTier {
  const tier = naturalTier(mode);
  return width < facesWindowSize(mode, faces, { tier }).width ? "mini" : tier;
}

/**
 * How big the window has to be to hold the circles.
 *
 * The circles' bounds and the 8px the ring needs. Nothing else: no title bar,
 * no name printed under every face, no control row waiting under the circles.
 * Every pixel of this window that is not a circle is a transparent rectangle
 * over somebody's work, so the honest size is the small one, and a window
 * bigger than its contents is a bigger surface for the click-through test to be
 * wrong about.
 *
 * `hovered` is where the name and the controls get their room, and it costs
 * nothing while the pointer is away. It adds the two rows below the circles,
 * and it widens the window where four buttons are wider than the faces — one
 * 96px circle is narrower than the chrome, and a window that clipped its own
 * controls is a call you cannot leave. The circles keep their place at the top
 * of the window through both, so nothing under the pointer moves.
 */
export function facesWindowSize(
  mode: FacesMode,
  faces: number,
  opts?: { tier?: FaceTier; hovered?: boolean },
): { width: number; height: number } {
  const tier = opts?.tier ?? naturalTier(mode);
  const d = TIER_DIAMETER[tier];
  const count = mode === "speaker" ? 1 : Math.max(1, faces);
  const circles = count * d + (count - 1) * FACE_GAP;
  const width = opts?.hovered ? Math.max(circles, CHROME_WIDTH) : circles;
  return {
    width: Math.round(width + FACES_PADDING * 2),
    height: Math.round(d + (opts?.hovered ? HOVER_ROWS : 0) + FACES_PADDING * 2),
  };
}
