/**
 * The hero fly-through as data: where every surface sits in the world, where
 * the camera holds, when each chapter starts, and every beat (an element's
 * entrance, push, pulse or cross-fade) keyed to film time. `timeline.ts` turns
 * this into a frame for any t; nothing here runs or measures anything.
 *
 * World axes: x right, y down, z toward the viewer. A surface's `pos` is its
 * centre; local coordinates in the anchor helpers are px from that centre.
 */

export type V3 = [number, number, number];

export const DURATION = 36;
export const POSTER_T = 5.4;

export type SurfaceId = "desk" | "phone" | "pairA" | "pairB" | "board" | "palette" | "blame" | "page";

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
};

/** Flight order: the deal flips them up in this order and down in reverse. */
export const SURFACES: Surface[] = [
  { id: "desk", w: 1180, h: 680, pos: [0, 0, 0], rot: [0, 0, 0], back: "Inbox", radius: 14 },
  { id: "phone", w: 300, h: 620, pos: [860, 30, 180], rot: [0, -16, -2], back: "From your phone", radius: 44 },
  { id: "pairA", w: 500, h: 300, pos: [1500, -250, -100], rot: [0, -8, 0], back: "Agents talk", radius: 12 },
  { id: "pairB", w: 500, h: 300, pos: [1560, 140, -20], rot: [0, -8, 0], back: "Agents talk", radius: 12 },
  { id: "board", w: 720, h: 320, pos: [80, 820, -20], rot: [24, 0, 0], back: "Tasks", radius: 12 },
  { id: "palette", w: 720, h: 380, pos: [-1380, -140, -100], rot: [0, 12, 0], back: "Memory", radius: 14 },
  { id: "blame", w: 720, h: 300, pos: [-1340, 360, -40], rot: [0, 10, 0], back: "Memory", radius: 12 },
  { id: "page", w: 780, h: 460, pos: [0, -900, -260], rot: [-10, 0, 0], back: "Publish", radius: 14 },
];

export const SURFACE_BY_ID = Object.fromEntries(SURFACES.map((s) => [s.id, s])) as Record<SurfaceId, Surface>;

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

/** Desk anchors are easier to read from the window's top-left corner. */
export const deskPt = (x: number, y: number, z = 0): V3 => localToWorld("desk", x - 590, y - 340, z);

/* ── Desk layout (px from the window's top-left) ─────────────────────── */

export const DESK = {
  chrome: 40,
  sidebar: 176,
  list: 330,
  listTop: 48,
  row: 58,
  workerRow: 74,
  convX: 506,
  header: 46,
};

/** Final order of the inbox list. `enter` is when the row lands; rows present from the start have none. */
export const DESK_ROWS = [
  { key: "migrate", h: DESK.row, enter: 3.4 },
  { key: "workerA", h: DESK.workerRow, enter: 8.5 },
  { key: "workerB", h: DESK.workerRow, enter: 8.8 },
  { key: "dash", h: DESK.row },
  { key: "flaky", h: DESK.row },
  { key: "dark", h: DESK.row },
  { key: "p95", h: DESK.row },
  { key: "cache", h: DESK.row },
  { key: "rate", h: DESK.row },
] as const;

export const rowTop = (i: number) => DESK.listTop + DESK_ROWS.slice(0, i).reduce((a, r) => a + r.h, 0);
export const rowCenter = (key: (typeof DESK_ROWS)[number]["key"]) => {
  const i = DESK_ROWS.findIndex((r) => r.key === key);
  return deskPt(DESK.sidebar + DESK.list / 2, rowTop(i) + DESK_ROWS[i].h / 2);
};

/* ── Camera ───────────────────────────────────────────────────────────── */

export type Pose = { x: number; y: number; z: number; pitch: number; yaw: number; roll: number; dist: number };
export type Hold = {
  t0: number;
  t1: number;
  pose: Pose;
  /** Applied to the transit that ARRIVES at this hold: extra pull-back (negative dist) and roll at mid-move. */
  crest?: number;
  crestRoll?: number;
  /** Drift across the hold (px of x, degrees of yaw); overview holds stay still so the seam is exact. */
  drift?: boolean;
};

const P = (x: number, y: number, z: number, pitch: number, yaw: number, roll: number, dist: number): Pose => ({ x, y, z, pitch, yaw, roll, dist });

export const OVERVIEW = P(40, -60, 0, 34, -6, 0, -3300);

