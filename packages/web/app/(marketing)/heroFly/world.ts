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

import { rotation } from "./project";

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
  /** Chapter name printed on the back face the deal flips over, as the scrubber names it, so the deck reads as the film's contents. */
  back: string;
  /** The chapter the back names: its dot wears that chapter's scrubber colour. */
  chapter: ChapterId;
  radius: number;
  /** The phone renders the mobile app in its dark theme inside a bezel. */
  frame?: "phone";
  /**
   * Fades out as the camera leaves a hold that sees it and in as it turns
   * toward one, instead of popping at the cull. For a surface that sits
   * close to the camera's path, where it would sweep through the frame.
   */
  fadeInTransit?: boolean;
  /**
   * Seconds a `fadeInTransit` surface takes to fade out as the camera leaves,
   * on `glide` instead of `settle`: for a surface whose tone is far from the
   * backdrop's (the dark phone on cream), where a short fade reads as a pop.
   */
  fadeOut?: number;
  /** Seconds it takes to fade in as the camera turns toward it, on `glide`: for one that rises into frame from below the box, so it is whole before it is opaque. */
  fadeIn?: number;
  regions: Record<string, Region>;
};

const whole = (w: number, h: number): Record<string, Region> => ({ main: { x: 0, y: 0, w, h } });

