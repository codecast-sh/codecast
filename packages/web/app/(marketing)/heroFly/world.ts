/**
 * The hero fly-through's world as data: where every surface sits, the regions
 * each surface is divided into, where the camera holds, and when each chapter
 * starts. Chapter content (beats, typed text, flyers) lives with each chapter
 * in `chapters/<id>.motion.ts` and is gathered by `motion.ts`; `timeline.ts`
 * turns both into a frame for any t. Nothing here runs or measures anything.
 *
 * World axes: x right, y down, z toward the viewer. A surface's `pos` is its
 * centre; local coordinates in the anchor helpers are px from that centre.
 */

import { projector, rotation, STAGE_SIZE } from "./project";

export type V3 = [number, number, number];

export const DURATION = 88.8;
export const POSTER_T = 6.6;

/* ── Chapters ─────────────────────────────────────────────────────────── */

export type ChapterId =
  | "inbox"
  | "conversation"
  | "fanout"
  | "phone"
  | "talk"
  | "decide"
  | "work"
  | "automation"
  | "team"
  | "integrations"
  | "publish"
  | "memory"
  | "remote";

/* ── Surfaces and their regions ───────────────────────────────────────── */

export type SurfaceId = "desk" | "phone" | "pairA" | "pairB" | "board" | "auto" | "team" | "pr" | "page" | "palette" | "blame";

/**
 * A named rectangle of a surface, in px from the surface's top-left. Chapter
 * parts render into regions (see chapters/README.md); a region stacks its
 * parts in `order` from the top, or from the bottom when `anchor` is
 * "bottom" (a transcript whose newest entry sits on the composer).
 */
export type Region = { x: number; y: number; w: number; h: number; anchor?: "top" | "bottom" };

export type Surface = {
  id: SurfaceId;
  w: number;
  h: number;
  pos: V3;
  /** Degrees, applied as CSS rotateX, rotateY, rotateZ in that order. */
  rot: V3;
  radius: number;
  /** The phone renders the mobile app in its dark theme inside a bezel. */
  frame?: "phone";
  /**
   * Seconds it takes to dissolve out at the end of a move that leaves it, and
   * in at the start of one toward it, instead of the default: for a surface
   * whose tone is far from the page's (the dark phone on cream), where a short
   * fade reads as a pop.
   */
  fadeOut?: number;
  fadeIn?: number;
  regions: Record<string, Region>;
};

const whole = (w: number, h: number): Record<string, Region> => ({ main: { x: 0, y: 0, w, h } });

/**
 * The world is one horizontal band, so every move is a pan: the window the
 * camera leaves slides off the side of the page as the next one slides in,
 * and nothing has to leave across the top or bottom. Two windows that share a
 * move sit a short gap apart (about 220px), so the page is never empty while
 * the camera crosses between them. A hold shows only the windows it is about
 * (CAMERA[].sees), so windows that are never on screen together share
 * stretches of the band: out east to the workers and the phone, back to the
 * desk, west to the board, the trigger and the team, and back east past the
 * pull request, the page and the palette, the blame doubling back one window
 * west so the last move lands on the desk.
 */