export const CAMERA: Hold[] = [
  { t0: 0, t1: 0.9, pose: OVERVIEW },
  { t0: 2.4, t1: 5.6, pose: P(0, 0, 0, 3, -4, 0, -40), drift: true },
  { t0: 6.3, t1: 10.2, pose: P(110, 10, 0, 2, -6, 0, 10), drift: true },
  { t0: 11.2, t1: 13.4, pose: P(860, 30, 180, 0, 16, 2, 70), crest: -700, crestRoll: 3, drift: true },
  { t0: 14.4, t1: 15.0, pose: P(560, 20, 110, 0, 8, 1, -560) },
  { t0: 16.0, t1: 19.6, pose: P(1530, -55, -60, 0, 8, -1.5, -400), crest: -600, drift: true },
  { t0: 20.8, t1: 24.2, pose: P(80, 700, -40, -22, 0, 0, -220), crest: -1100, crestRoll: -3, drift: true },
  { t0: 25.2, t1: 27.6, pose: P(-1380, -140, -100, 0, -12, 0, -20), crest: -500, drift: true },
  { t0: 28.2, t1: 30.4, pose: P(-1340, 360, -40, -2, -10, 0, 0), drift: true },
  { t0: 31.0, t1: 33.4, pose: P(0, -900, -260, 10, 0, 0, -60), crest: -900, crestRoll: 2, drift: true },
  { t0: 34.2, t1: 36, pose: OVERVIEW },
];

/** Phones get the same flight framed tighter on each chapter's hero element. Index-aligned with CAMERA. */
export const CAMERA_MOBILE: Partial<Pose>[] = [
  { pitch: 48, dist: -5200 },
  { x: -120, y: -150, yaw: -2, dist: 300 },
  { x: -250, y: -150, yaw: -3, dist: 260 },
  { dist: -40 },
  { x: 420, y: 20, dist: -900 },
  { x: 1560, y: 130, yaw: 4, dist: 20 },
  { x: 60, y: 720, dist: 120 },
  { x: -1380, y: -150, yaw: -6, dist: 80 },
  { x: -1340, y: 360, yaw: -5, dist: 60 },
  { x: 0, y: -900, pitch: 6, dist: 60 },
  { pitch: 48, dist: -5200 },
];

/* ── Chapters ─────────────────────────────────────────────────────────── */

export type Scene = { name: string; start: number; end: number; hold: number; caption: string };

export const SCENES: Scene[] = [
  { name: "Inbox", start: 0, end: 6, hold: 2.6, caption: "Every agent session, live. Claude Code, Codex, Cursor, OpenCode and pi in one inbox." },
  { name: "Fan out", start: 6, end: 10.6, hold: 6.3, caption: "One lead spawns workers, and every session lands in the same inbox." },
  { name: "From your phone", start: 10.6, end: 15.6, hold: 11.2, caption: "A worker needs permission. Approve it from your phone." },
  { name: "Agents talk", start: 15.6, end: 20.2, hold: 16.0, caption: "Sessions message each other to hand off work." },
  { name: "Tasks", start: 20.2, end: 24.8, hold: 20.8, caption: "Tasks come straight out of the conversation, and agents claim them." },
  { name: "Memory", start: 24.8, end: 30.8, hold: 25.2, caption: "Weeks later, anyone can find why a line of code exists." },
  { name: "Publish", start: 30.8, end: 36, hold: 31.0, caption: "Publish the result as a page your team can comment on." },
];

/* ── Beats ────────────────────────────────────────────────────────────── */

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

/** Staggered pushes for every desk row below a row that lands at `cue`. */
function pushRowsBelow(i: number, cue: number): Beat[] {
  const h = DESK_ROWS[i].h;
  return DESK_ROWS.slice(i + 1).map((r, k) => ({ id: `row:${r.key}`, cue: cue + k * 0.025, dur: 0.48, preset: "push" as const, y: -h }));
}

const stagger = (ids: string[], cue: number, step: number, b: Omit<Beat, "id" | "cue">): Beat[] => ids.map((id, i) => ({ id, cue: cue + i * step, ...b }));

