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
  /** The other chapters a surface hosts, in a smaller line under its name. */
  backAlso?: string;
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
  regions: Record<string, Region>;
};

const whole = (w: number, h: number): Record<string, Region> => ({ main: { x: 0, y: 0, w, h } });

/** Flight order: the deal flips them up in this order and down in reverse. */
export const SURFACES: Surface[] = [
  {
    id: "desk", w: 1180, h: 720, pos: [0, 0, 0], rot: [0, 0, 0], back: "Inbox", backAlso: "Steer · Fan out · Decide · Anywhere", chapter: "inbox", radius: 14,
    // The app's shell: the nav rail on the left, the page (the open conversation) in the middle, and the session list as the one right rail (DashboardLayout).
    regions: {
      topbar: { x: 0, y: 0, w: 1180, h: 40 },
      sidebar: { x: 0, y: 40, w: 200, h: 680 },
      header: { x: 200, y: 40, w: 640, h: 48 },
      transcript: { x: 200, y: 88, w: 640, h: 512, anchor: "bottom" },
      composer: { x: 200, y: 600, w: 640, h: 120 },
      list: { x: 840, y: 40, w: 340, h: 680 },
      // A card over the conversation's right half, clear of the list.
      side: { x: 420, y: 104, w: 380, h: 500 },
    },
  },
  {
    id: "phone", w: 300, h: 620, pos: [1440, 600, 160], rot: [0, -12, -2], back: "Approve", chapter: "phone", radius: 44, frame: "phone", fadeInTransit: true,
    regions: whole(276, 572),
  },
  // The workers side by side, one window each, the way two panes sit on a wide screen.
  {
    id: "pairA", w: 540, h: 400, pos: [1250, -20, -60], rot: [0, -6, 0], back: "Talk", chapter: "talk", radius: 12,
    regions: { header: { x: 0, y: 0, w: 540, h: 44 }, transcript: { x: 0, y: 44, w: 540, h: 356, anchor: "bottom" } },
  },
  {
    id: "pairB", w: 540, h: 400, pos: [1830, 20, -60], rot: [0, -10, 0], back: "Fork", chapter: "talk", radius: 12,
    regions: { header: { x: 0, y: 0, w: 540, h: 44 }, transcript: { x: 0, y: 44, w: 540, h: 356, anchor: "bottom" }, scrim: { x: 0, y: 0, w: 540, h: 400 } },
  },
  { id: "board", w: 1000, h: 520, pos: [80, 900, -20], rot: [24, 0, 0], back: "Track", chapter: "work", radius: 12, regions: whole(1000, 520) },
  { id: "auto", w: 900, h: 600, pos: [1400, 1000, -60], rot: [16, -6, 0], back: "Automate", chapter: "automation", radius: 12, regions: whole(900, 600) },
  { id: "team", w: 980, h: 600, pos: [2500, 360, -80], rot: [0, -10, 0], back: "Team", chapter: "team", radius: 14, regions: whole(980, 600) },
  { id: "pr", w: 900, h: 560, pos: [2400, -800, -120], rot: [-8, -8, 0], back: "GitHub", chapter: "integrations", radius: 12, regions: whole(900, 560) },
  { id: "page", w: 900, h: 560, pos: [0, -1000, -260], rot: [-10, 0, 0], back: "Publish", chapter: "publish", radius: 14, regions: whole(900, 560) },
  { id: "palette", w: 720, h: 400, pos: [-1380, -240, -100], rot: [0, 12, 0], back: "Memory", chapter: "memory", radius: 14, regions: whole(720, 400) },
  { id: "blame", w: 900, h: 380, pos: [-1400, 380, -40], rot: [0, 10, 0], back: "Blame", chapter: "memory", radius: 12, regions: whole(900, 380) },
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

const rad = (d: number) => (d * Math.PI) / 180;

/** A point given in a surface's local px (from its centre) in world coordinates, applying the surface's rotation the way CSS does. */
export function localToWorld(id: SurfaceId, lx: number, ly: number, lz = 0): V3 {
  const s = SURFACE_BY_ID[id];
  let [x, y, z] = [lx, ly, lz];
  // CSS applies the rightmost transform first: rotateZ, then rotateY, then rotateX.
  const [ax, ay, az] = s.rot.map(rad);
  [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
  [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
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
  /** Surfaces in frame during this hold and the transits either side of it; everything else is culled. */
  sees: SurfaceId[] | "all";
  /** Applied to the transit that ARRIVES at this hold: extra pull-back (negative dist) and roll at mid-move. */
  crest?: number;
  crestRoll?: number;
  /** Drift across the hold (px of x, degrees of yaw); overview holds stay still so the seam is exact. */
  drift?: boolean;
  /** The drift's push toward the subject (px over the hold), when a hold must keep an edge in frame; DRIFT_PUSH otherwise. */
  push?: number;
};

const P = (x: number, y: number, z: number, pitch: number, yaw: number, roll: number, dist: number): Pose => ({ x, y, z, pitch, yaw, roll, dist });

export const OVERVIEW = P(520, -20, 0, 34, -6, 0, -5600);

const PAIR = P(1530, 0, -60, 0, 8, -1.5, 80);

/**
 * Each transit takes the time its distance needs (about 0.9s plus 1s per
 * 1600px, between 1.1s and 2.2s; the dives in and out of the overview 1.6s),
 * so no move crosses the frame faster than a couple of widths a second.
 */
export const CAMERA: Hold[] = [
  { t0: 0, t1: 0.9, pose: OVERVIEW, sees: "all" },
  // 1 Inbox: the whole window, slight three-quarter.
  { t0: 2.5, t1: 6.9, pose: P(20, 10, 0, 3, -4, 0, -120), sees: ["desk"], drift: true },
  // 2 Conversation: in on the conversation pane, the composer clear of the frame's foot for the whole hold (no push).
  { t0: 8.0, t1: 13.0, pose: P(-30, 38, 0, 2, -5, 0, 100), sees: ["desk"], drift: true, push: 0 },
  // 3 Fan out: the conversation and the list beside it, then the workers boot on the pair.
  { t0: 14.1, t1: 16.5, pose: P(30, 0, 0, 2, -6, 0, 0), sees: ["desk"], drift: true },
  { t0: 18.3, t1: 20.3, pose: PAIR, sees: ["pairA", "pairB"], crest: -600, drift: true },
  // 4 Approve: the ask in the API worker's own pane, the phone, then pull back to see both.
  { t0: 21.4, t1: 23.0, pose: P(1250, 10, -60, 0, 6, 0, 380), sees: ["pairA", "pairB"], drift: true },
  { t0: 24.3, t1: 26.5, pose: P(1440, 600, 160, 0, 12, 2, 70), sees: ["phone", "pairA"], crest: -500, crestRoll: 3, drift: true },
  { t0: 28.0, t1: 29.5, pose: P(1520, 300, 40, 0, 8, 1, -1250), sees: ["phone", "pairA", "pairB"] },
  // 5 Agents talk.
  { t0: 31.0, t1: 35.7, pose: PAIR, sees: ["pairA", "pairB"], drift: true },
  // 6 Decide: the card over the conversation, near and face-on.
  { t0: 37.5, t1: 41.5, pose: P(20, -20, 0, 2, -4, 0, 420), sees: ["desk"], crest: -900, crestRoll: 2, drift: true },
  // 7 Track: the biggest swoop, down to the board.
  { t0: 43.0, t1: 47.8, pose: P(80, 870, -60, -22, 0, 0, 160), sees: ["board", "desk"], crest: -1100, crestRoll: -3, drift: true },
  // 8 Automate.
  { t0: 49.5, t1: 53.7, pose: P(1400, 1010, -60, -14, 6, 0, 170), sees: ["auto", "board"], crest: -500, drift: true },
  // 9 Team.
  { t0: 55.4, t1: 60.8, pose: P(2500, 360, -80, 0, 10, 0, 40), sees: ["team"], crest: -800, crestRoll: 2, drift: true },
  // 10 Integrations.
  { t0: 62.5, t1: 66.9, pose: P(2400, -830, -120, 8, 8, 0, 90), sees: ["pr", "team"], crest: -700, drift: true },
  // 11 Publish: a long pan west along the top of the world.
  { t0: 69.1, t1: 73.9, pose: P(0, -1000, -260, 10, 0, 0, -80), sees: ["page"], crest: -700, crestRoll: -2, drift: true },
  // 12 Memory: past the "3 weeks later" label to the palette, then the blame.
  { t0: 75.8, t1: 78.0, pose: P(-1380, -270, -100, 0, -12, 0, 380), sees: ["palette"], crest: -500, drift: true },
  { t0: 79.3, t1: 81.3, pose: P(-1400, 390, -40, -2, -10, 0, 320), sees: ["blame", "palette"], drift: true },
  // 13 Anywhere: back on the whole desk, the rail in frame, as the cloud worker's row is opened; then the whole world for the seam.
  { t0: 83.0, t1: 86.0, pose: P(10, 10, 0, 2, -5, 0, 0), sees: ["desk"], crest: -600, drift: true },
  { t0: 87.4, t1: DURATION, pose: OVERVIEW, sees: "all" },
];

/**
 * Phones get the same flight framed tighter on each chapter's hero element:
 * where a surface is wider than the phone's frame, on its leading (left) edge,
 * where titles and ids start. Index-aligned with CAMERA.
 */
export const CAMERA_MOBILE: Partial<Pose>[] = [
  { pitch: 48, dist: -8000 },
  { x: 360, y: -20, yaw: -2, dist: 380 },
  { x: -100, y: 40, dist: 200 },
  { x: 230, y: -10, dist: 300 },
  { x: 1240, y: -10, yaw: 4, dist: 230 },
  { x: 1250, y: 60, yaw: 4, dist: 300 },
  { dist: -40 },
  { x: 1380, y: 300, dist: -1100 },
  { x: 1240, y: -10, yaw: 4, dist: 230 },
  { x: 20, y: -30, dist: 300 },
  { x: -140, y: 840, dist: 300 },
  { x: 1240, dist: 240 },
  { x: 2290, dist: 240 },
  { x: 2230, dist: 240 },
  { x: -120, pitch: 6, dist: 240 },
  { x: -1475, y: -240, yaw: -6, dist: 250 },
  { x: -1560, y: 380, yaw: -5, dist: 220 },
  { x: -80, y: 60, dist: 220 },
  { pitch: 48, dist: -8000 },
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

/** When each surface is rendered: the transits either side of every hold that sees it. */
export const LIVE: Record<SurfaceId, [number, number][]> = (() => {
  const live = Object.fromEntries(SURFACES.map((s) => [s.id, [] as [number, number][]])) as Record<SurfaceId, [number, number][]>;
  CAMERA.forEach((h, i) => {
    const from = i > 0 ? CAMERA[i - 1].t1 : 0;
    const to = i + 1 < CAMERA.length ? CAMERA[i + 1].t0 : DURATION;
    for (const s of SURFACES) if (h.sees === "all" || h.sees.includes(s.id)) live[s.id].push([from, to]);
  });
  return live;
})();

/* ── Scenes: one per chapter, one tick each ───────────────────────────── */

export type Scene = { id: ChapterId; name: string; start: number; end: number; hold: number; caption: string };

export const SCENES: Scene[] = [
  { id: "inbox", name: "Inbox", start: 0, end: 7.4, hold: 2.5, caption: "Every agent session, live. Claude Code, Codex, Cursor, Gemini, OpenCode and pi in one inbox." },
  { id: "conversation", name: "Steer", start: 7.4, end: 13.5, hold: 8.0, caption: "Open any session to watch it work, and steer it mid-run." },
  { id: "fanout", name: "Fan out", start: 13.5, end: 20.8, hold: 14.1, caption: "One lead spawns workers, and every session lands in the same inbox." },
  { id: "phone", name: "Approve", start: 20.8, end: 29.7, hold: 21.4, caption: "A worker needs permission. Approve it from your desk or your phone." },
  { id: "talk", name: "Talk", start: 29.7, end: 36.6, hold: 31.0, caption: "Sessions message each other, and fork to try another way." },
  { id: "decide", name: "Decide", start: 36.6, end: 42.2, hold: 37.5, caption: "Agents queue the calls only you can make, with every option priced out." },
  { id: "work", name: "Track", start: 42.2, end: 48.6, hold: 43.0, caption: "Tasks come straight out of the conversation, and agents claim them." },
  { id: "automation", name: "Automate", start: 48.6, end: 54.5, hold: 49.5, caption: "Triggers and workflows keep the work moving while you are away." },
  { id: "team", name: "Team", start: 54.5, end: 61.6, hold: 55.4, caption: "Your team sees the same sessions, talks in the same channels, and huddles live." },
  { id: "integrations", name: "GitHub", start: 61.6, end: 68.0, hold: 62.5, caption: "Pull requests know the sessions behind them, from checks to merge." },
  { id: "publish", name: "Publish", start: 68.0, end: 74.8, hold: 69.1, caption: "Publish a result as a page your team can comment on." },
  { id: "memory", name: "Memory", start: 74.8, end: 82.3, hold: 75.8, caption: "Weeks later, anyone can find why a line of code exists." },
  { id: "remote", name: "Anywhere", start: 82.3, end: DURATION, hold: 83.0, caption: "Sessions run on your laptop or a cloud host, all in one inbox." },
];

/** Reduced motion: each chapter's settled frame, the end of its last hold. */
export const STILLS: number[] = SCENES.map((s) => {
  const last = CAMERA.filter((h) => h.t0 >= s.start && h.t0 < s.end).pop();
  return last ? last.t1 - 0.1 : s.hold;
});

/** The "3 weeks later" caption over the palette: it settles into frame with the camera and fades as the palette opens. */
export const LABEL_3W = { pos: [-1380, -500, 0] as V3, cue: 74.9, end: 76.3 };

/* ── Motion vocabulary (chapters/<id>.motion.ts use these) ─────────────── */

export type Preset =
  | "drop" // house entrance: falls in from in front of the surface on DROP
  | "fadeIn"
  | "fadeOut"
  | "push" // slides from (x, y) to rest on `settle`
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