export const SURFACES: Surface[] = [
  {
    id: "desk", w: 1180, h: 720, pos: [0, 0, 0], rot: [0, 0, 0], radius: 14,
    // The app's shell: the nav rail on the left, the page (the open conversation) in the middle, and the session list as the one right rail (DashboardLayout).
    regions: {
      topbar: { x: 0, y: 0, w: 1180, h: 40 },
      sidebar: { x: 0, y: 40, w: 200, h: 680 },
      header: { x: 200, y: 40, w: 640, h: 48 },
      transcript: { x: 200, y: 88, w: 640, h: 512, anchor: "bottom" },
      composer: { x: 200, y: 600, w: 640, h: 120 },
      list: { x: 840, y: 40, w: 340, h: 680 },
      // A wash over the conversation, under the card beside it, so the card never reads on top of half-covered text.
      scrim: { x: 200, y: 88, w: 640, h: 632 },
      // A card over the conversation's right half, clear of the list.
      side: { x: 420, y: 104, w: 380, h: 500 },
    },
  },
  // The workers side by side, one window each, the way two panes sit on a wide screen; no taller than a booting worker's transcript fills.
  {
    id: "pairA", w: 540, h: 340, pos: [1100, -20, -60], rot: [0, -6, 0], radius: 12,
    regions: { header: { x: 0, y: 0, w: 540, h: 44 }, transcript: { x: 0, y: 44, w: 540, h: 296, anchor: "bottom" } },
  },
  {
    id: "pairB", w: 540, h: 340, pos: [1680, 20, -60], rot: [0, -10, 0], radius: 12,
    regions: { header: { x: 0, y: 0, w: 540, h: 44 }, transcript: { x: 0, y: 44, w: 540, h: 296, anchor: "bottom" }, scrim: { x: 0, y: 0, w: 540, h: 340 } },
  },
  // Held up in front of the second worker, the way a phone sits beside a laptop.
  {
    id: "phone", w: 300, h: 620, pos: [1860, 70, 200], rot: [0, -12, -2], radius: 44, frame: "phone", fadeOut: 0.6, fadeIn: 0.7,
    // The whole screen, the status bar's band beside the notch included: the app's header runs under it, as on iOS.
    regions: { main: { x: 0, y: -24, w: 276, h: 596 } },
  },
  { id: "board", w: 1000, h: 520, pos: [-1310, 20, -20], rot: [8, 0, 0], radius: 12, regions: whole(1000, 520) },
  { id: "auto", w: 900, h: 450, pos: [-2480, 30, -60], rot: [8, -6, 0], radius: 12, regions: whole(900, 450) },
  { id: "team", w: 980, h: 600, pos: [-3640, 40, -80], rot: [0, -10, 0], radius: 14, regions: whole(980, 600) },
  { id: "pr", w: 900, h: 560, pos: [-2480, -20, -120], rot: [-4, -8, 0], radius: 12, regions: whole(900, 560) },
  { id: "page", w: 900, h: 560, pos: [-1360, 0, -260], rot: [-4, 0, 0], radius: 14, regions: whole(900, 560) },
  // The palette is the surface: its window, flush, the size of the dialog with its results.
  { id: "palette", w: 720, h: 330, pos: [-330, 0, -100], rot: [0, 12, 0], radius: 14, regions: whole(720, 330) },
  { id: "blame", w: 900, h: 380, pos: [-1360, 10, -40], rot: [0, 10, 0], radius: 12, regions: whole(900, 380) },
];

export const SURFACE_BY_ID = Object.fromEntries(SURFACES.map((s) => [s.id, s])) as Record<SurfaceId, Surface>;

/** `desk.list`, `pairA.transcript`, `board.main`: a region, addressed by its surface. */
export type RegionKey = `${SurfaceId}.${string}`;

export function regionOf(key: RegionKey): { surface: Surface; name: string; region: Region } {
  const [sid, name] = key.split(".") as [SurfaceId, string];
  const surface = SURFACE_BY_ID[sid];
  const region = surface?.regions[name];
  if (!region) throw new Error(`hero: no region ${key}`);
  return { surface, name, region };
}

/** A point given in a surface's local px (from its centre) in world coordinates, applying the surface's rotation the way CSS does. */
const TURN = Object.fromEntries(SURFACES.map((s) => [s.id, rotation(s.rot)])) as Record<SurfaceId, (pt: V3) => V3>;

export function localToWorld(id: SurfaceId, lx: number, ly: number, lz = 0): V3 {
  const s = SURFACE_BY_ID[id];
  const [x, y, z] = TURN[id]([lx, ly, lz]);
  return [s.pos[0] + x, s.pos[1] + y, s.pos[2] + z];
}

/** A point given in px from a surface's top-left corner (how regions are measured) in world coordinates. */
export const surfacePt = (id: SurfaceId, x: number, y: number, z = 0): V3 => {
  const s = SURFACE_BY_ID[id];
  return localToWorld(id, x - s.w / 2, y - s.h / 2, z);
};

/** A point given in px from a region's top-left corner in world coordinates. */
export const regionPt = (key: RegionKey, x: number, y: number, z = 0): V3 => {
  const { surface, region } = regionOf(key);
  return surfacePt(surface.id, region.x + x, region.y + y, z);
};

/* ── Camera ───────────────────────────────────────────────────────────── */