export const BEATS: Record<SurfaceId, Beat[]> = {
  desk: [
    // Scene 1: every agent, then a new session lands on top and takes focus.
    ...stagger(["chip:dash", "chip:flaky", "chip:dark", "chip:p95", "chip:cache", "chip:rate"], 2.8, 0.09, { preset: "pulse", dur: 0.36, s: 0.14 }),
    { id: "row:migrate", cue: 3.4, preset: "drop", z: 240, rx: -22, y: -40 },
    ...pushRowsBelow(0, 3.4),
    { id: "hl:dash", cue: 4.8, dur: 0.2, preset: "fadeOut" },
    { id: "hl:migrate", cue: 4.8, dur: 0.2, preset: "fadeIn" },
    { id: "conv:dash", cue: 4.9, dur: 0.3, preset: "fadeOut" },
    { id: "conv:migrate", cue: 4.9, dur: 0.3, preset: "fadeIn" },
    { id: "prompt", cue: 5.0, preset: "drop" },
    // Scene 2: the lead fans out.
    { id: "spawnA", cue: 7.3, dur: 0.4, preset: "push", y: 10 },
    { id: "spawnA", cue: 7.3, dur: 0.4, preset: "fadeIn" },
    { id: "spawnB", cue: 7.7, dur: 0.4, preset: "push", y: 10 },
    { id: "spawnB", cue: 7.7, dur: 0.4, preset: "fadeIn" },
    { id: "row:workerA", cue: 8.5, preset: "drop", z: 120, rx: -12, y: -16 },
    ...pushRowsBelow(1, 8.5),
    { id: "row:workerB", cue: 8.8, preset: "drop", z: 120, rx: -12, y: -16 },
    ...pushRowsBelow(2, 8.8),
    ...stagger(["chip:migrate", "chip:workerA", "chip:workerB"], 9.0, 0.12, { preset: "pulse", dur: 0.36, s: 0.18 }),
    { id: "dotAmber:workerA", cue: 9.4, dur: 0.25, preset: "fadeIn" },
    { id: "dotWrap:workerA", cue: 9.4, dur: 0.4, preset: "pulse", s: 0.35 },
    { id: "note1:workerA", cue: 9.4, dur: 0.3, preset: "fadeOut" },
    { id: "note2:workerA", cue: 9.4, dur: 0.3, preset: "fadeIn" },
    { id: "badge", cue: 9.4, dur: 0.3, preset: "pulse", s: 0.3 },
    { id: "ring:workerA", cue: 10.1, dur: 0.9, preset: "ring" },
    // Scene 3 payoff: the approval lands back on the desk.
    { id: "dotAmber:workerA", cue: 13.8, dur: 0.3, preset: "fadeOut" },
    { id: "dotWrap:workerA", cue: 13.8, dur: 0.4, preset: "pulse", s: 0.35 },
    { id: "note2:workerA", cue: 13.8, dur: 0.3, preset: "fadeOut" },
    { id: "note3:workerA", cue: 13.8, dur: 0.3, preset: "fadeIn" },
    { id: "badge", cue: 13.8, dur: 0.3, preset: "pulse", s: 0.3 },
    // Scene 4, seen on arrival in scene 5: the lead files a task.
    { id: "prose2", cue: 19.8, dur: 0.4, preset: "fadeIn" },
    { id: "prose2", cue: 19.8, dur: 0.4, preset: "push", y: 8 },
    { id: "taskpill", cue: 20.3, dur: 0.25, preset: "fadeOut" },
  ],
  phone: [
    { id: "banner", cue: 11.2, preset: "drop", z: 60, rx: 0, y: -80 },
    { id: "banner", cue: 11.9, dur: 0.4, preset: "fadeOut" },
    { id: "banner", cue: 11.9, dur: 0.4, preset: "liftOut", z: 90, y: -10 },
    { id: "session", cue: 11.9, dur: 0.4, preset: "fadeIn" },
    { id: "session", cue: 11.9, dur: 0.45, preset: "popIn", s: 0.94 },
    { id: "inbox", cue: 11.9, dur: 0.4, preset: "fadeOut" },
    { id: "tapRing", cue: 12.8, dur: 0.42, preset: "ring" },
    { id: "approve", cue: 12.8, dur: 0.24, preset: "press" },
    { id: "approved", cue: 13.0, dur: 0.2, preset: "fadeIn" },
    { id: "approveLabel", cue: 13.0, dur: 0.2, preset: "fadeOut" },
    { id: "deny", cue: 13.0, dur: 0.25, preset: "fadeOut" },
    { id: "hdrAmber", cue: 13.0, dur: 0.25, preset: "fadeOut" },
    { id: "hdrGreen", cue: 13.0, dur: 0.25, preset: "fadeIn" },
    { id: "passed", cue: 13.2, dur: 0.4, preset: "fadeIn" },
    { id: "passed", cue: 13.2, dur: 0.4, preset: "push", y: 6 },
  ],
  pairA: [
    { id: "cmdA", cue: 16.1, dur: 0.2, preset: "fadeIn" },
    { id: "backMsg", cue: 19.7, preset: "drop", z: 140, rx: -14, y: -16 },
  ],
  pairB: [
    { id: "msgCard", cue: 18.2, preset: "drop", z: 160, rx: -16, y: -20 },
  ],
  board: [
    { id: "newRow", cue: 21.6, dur: 0.5, preset: "growX", s: 0.3 },
    { id: "newRowBody", cue: 21.85, dur: 0.3, preset: "fadeIn" },
    ...stagger(["task:0", "task:1", "task:2", "task:3"], 21.6, 0.025, { preset: "push", dur: 0.48, y: -36 }),
    { id: "who:empty", cue: 22.6, dur: 0.38, preset: "flipOut" },
    { id: "who:codex", cue: 22.6, dur: 0.38, preset: "flipIn" },
    { id: "status:open", cue: 22.6, dur: 0.3, preset: "fadeOut" },
    { id: "status:doing", cue: 22.6, dur: 0.3, preset: "fadeIn" },
    { id: "claimed", cue: 22.7, dur: 0.35, preset: "fadeIn" },
    { id: "claimed", cue: 22.7, dur: 0.35, preset: "push", x: 8 },
    { id: "claimed", cue: 23.9, dur: 0.4, preset: "fadeOut" },
    { id: "done0:icon", cue: 23.4, dur: 0.3, preset: "fadeIn" },
    { id: "done0:iconOld", cue: 23.4, dur: 0.3, preset: "fadeOut" },
    { id: "done0:check", cue: 23.4, dur: 0.35, preset: "pulse", s: 0.3 },
    { id: "done0:title", cue: 23.4, dur: 0.4, preset: "fadeIn" },
    { id: "done0:titleOld", cue: 23.4, dur: 0.4, preset: "fadeOut" },
  ],
  palette: [
    { id: "placeholder", cue: 25.35, dur: 0.1, preset: "fadeOut" },
    ...stagger(["group:sessions", "res:0", "res:1", "group:tasks", "res:2"], 26.4, 0.1, { preset: "drop", z: 40, rx: 0, y: -16 }),
    { id: "sel", cue: 26.9, dur: 0.25, preset: "fadeIn" },
  ],
  blame: [
    ...stagger(["bl:0", "bl:1", "bl:2"], 28.3, 0.08, { preset: "fadeIn", dur: 0.25 }),
    ...stagger(["who:0", "who:1"], 28.45, 0.08, { preset: "fadeIn", dur: 0.25 }),
    { id: "hlbar", cue: 28.6, dur: 0.26, preset: "growX" },
    { id: "quote", cue: 29.1, preset: "drop", z: 160, rx: -16, y: -20 },
  ],
  page: [
    ...stagger(["bar:0", "bar:1", "bar:2", "bar:3", "bar:4", "bar:5"], 31.1, 0.06, { preset: "growY" }),
    { id: "chip", cue: 31.6, dur: 0.35, preset: "fadeIn" },
    { id: "chip", cue: 31.6, dur: 0.5, preset: "push", x: -40 },
    { id: "chipCmd", cue: 31.95, dur: 0.2, preset: "fadeOut" },
    { id: "chipUrl", cue: 31.95, dur: 0.2, preset: "fadeIn" },
    { id: "card", cue: 32.0, dur: 0.3, preset: "fadeOut" },
    { id: "full", cue: 32.0, dur: 0.52, preset: "popIn", s: 0.62 },
    { id: "full", cue: 32.0, dur: 0.3, preset: "fadeIn" },
    ...stagger(["comment:0", "comment:1"], 32.6, 0.18, { preset: "drop", z: 120, rx: -12, y: -14 }),
    { id: "viewers", cue: 32.9, dur: 0.35, preset: "popIn", s: 0.5 },
  ],
};

