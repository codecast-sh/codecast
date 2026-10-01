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
  /** Chapter name printed on the back face the deal flips over. */
  back: string;
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
    id: "desk", w: 1180, h: 680, pos: [0, 0, 0], rot: [0, 0, 0], back: "Inbox", radius: 14,
    regions: {
      sidebar: { x: 0, y: 0, w: 200, h: 680 },
      list: { x: 200, y: 0, w: 340, h: 680 },
      header: { x: 540, y: 0, w: 640, h: 48 },
      transcript: { x: 540, y: 48, w: 640, h: 512, anchor: "bottom" },
      composer: { x: 540, y: 560, w: 640, h: 120 },
      side: { x: 800, y: 64, w: 360, h: 460 },
      inset: { x: 700, y: 430, w: 460, h: 230 },
    },
  },
  {
    id: "phone", w: 300, h: 620, pos: [1440, 600, 160], rot: [0, -12, -2], back: "From your phone", radius: 44, frame: "phone", fadeInTransit: true,
    regions: whole(276, 572),
  },
  // The workers side by side, one window each, the way two panes sit on a wide screen.
  {
    id: "pairA", w: 540, h: 320, pos: [1250, -20, -60], rot: [0, -6, 0], back: "Agents talk", radius: 12,
    regions: { header: { x: 0, y: 0, w: 540, h: 44 }, transcript: { x: 0, y: 44, w: 540, h: 276, anchor: "bottom" } },
  },
  {
    id: "pairB", w: 540, h: 320, pos: [1830, 20, -60], rot: [0, -10, 0], back: "Agents talk", radius: 12,
    regions: { header: { x: 0, y: 0, w: 540, h: 44 }, transcript: { x: 0, y: 44, w: 540, h: 276, anchor: "bottom" } },
  },
  { id: "board", w: 1000, h: 520, pos: [80, 900, -20], rot: [24, 0, 0], back: "Tasks", radius: 12, regions: whole(1000, 520) },
  { id: "auto", w: 900, h: 520, pos: [1400, 980, -60], rot: [16, -6, 0], back: "Automation", radius: 12, regions: whole(900, 520) },
  { id: "team", w: 980, h: 600, pos: [2500, 360, -80], rot: [0, -10, 0], back: "Team", radius: 14, regions: whole(980, 600) },
  { id: "pr", w: 900, h: 560, pos: [2400, -800, -120], rot: [-8, -8, 0], back: "Pull requests", radius: 12, regions: whole(900, 560) },
  { id: "page", w: 900, h: 560, pos: [0, -1000, -260], rot: [-10, 0, 0], back: "Publish", radius: 14, regions: whole(900, 560) },
  { id: "palette", w: 720, h: 300, pos: [-1380, -240, -100], rot: [0, 12, 0], back: "Memory", radius: 14, regions: whole(720, 300) },
  { id: "blame", w: 900, h: 380, pos: [-1400, 380, -40], rot: [0, 10, 0], back: "Memory", radius: 12, regions: whole(900, 380) },
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
};

const P = (x: number, y: number, z: number, pitch: number, yaw: number, roll: number, dist: number): Pose => ({ x, y, z, pitch, yaw, roll, dist });

export const OVERVIEW = P(570, -20, 0, 34, -6, 0, -5000);

const PAIR = P(1540, 0, -60, 0, 8, -1.5, 40);

/**
 * Each transit takes the time its distance needs (about 0.9s plus 1s per
 * 1600px, between 1.1s and 2.2s; the dives in and out of the overview 1.6s),
 * so no move crosses the frame faster than a couple of widths a second.
 */
export const CAMERA: Hold[] = [
  { t0: 0, t1: 0.9, pose: OVERVIEW, sees: "all" },
  // 1 Inbox: the whole window, slight three-quarter.
  { t0: 2.5, t1: 6.9, pose: P(0, 0, 0, 3, -4, 0, -90), sees: ["desk"], drift: true },
  // 2 Conversation: in on the conversation pane; the left edge falls on the list's border.
  { t0: 8.0, t1: 13.0, pose: P(155, 5, 0, 2, -5, 0, 240), sees: ["desk"], drift: true },
  // 3 Fan out: list and conversation, then the workers boot on the pair.
  { t0: 14.1, t1: 16.5, pose: P(60, 0, 0, 2, -6, 0, 0), sees: ["desk"], drift: true },
  { t0: 18.3, t1: 20.3, pose: PAIR, sees: ["pairA", "pairB"], crest: -600, drift: true },
  // 4 Approve: the ask in the API worker's own pane, the phone, then pull back to see both.
  { t0: 21.4, t1: 23.0, pose: P(1250, -20, -60, 0, 6, 0, 150), sees: ["pairA", "pairB"], drift: true },
  { t0: 24.3, t1: 26.5, pose: P(1440, 600, 160, 0, 12, 2, 70), sees: ["phone", "pairA"], crest: -500, crestRoll: 3, drift: true },
  { t0: 28.0, t1: 29.0, pose: P(1420, 290, 40, 0, 8, 1, -820), sees: ["phone", "pairA", "pairB"] },
  // 5 Agents talk.
  { t0: 30.5, t1: 35.7, pose: PAIR, sees: ["pairA", "pairB"], drift: true },
  // 6 Decide: the side card on the desk.
  { t0: 37.5, t1: 41.5, pose: P(180, -46, 0, 2, -4, 0, 380), sees: ["desk"], crest: -900, crestRoll: 2, drift: true },
  // 7 Track: the biggest swoop, down to the board.
  { t0: 43.0, t1: 47.8, pose: P(80, 815, -60, -22, 0, 0, 160), sees: ["board", "desk"], crest: -1100, crestRoll: -3, drift: true },
  // 8 Automate.
  { t0: 49.5, t1: 53.7, pose: P(1400, 975, -60, -14, 6, 0, 150), sees: ["auto", "board"], crest: -500, drift: true },
  // 9 Team.
  { t0: 55.4, t1: 60.8, pose: P(2500, 360, -80, 0, 10, 0, 40), sees: ["team"], crest: -800, crestRoll: 2, drift: true },
  // 10 Integrations.
  { t0: 62.5, t1: 66.9, pose: P(2400, -900, -120, 8, 8, 0, 90), sees: ["pr", "team"], crest: -700, drift: true },
  // 11 Publish: a long pan west along the top of the world.
  { t0: 69.1, t1: 73.9, pose: P(0, -1000, -260, 10, 0, 0, -80), sees: ["page"], crest: -1200, crestRoll: -2, drift: true },
  // 12 Memory: past the "3 weeks later" label to the palette, then the blame.
  { t0: 75.8, t1: 78.0, pose: P(-1380, -240, -100, 0, -12, 0, 40), sees: ["palette"], crest: -500, drift: true },
  { t0: 79.3, t1: 81.3, pose: P(-1400, 380, -40, -2, -10, 0, 60), sees: ["blame", "palette"], drift: true },
  // 13 Anywhere: in on the desk's inset, then the whole world for the seam.
  { t0: 83.4, t1: 86.4, pose: P(420, 260, 0, 2, -4, 0, 420), sees: ["desk"], crest: -600, drift: true },
  { t0: 88.0, t1: DURATION, pose: OVERVIEW, sees: "all" },
];