export type Pose = { x: number; y: number; z: number; pitch: number; yaw: number; roll: number; dist: number };
export type Hold = {
  t0: number;
  t1: number;
  pose: Pose;
  /**
   * The windows this hold is about, the only ones it shows. A move shows the
   * windows of the holds at both ends: the next ones dissolve in as it sets
   * off and the last ones out as it lands, so the page is never empty between
   * them (timeline.ts transitOpacity).
   */
  sees: SurfaceId[];
  /** Applied to the transit that ARRIVES at this hold: extra pull-back (negative dist) and roll at mid-move. */
  crest?: number;
  crestRoll?: number;
  /** Drift across the hold: a slow slide and turn, and a push toward the subject (DRIFT). */
  drift?: boolean;
};

/** A hold breathes: a slide (px of x) and turn (degrees of yaw) symmetric about its middle, and a push toward the subject (px of dist) over its length. */
export const DRIFT = { x: 24, yaw: 1, push: 30 };

const P = (x: number, y: number, z: number, pitch: number, yaw: number, roll: number, dist: number): Pose => ({ x, y, z, pitch, yaw, roll, dist });

/**
 * The camera's holds as authored: where it looks from (its angles) and roughly
 * where. `frameHolds` then works out each hold's exact position and distance
 * from the projection, so what it is about sits centred in the film box with
 * the same margins in every shot.
 */
const HOLDS: Hold[] = [
  // 1 Inbox: the whole window, slight three-quarter. The film opens here, composed (it is the poster), and the last move returns here for the seam.
  { t0: 0, t1: 6.9, pose: P(0, 0, 0, 3, -4, 0, 0), sees: ["desk"], drift: true },
  // 2 Conversation: square on the window as the session is steered.
  { t0: 8.0, t1: 13.0, pose: P(0, 0, 0, 2, -1.5, 0, 0), sees: ["desk"], drift: true },
  // 3 Fan out: the lead's window, then the two workers it spawned, side by side.
  { t0: 14.1, t1: 16.5, pose: P(0, 0, 0, 2, 2, 0, 0), sees: ["desk"], drift: true },
  { t0: 18.3, t1: 21.0, pose: P(1390, 0, -60, 0, 8, -1, 0), sees: ["pairA", "pairB"], crest: -300, drift: true },
  // 4 The phone, then a pull-back to see it beside the workers it steers.
  { t0: 22.6, t1: 25.9, pose: P(1860, 70, 200, 0, 12, 2, 0), sees: ["phone"], crest: -300, crestRoll: 2, drift: true },
  { t0: 27.0, t1: 29.3, pose: P(1490, 30, 40, 0, 7, 1, 0), sees: ["phone", "pairA", "pairB"] },
  // 5 Agents talk.
  { t0: 31.0, t1: 35.7, pose: P(1390, 10, -60, 0, 8, -1.5, 0), sees: ["pairA", "pairB"], drift: true },
  // 6 Decide: the card over the veiled conversation, face-on.
  { t0: 37.5, t1: 42.0, pose: P(0, 0, 0, 2, -3, 0, 0), sees: ["desk"], crest: -400, crestRoll: 1.5, drift: true },
  // 7 Track: west along the band to the board.
  { t0: 43.4, t1: 47.8, pose: P(-1310, 5, -60, -7, 0, 0, 0), sees: ["board"], crest: -400, crestRoll: -2, drift: true },
  // 8 Automate.
  { t0: 49.5, t1: 53.7, pose: P(-2480, 35, -60, -7, 6, 0, 0), sees: ["auto"], crest: -400, drift: true },
  // 9 Team.
  { t0: 55.4, t1: 60.8, pose: P(-3640, 40, -80, 0, 10, 0, 0), sees: ["team"], crest: -400, crestRoll: 1.5, drift: true },
  // 10 Integrations: the band turns back east.
  { t0: 62.5, t1: 66.9, pose: P(-2480, -40, -120, 4, 8, 0, 0), sees: ["pr"], crest: -400, drift: true },
  // 11 Publish.
  { t0: 69.1, t1: 73.9, pose: P(-1360, 0, -260, 4, 0, 0, 0), sees: ["page"], crest: -400, crestRoll: -1.5, drift: true },
  // 12 Memory: past the "3 weeks later" label to the palette, then the blame.
  { t0: 75.8, t1: 78.0, pose: P(-330, -30, -100, 0, -12, 0, 0), sees: ["palette"], crest: -300, drift: true },
  { t0: 79.3, t1: 81.3, pose: P(-1360, 20, -40, -2, -10, 0, 0), sees: ["blame"], crest: -300, drift: true },
  // 13 Anywhere: back on the whole desk as the cloud worker's row is opened; then the move home to the opening frame for the seam (timeline.ts SEAM).
  { t0: 83.0, t1: DURATION - 2.2, pose: P(0, 0, 0, 2, -2, 0, 0), sees: ["desk"], crest: -300, drift: true },
];