/* ── Typed text ───────────────────────────────────────────────────────── */

export type TextBeat =
  | { id: string; kind: "chars" | "words"; text: string; cue: number; rate: number }
  | { id: string; kind: "keys"; keys: [number, string][] };

export const TEXTS: Record<SurfaceId, TextBeat[]> = {
  desk: [
    { id: "badge", kind: "keys", keys: [[0, "1"], [9.4, "2"], [13.8, "1"]] },
    { id: "prose1", kind: "words", text: "On it. Splitting this in two: the API half and the dashboard retry UI.", cue: 6.4, rate: 18 },
  ],
  phone: [],
  pairA: [{ id: "cmdA", kind: "chars", text: 'cast send jx7k2mq "api is on staging, your turn"', cue: 16.2, rate: 40 }],
  pairB: [{ id: "replyB", kind: "words", text: "Retry states are in. Staging green on my end.", cue: 18.7, rate: 14 }],
  board: [],
  palette: [{ id: "query", kind: "chars", text: "why do webhooks retry twice", cue: 25.4, rate: 34 }],
  blame: [],
  page: [],
};

/* ── Flyers: world-level cards that carry cause to effect ─────────────── */

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

const spawnFromA = deskPt(DESK.convX + 20 + 170, 219);
const spawnFromB = deskPt(DESK.convX + 20 + 170, 257);