/** Flight order: the deal flips them up in this order and down in reverse. */
export const SURFACES: Surface[] = [
  {
    id: "desk", w: 1180, h: 720, pos: [0, 0, 0], rot: [0, 0, 0], back: "Inbox", chapter: "inbox", radius: 14,
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
  {
    id: "phone", w: 300, h: 620, pos: [1440, 600, 160], rot: [0, -12, -2], back: "Approve", chapter: "phone", radius: 44, frame: "phone", fadeInTransit: true, fadeOut: 0.6, fadeIn: 0.7,
    regions: whole(276, 572),
  },
  // The workers side by side, one window each, the way two panes sit on a wide screen; no taller than a booting worker's transcript fills.
  {
    id: "pairA", w: 540, h: 340, pos: [1250, -20, -60], rot: [0, -6, 0], back: "Talk", chapter: "talk", radius: 12,
    regions: { header: { x: 0, y: 0, w: 540, h: 44 }, transcript: { x: 0, y: 44, w: 540, h: 296, anchor: "bottom" } },
  },
  {
    id: "pairB", w: 540, h: 340, pos: [1830, 20, -60], rot: [0, -10, 0], back: "Fork", chapter: "talk", radius: 12,
    regions: { header: { x: 0, y: 0, w: 540, h: 44 }, transcript: { x: 0, y: 44, w: 540, h: 296, anchor: "bottom" }, scrim: { x: 0, y: 0, w: 540, h: 340 } },
  },
  { id: "board", w: 1000, h: 520, pos: [80, 900, -20], rot: [24, 0, 0], back: "Track", chapter: "work", radius: 12, regions: whole(1000, 520) },
  { id: "auto", w: 900, h: 450, pos: [1400, 960, -60], rot: [16, -6, 0], back: "Automate", chapter: "automation", radius: 12, regions: whole(900, 450) },
  { id: "team", w: 980, h: 600, pos: [2650, 95, -80], rot: [0, -10, 0], back: "Team", chapter: "team", radius: 14, regions: whole(980, 600) },
  { id: "pr", w: 900, h: 560, pos: [2400, -800, -120], rot: [-8, -8, 0], back: "GitHub", chapter: "integrations", radius: 12, regions: whole(900, 560) },
  { id: "page", w: 900, h: 560, pos: [0, -1000, -260], rot: [-10, 0, 0], back: "Publish", chapter: "publish", radius: 14, regions: whole(900, 560) },
  // The palette is the surface: its window, flush, the size of the dialog with its results.
  { id: "palette", w: 720, h: 330, pos: [-1380, -330, -100], rot: [0, 12, 0], back: "Memory", chapter: "memory", radius: 14, regions: whole(720, 330) },
  { id: "blame", w: 900, h: 380, pos: [-1400, 190, -40], rot: [0, 10, 0], back: "Blame", chapter: "memory", radius: 12, regions: whole(900, 380) },
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
  /** Surfaces this hold is about: each turns face-up before the first hold that names it, and a `fadeInTransit` one is shown only across holds that name it. What is rendered follows what the camera can see (timeline.ts isLive). */
  sees: SurfaceId[] | "all";
  /** Applied to the transit that ARRIVES at this hold: extra pull-back (negative dist) and roll at mid-move. */
  crest?: number;
  crestRoll?: number;
  /** Drift across the hold (px of x, degrees of yaw); overview holds stay still so the seam is exact. */
  drift?: boolean;
  /** The drift's push toward the subject (px over the hold), when a hold must keep an edge in frame; DRIFT_PUSH otherwise. */
  push?: number;
  /** The drift's slide (px of x over the hold), when a hold glides onto what happens in it; DRIFT_X otherwise. */
  slide?: number;
};

const P = (x: number, y: number, z: number, pitch: number, yaw: number, roll: number, dist: number): Pose => ({ x, y, z, pitch, yaw, roll, dist });

export const OVERVIEW = P(540, -20, 0, 34, -6, 0, -6100);

const PAIR = P(1530, 10, -60, 0, 8, -1.5, 150);

/**
 * Each transit takes the time its distance needs (about 0.9s plus 1s per
 * 1600px, between 1.1s and 2.2s; the dives in and out of the overview 1.6s),
 * so no move crosses the frame faster than a couple of widths a second.
 */
export const CAMERA: Hold[] = [
  { t0: 0, t1: 0.9, pose: OVERVIEW, sees: "all" },
  // 1 Inbox: the whole window, slight three-quarter.
  { t0: 2.5, t1: 6.9, pose: P(20, 10, 0, 3, -4, 0, -120), sees: ["desk"], drift: true },
  // 2 Conversation: in on the conversation and the list beside it, the rail just out of frame on the left; the window's top bar and the composer's foot both inside the box for the whole hold (no push), so the steered session's title reads whole and the window rests on the page.
  { t0: 8.0, t1: 13.0, pose: P(200, 2, 0, 2, -5, 0, 10), sees: ["desk"], drift: true, push: 0 },
  // 3 Fan out: the conversation and the list beside it, then the workers boot on the pair, and the frame glides onto the API worker and pushes in on its ask (4).
  { t0: 14.1, t1: 16.5, pose: P(30, 0, 0, 2, -6, 0, -40), sees: ["desk"], drift: true },
  { t0: 18.3, t1: 21.0, pose: { ...PAIR, x: 1455, y: 40, dist: 140 }, sees: ["pairA", "pairB"], crest: -600, drift: true, slide: -150, push: 420 },
  // 4 Approve: the push follows the camera to the phone, then a pull-back to see the phone and the worker it answered.
  { t0: 22.6, t1: 25.9, pose: P(1440, 600, 160, 0, 12, 2, 70), sees: ["phone"], crest: -500, crestRoll: 3, drift: true },
  { t0: 27.0, t1: 29.3, pose: P(1500, 340, 40, 0, 8, 1, -1180), sees: ["phone", "pairA", "pairB"] },
  // 5 Agents talk.
  { t0: 31.0, t1: 35.7, pose: PAIR, sees: ["pairA", "pairB"], drift: true },
  // 6 Decide: the card over the veiled conversation, face-on, the window's header to its composer inside the box, so the title of what is being decided reads whole.
  { t0: 37.5, t1: 42.0, pose: P(100, 2, 0, 2, -4, 0, 10), sees: ["desk"], crest: -900, crestRoll: 2, drift: true, slide: 0, push: 0 },
  // 7 Track: the biggest swoop, down to the board.
  { t0: 43.4, t1: 47.8, pose: P(80, 870, -60, -22, 0, 0, 160), sees: ["board", "desk"], crest: -1100, crestRoll: -3, drift: true },
  // 8 Automate.
  { t0: 49.5, t1: 53.7, pose: P(1400, 965, -60, -14, 6, 0, 360), sees: ["auto"], crest: -500, drift: true },
  // 9 Team.
  { t0: 55.4, t1: 60.8, pose: P(2650, 95, -80, 0, 10, 0, 40), sees: ["team"], crest: -800, crestRoll: 2, drift: true },
  // 10 Integrations.
  { t0: 62.5, t1: 66.9, pose: P(2400, -830, -120, 8, 8, 0, 90), sees: ["pr", "team"], crest: -700, drift: true },
  // 11 Publish: a long pan west along the top of the world.
  { t0: 69.1, t1: 73.9, pose: P(0, -1000, -260, 10, 0, 0, -80), sees: ["page"], crest: -700, crestRoll: -2, drift: true },
  // 12 Memory: past the "3 weeks later" label to the palette, then the blame.
  { t0: 75.8, t1: 78.0, pose: P(-1380, -360, -100, 0, -12, 0, 380), sees: ["palette"], crest: -500, drift: true },
  { t0: 79.3, t1: 81.3, pose: P(-1400, 200, -40, -2, -10, 0, 320), sees: ["blame", "palette"], drift: true },
  // 13 Anywhere: back on the whole desk, the rail in frame, as the cloud worker's row is opened; then the whole world for the seam.
  { t0: 83.0, t1: 86.0, pose: P(10, 8, 0, 2, -5, 0, -70), sees: ["desk"], crest: -600, drift: true },
  { t0: 87.4, t1: DURATION, pose: OVERVIEW, sees: "all" },
];

/**
 * Phones get the same flight framed tighter on each chapter's hero element:
 * where a surface is wider than the phone's frame, on its leading (left) edge,
 * where titles and ids start. Index-aligned with CAMERA.
 */
export const CAMERA_MOBILE: Partial<Pose>[] = [
  { pitch: 40, dist: -12500 },
  { x: 360, y: 0, yaw: -2, dist: 70 },
  { x: -100, y: 0, dist: 70 },
  { x: 230, y: 0, dist: 70 },
  { x: 1300, y: -10, yaw: 4, dist: 230 },
  { y: 620, dist: -40 },
  { x: 1400, y: 380, dist: -1350 },
  { x: 1240, y: -10, yaw: 4, dist: 230 },
  { x: 20, y: 0, dist: 120 },
  { x: -140, y: 850, dist: 225 },
  { x: 1240, dist: 240 },
  { x: 2440, dist: 240 },
  { x: 2230, dist: 240 },
  { x: -120, pitch: 6, dist: 240 },
  { x: -1475, y: -330, yaw: -6, dist: 250 },
  { x: -1560, y: 210, yaw: -5, dist: 220 },
  { x: -80, y: 0, dist: 70 },
  { pitch: 40, dist: -12500 },
];

/* ── The deal ─────────────────────────────────────────────────────────── */

/** Surfaces the opening deals face-up; every other one waits face-down in the overview until its chapter. */
export const DEALT: SurfaceId[] = ["desk", "board"];
/** A chapter surface's turn, in seconds. */
export const FLIP_DUR = 0.9;
/** A turned surface has landed at least this long before the camera arrives on it. */
const FLIP_CLEAR = 0.5;

/**
 * The film second each chapter surface starts to turn face-up: as the camera
 * leaves the hold before its first visit (a beat early, while that hold is
 * still on screen), and early enough to land FLIP_CLEAR before the camera
 * does, so a chapter opens on its product rather than on a card's back.
 */
export const TURN_AT: Partial<Record<SurfaceId, number>> = Object.fromEntries(
  SURFACES.filter((s) => !DEALT.includes(s.id)).flatMap((s) => {
    const k = CAMERA.findIndex((h) => h.sees !== "all" && h.sees.includes(s.id));
    if (k < 1) return [];
    return [[s.id, Math.round(Math.min(CAMERA[k - 1].t1 - 0.1, CAMERA[k].t0 - FLIP_DUR - FLIP_CLEAR) * 100) / 100]];
  }),
);

/** When a chapter surface's resting state must be in place: assembled face-down, just before it turns. */
export const readyAt = (id: SurfaceId): number => (TURN_AT[id] ?? 0) - 0.4;

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
  { id: "inbox", name: "Inbox", start: 0, end: 7.4, hold: 2.5, caption: "Every agent session, live. Claude Code, Codex, Cursor, Gemini, OpenCode and pi in one inbox." },
  { id: "conversation", name: "Steer", start: 7.4, end: 13.5, hold: 8.0, caption: "Open any session to watch it work, and steer it mid-run." },
  { id: "fanout", name: "Fan out", start: 13.5, end: 19.8, hold: 14.1, caption: "One lead spawns workers, and every session lands in the same inbox." },
  { id: "phone", name: "Approve", start: 19.8, end: 29.7, hold: 22.6, caption: "A worker needs permission. Approve it from your desk or your phone." },
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
export const LABEL_3W = { pos: [-1380, -615, 0] as V3, cue: 74.9, end: 76.3 };

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