/**
 * Phones frame each hold tighter on its chapter's hero element. Where a hold's
 * windows are wider than the phone's frame, `align` says which part fills it:
 * 0 its leading (left) edge at the margin, where titles and ids start, 1 its
 * trailing edge, between them a share of the overflow. Where they fit, they
 * are centred; vertically they are always centred. Index-aligned with HOLDS,
 * with the angles and distance that replace each hold's own.
 */
type MobileFraming = { align?: number; pitch?: number; yaw?: number; dist?: number };
const MOBILE: MobileFraming[] = [
  { align: 0.85, yaw: -2, dist: 90 },
  { align: 0.25, dist: 90 },
  { align: 0.95, dist: 90 },
  { align: 0, yaw: 4, dist: 230 },
  { dist: -40 },
  { dist: -1700 },
  { align: 0, yaw: 4, dist: 230 },
  { align: 0.5, dist: 120 },
  { align: 0, dist: 225 },
  { align: 0, dist: 240 },
  { align: 0, dist: 240 },
  { align: 0, dist: 240 },
  { align: 0, pitch: 6, dist: 240 },
  { align: 0, yaw: -6, dist: 250 },
  { align: 0, yaw: -5, dist: 220 },
  { align: 0.3, dist: 90 },
];

/* ── Framing: every hold centred by construction ──────────────────────── */

/** The film box's inner margin each hold's subject keeps from its edges (stage px), and the largest a subject is shown. */
export const FRAME_MARGIN = { desktop: { x: 80, y: 36 }, mobile: { x: 24, y: 56 } } as const;
const MAX_SCALE = 1.12;

const PERSP = 1800;

const cornersOf = (id: SurfaceId): V3[] => {
  const s = SURFACE_BY_ID[id];
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([lx, ly]) => localToWorld(id, (lx * s.w) / 2, (ly * s.h) / 2));
};

/** The stage-px box around a hold's windows under a pose (null when part is behind the eye). */
export function subjectBox(ids: SurfaceId[], pose: Pose, mobile = false): { x0: number; x1: number; y0: number; y1: number } | null {
  const at = projector(pose, mobile);
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const id of ids) {
    for (const c of cornersOf(id)) {
      const p = at(c);
      if (!p) return null;
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
  }
  return { x0, x1, y0, y1 };
}

/**
 * The pose that frames `ids` from the given angles: their box centred in the
 * film box (vertically always, horizontally when `centreX`), sized to the
 * margins (`size`: "fit" grows or shrinks to them, capped at MAX_SCALE;
 * "shrink" only pulls back when they would not fit the height, for a phone,
 * which frames a part of a wide window), measured where the
 * hold's push ends, so the subject never outgrows its margins.
 */