export const FLYERS: Flyer[] = [
  { id: "ghostSpawnA", cue: 7.9, dur: 0.6, from: spawnFromA, to: rowCenter("workerA"), arc: 260, rot: [[0, 0, 0], [0, 35, -4], [0, 0, 0]], ease: "glide", fade: [0.12, 0.12] },
  { id: "ghostSpawnB", cue: 8.2, dur: 0.6, from: spawnFromB, to: rowCenter("workerB"), arc: 260, rot: [[0, 0, 0], [0, 35, -4], [0, 0, 0]], ease: "glide", fade: [0.12, 0.12] },
  { id: "ghostPermission", cue: 10.3, dur: 0.85, from: rowCenter("workerA"), to: localToWorld("phone", 0, -206, 8), arc: 320, rot: [[0, 0, 0], [0, -30, 4], [0, -16, -2]], scale: [1, 0.86], ease: "glide", fade: [0.1, 0.08] },
  { id: "envelope", cue: 17.5, dur: 0.7, from: localToWorld("pairA", -60, -8, 4), to: localToWorld("pairB", -80, -44, 4), arc: 220, rot: [[0, -8, 0], [0, -8, 8], [0, -8, 0]], ease: "glide", fade: [0.1, 0.12] },
  { id: "envelopeBack", cue: 19.2, dur: 0.5, from: localToWorld("pairB", -40, 70, 4), to: localToWorld("pairA", -60, 92, 4), arc: 140, rot: [[0, -8, 0], [0, -8, -8], [0, -8, 0]], ease: "glide", fade: [0.1, 0.14] },
  { id: "ghostTask", cue: 20.3, dur: 1.3, from: deskPt(DESK.convX + 20 + 380, 312, 4), to: localToWorld("board", -170, -69, 4), arc: 200, rot: [[0, 0, 0], [30, 0, -10], [24, 0, 0]], ease: "fall", fade: [0.06, 0.1] },
];

/** The one non-transform animation: the approval's path from phone to desk row, drawn with stroke-dashoffset. */
export const ARC = {
  id: "arc",
  cue: 13.6,
  dur: 0.5,
  hold: 1.2,
  from: localToWorld("phone", -150, -140, 0),
  to: (() => {
    const c = rowCenter("workerA");
    return [c[0] + 150, c[1], c[2]] as V3;
  })(),
};

export const LABEL_3W = { pos: [-760, 420, 260] as V3, cue: 24.4, end: 25.3 };

/** Surfaces the camera can see at time t; the rest are culled with visibility. */
export const LIVE: Record<SurfaceId, [number, number][]> = {
  desk: [[0, 22.2], [30.8, 36]],
  phone: [[0, 16.4], [33.2, 36]],
  pairA: [[0, 1.6], [12.6, 21], [33.2, 36]],
  pairB: [[0, 1.6], [12.6, 21], [33.2, 36]],
  board: [[0, 1.8], [19.4, 25.6], [33.2, 36]],
  palette: [[0, 1.8], [23.8, 31], [33.2, 36]],
  blame: [[0, 1.8], [23.8, 31.2], [33.2, 36]],
  page: [[0, 1.6], [29.6, 36]],
};