/**
 * Phones get the same flight framed tighter on each chapter's hero element:
 * where a surface is wider than the phone's frame, on its leading (left) edge,
 * where titles and ids start. Index-aligned with CAMERA.
 */
export const CAMERA_MOBILE: Partial<Pose>[] = [
  { pitch: 48, dist: -8000 },
  { x: -200, y: -45, yaw: -2, dist: 450 },
  { x: 230, y: 0, dist: 200 },
  { x: -120, y: -20, dist: 330 },
  { x: 1240, y: -10, yaw: 4, dist: 230 },
  { x: 1180, y: 20, yaw: 4, dist: 260 },
  { dist: -40 },
  { x: 1380, y: 300, dist: -1100 },
  { x: 1240, y: -10, yaw: 4, dist: 230 },
  { x: 390, y: -50, dist: 300 },
  { x: -140, y: 840, dist: 300 },
  { x: 1240, dist: 240 },
  { x: 2400, dist: 240 },
  { x: 2230, dist: 240 },
  { x: -150, pitch: 6, dist: 240 },
  { x: -1380, y: -240, yaw: -6, dist: 250 },
  { x: -1570, y: 380, yaw: -5, dist: 220 },
  { x: 420, y: 260, dist: 330 },
  { pitch: 48, dist: -8000 },
];

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
  { id: "inbox", name: "Inbox", start: 0, end: 7.4, hold: 2.5, caption: "Every agent session, live. Claude Code, Codex, Cursor, Gemini and pi in one inbox." },
  { id: "conversation", name: "Steer", start: 7.4, end: 13.5, hold: 8.0, caption: "Open any session to watch it work, and steer it mid-run." },
  { id: "fanout", name: "Fan out", start: 13.5, end: 20.8, hold: 14.1, caption: "One lead spawns workers, and every session lands in the same inbox." },
  { id: "phone", name: "Approve", start: 20.8, end: 29.7, hold: 21.4, caption: "A worker needs permission. Approve it from your desk or your phone." },
  { id: "talk", name: "Talk", start: 29.7, end: 36.6, hold: 30.5, caption: "Sessions message each other, and fork to try another way." },
  { id: "decide", name: "Decide", start: 36.6, end: 42.2, hold: 37.5, caption: "Agents queue the calls only you can make, with every option priced out." },
  { id: "work", name: "Track", start: 42.2, end: 48.6, hold: 43.0, caption: "Tasks come straight out of the conversation, and agents claim them." },
  { id: "automation", name: "Automate", start: 48.6, end: 54.5, hold: 49.5, caption: "Triggers and workflows keep the work moving while you are away." },
  { id: "team", name: "Team", start: 54.5, end: 61.6, hold: 55.4, caption: "Your team sees the same sessions, talks in the same channels, and huddles live." },
  { id: "integrations", name: "GitHub", start: 61.6, end: 68.0, hold: 62.5, caption: "Pull requests know the sessions behind them, from checks to merge." },
  { id: "publish", name: "Publish", start: 68.0, end: 74.8, hold: 69.1, caption: "Publish a result as a page your team can comment on." },
  { id: "memory", name: "Memory", start: 74.8, end: 82.3, hold: 75.8, caption: "Weeks later, anyone can find why a line of code exists." },
  { id: "remote", name: "Anywhere", start: 82.3, end: DURATION, hold: 83.4, caption: "Sessions run on your laptop or a cloud host, all in one inbox." },
];

/** Reduced motion: each chapter's settled frame, the end of its last hold. */
export const STILLS: number[] = SCENES.map((s) => {
  const last = CAMERA.filter((h) => h.t0 >= s.start && h.t0 < s.end).pop();
  return last ? last.t1 - 0.1 : s.hold;
});

/** The "3 weeks later" world label the camera flies past on the way to Memory. */
export const LABEL_3W = { pos: [-760, -560, 260] as V3, cue: 74.3, end: 75.6 };

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

/** A path drawn in world space with stroke-dashoffset (the one non-transform animation). */
export type ArcPath = { id: string; cue: number; dur: number; hold: number; from: V3; to: V3; color: string };