function framed(ids: SurfaceId[], start: Pose, mobile: boolean, push: number, size: "fit" | "shrink", align = 0.5): Pose {
  const { w, h } = mobile ? STAGE_SIZE.mobile : STAGE_SIZE.desktop;
  const m = FRAME_MARGIN[mobile ? "mobile" : "desktop"];
  const centre = (ids.map((id) => SURFACE_BY_ID[id].pos).reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0] as number[])).map((v) => v / ids.length);
  let pose: Pose = { ...start, z: centre[2], dist: start.dist + push };
  const box = (p: Pose) => subjectBox(ids, p, mobile)!;
  for (let round = 0; round < 24; round++) {
    let b = box(pose);
    // Distance: scale the box to the margins about its own centre's depth.
    const k = projector(pose, mobile)(centre as V3)!.scale;
    const fitH = (h - 2 * m.y) / (b.y1 - b.y0);
    const r = size === "shrink" ? Math.min(1, fitH) : Math.min((w - 2 * m.x) / (b.x1 - b.x0), fitH, MAX_SCALE / k);
    pose = { ...pose, dist: pose.dist + PERSP / k - PERSP / (k * r) };
    // Position: a Newton step on x and y from the box's centre.
    b = box(pose);
    const over = b.x1 - b.x0 - (w - 2 * m.x);
    const ex = over > 0 ? b.x0 + align * over - m.x : (b.x0 + b.x1) / 2 - w / 2;
    const ey = (b.y0 + b.y1) / 2 - h / 2;
    const bx = box({ ...pose, x: pose.x + 1 });
    const by = box({ ...pose, y: pose.y + 1 });
    const dxdx = (bx.x0 + bx.x1 - b.x0 - b.x1) / 2;
    const dydy = (by.y0 + by.y1 - b.y0 - b.y1) / 2;
    pose = { ...pose, x: pose.x - ex / dxdx, y: pose.y - ey / dydy };
  }
  return { ...pose, dist: pose.dist - push };
}

const pushOf = (h: Hold) => (h.drift ? DRIFT.push : 0);

/**
 * Each transit takes the time its distance needs, so no move crosses the
 * frame faster than a couple of widths a second. The last entry is the
 * opening hold again at the film's end: the loop's seam is the move home.
 */
export const CAMERA: Hold[] = [...HOLDS, { ...HOLDS[0], t0: DURATION, t1: DURATION }].map((h, i, all) => {
  const src = i === all.length - 1 ? HOLDS[0] : h;
  return { ...h, pose: framed(src.sees, src.pose, false, pushOf(src), "fit") };
});

export const CAMERA_MOBILE: Partial<Pose>[] = CAMERA.map((h, i) => {
  const src = HOLDS[i % HOLDS.length];
  const { align, ...rest } = MOBILE[i % HOLDS.length];
  const pose = framed(src.sees, { ...src.pose, dist: 0, ...rest }, true, pushOf(src), "shrink", align);
  return { x: pose.x, y: pose.y, z: pose.z, pitch: pose.pitch, yaw: pose.yaw, dist: pose.dist };
});

/* ── When each chapter surface is first shown ─────────────────────────── */

/**
 * The film second by which each chapter surface is assembled: a beat before
 * the camera sets off toward the first hold that sees it, which is when it
 * starts to dissolve in, so a chapter opens on its product.
 */
export const SHOW_AT: Partial<Record<SurfaceId, number>> = Object.fromEntries(
  SURFACES.flatMap((s) => {
    const k = CAMERA.findIndex((h) => h.sees.includes(s.id));
    if (k < 1) return [];
    return [[s.id, Math.round(Math.min(CAMERA[k - 1].t1 - 0.1, CAMERA[k].t0 - 1.4) * 100) / 100]];
  }),
);

/** When a chapter surface's resting state must be in place: before it is first shown. */
export const readyAt = (id: SurfaceId): number => (SHOW_AT[id] ?? 0) - 0.4;

/* ── Scenes: one per chapter, one tick each ───────────────────────────── */

export type Scene = {
  id: ChapterId;
  name: string;
  start: number;
  end: number;
  hold: number;
  caption: string;
  /** Reduced motion: the frame that stands for the chapter, when the end of its last hold does not (its story has moved on by then). */
  still?: number;
};

export const SCENES: Scene[] = [
  { id: "inbox", name: "Inbox", start: 0, end: 7.4, hold: 0, caption: "Every agent session, live. Claude Code, Codex, Cursor, Gemini, OpenCode and pi in one inbox." },
  { id: "conversation", name: "Steer", start: 7.4, end: 13.5, hold: 8.0, caption: "Open any session to watch it work, and steer it mid-run." },
  { id: "fanout", name: "Fan out", start: 13.5, end: 19.8, hold: 14.1, caption: "One lead spawns workers, and every session lands in the same inbox." },
  { id: "phone", name: "Phone", start: 19.8, end: 29.7, hold: 22.6, caption: "A worker has a question. Answer it from the app on your phone, and it carries on." },
  { id: "talk", name: "Talk", start: 29.7, end: 36.6, hold: 31.0, caption: "Sessions message each other, and fork to try another way." },
  { id: "decide", name: "Decide", start: 36.6, end: 41.3, hold: 37.5, still: 40.7, caption: "Agents queue the calls only you can make, with every option priced out." },
  { id: "work", name: "Track", start: 41.3, end: 48.6, hold: 43.4, caption: "Tasks come straight out of the conversation, and agents claim them." },
  { id: "automation", name: "Automate", start: 48.6, end: 54.5, hold: 49.5, caption: "Triggers and workflows keep the work moving while you are away." },
  { id: "team", name: "Team", start: 54.5, end: 61.6, hold: 55.4, caption: "Your team sees the same sessions, talks in the same channels, and huddles live." },
  { id: "integrations", name: "GitHub", start: 61.6, end: 68.0, hold: 62.5, caption: "Pull requests know the sessions behind them, from checks to merge." },
  { id: "publish", name: "Publish", start: 68.0, end: 74.8, hold: 69.1, caption: "Publish a result as a page your team can comment on." },
  { id: "memory", name: "Memory", start: 74.8, end: 82.3, hold: 75.8, caption: "Weeks later, anyone can find why a line of code exists." },
  { id: "remote", name: "Anywhere", start: 82.3, end: DURATION, hold: 83.0, caption: "Sessions run on your laptop or a cloud host, all in one inbox." },
];

/** Reduced motion: each chapter's settled frame, the end of its last hold unless the scene names one. */
export const STILLS: number[] = SCENES.map((s) => {
  if (s.still !== undefined) return s.still;
  const last = CAMERA.filter((h) => h.t0 >= s.start && h.t0 < s.end).pop();
  return last ? Math.min(last.t1, s.end) - 0.1 : s.hold;
});

/** The "3 weeks later" caption over the palette: it settles into frame with the camera and fades as the palette opens. */
export const LABEL_3W = { pos: [-330, -285, 0] as V3, cue: 74.9, end: 76.3 };

/* ── Motion vocabulary (chapters/<id>.motion.ts use these) ─────────────── */

export type Preset =
  | "drop" // house entrance: falls in from in front of the surface on DROP
  | "fadeIn"
  | "fadeOut"
  | "push" // slides from (x, y) to rest on `settle`
  | "lift" // slides from (x, y) to rest on `glide`: a feed making room, which starts as gently as the entry it makes room for fades in
  | "pulse" // scale 1 -> 1 + s -> 1
  | "popIn" // scale from s to 1 on SNAP, fades in fast
  | "ring" // expanding ring that fades out
  | "growX" // scaleX 0 -> 1 on settle
  | "growY" // scaleY 0 -> 1 on SNAP
  | "flipOut" // rotateY 0 -> 180 (front face of a flip)
  | "flipIn" // rotateY -180 -> 0 (back face of a flip)
  | "press" // button press 1 -> 0.94 -> 1
  | "liftOut"; // rises toward the viewer by (y, z) on settle, for a layer handing over to the one under it

export type Beat = {
  id: string;
  cue: number;
  dur?: number;
  preset: Preset;
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  s?: number;
};

export type TextBeat =
  | { id: string; kind: "chars" | "words"; text: string; cue: number; rate: number }
  | { id: string; kind: "keys"; keys: [number, string][] };

/** A world-level card that carries a cause on one surface to its effect on another. */
export type Flyer = {
  id: string;
  cue: number;
  dur: number;
  from: V3;
  to: V3;
  /** Extra lift of the Bezier control point above the straight line (toward the viewer). */
  arc: number;
  /** Rotation at the start, the middle and the end (deg, [rx, ry, rz]). */
  rot: [V3, V3, V3];
  scale?: [number, number];
  /** Extra scale at mid-flight (rises and falls with the arc), so a card visibly lifts off the surface it crosses. */
  swell?: number;
  ease: "glide" | "settle" | "fall";
  /** Fade in over the first, and out over the last, fraction of the flight. */
  fade: [number, number];
};

/** A path drawn in world space with stroke-dashoffset (the one non-transform animation); a dot marks its end once it arrives. */
export type ArcPath = {
  id: string;
  cue: number;
  dur: number;
  hold: number;
  from: V3;
  to: V3;
  color: string;
  /** How far the curve's control point rises above the higher end (px); 170 when unset. */
  apex?: number;
};
