/**
 * The film as a pure function of time. `frame(t)` returns the camera, every
 * animated element's transform and opacity, and every typed string, computed
 * from the declarative config in `world.ts` and the chapters' motion gathered
 * by `motion.ts`. No clocks, no accumulated state:
 * seeking to t always renders the same picture, which is what makes the loop
 * seamless and the film verifiable by capture.
 */

import { ARCS, BEATS, FLYERS, TEXTS } from "./motion";
import {
  CAMERA,
  CAMERA_MOBILE,
  DRIFT,
  DURATION,
  LABEL_3W,
  SEAM_HOME,
  SURFACE_BY_ID,
  SURFACES,
  localToWorld,
  seesOf,
  type Beat,
  type Flyer,
  type Hold,
  type Pose,
  type SurfaceId,
  type V3,
} from "./world";
import { projector, rotation, STAGE_SIZE } from "./project";

/* ── Easing kit ───────────────────────────────────────────────────────── */

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const bx = (u: number) => 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u * u * (1 - u) + u ** 3;
  const by = (u: number) => 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u * u * (1 - u) + u ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < x) lo = mid;
      else hi = mid;
    }
    return by((lo + hi) / 2);
  };
}

export const glide = cubicBezier(0.65, 0, 0.35, 1);
/** The camera's move: eases out and in evenly, close to a sine, so no move peaks above about 1.6 times its average speed. */
export const camEase = cubicBezier(0.37, 0, 0.63, 1);
export const settle = cubicBezier(0.16, 1, 0.3, 1);
/**
 * Opacity's ease: it starts and lands softly, where `settle` leaves at six
 * times its average rate and would show most of a fade in its first frame.
 * No fade is shorter than MIN_FADE, so nothing appears or vanishes at once.
 */
export const fade = cubicBezier(0.33, 0, 0.25, 1);
const MIN_FADE = 0.3;
/** An entrance or a slide into place: it leaves at about twice its average speed (settle leaves at six) and lands gently. */
export const glideOut = cubicBezier(0.25, 0.5, 0.3, 1);
const fadeP = (s: number, dur: number) => fade(clamp(s / Math.max(dur, MIN_FADE)));

/**
 * Damped spring from 0 to 1 as a function of seconds since its cue. It is
 * bent to land on exactly 1 at `T` (2.5s by default) so nothing drifts past a
 * cut or the loop seam.
 */
export function spring(w: number, zeta: number) {
  const wd = w * Math.sqrt(1 - zeta * zeta);
  const raw = (s: number) => 1 - Math.exp(-zeta * w * s) * (Math.cos(wd * s) + ((zeta * w) / wd) * Math.sin(wd * s));
  return (s: number, T = 2.5) => {
    if (s <= 0) return 0;
    if (s >= T) return 1;
    return raw(s) + (1 - raw(T)) * (s / T);
  };
}

export const DROP = spring(11, 0.7);
export const SETTLE = spring(10, 0.86);
export const SNAP = spring(24, 0.72);

/**
 * Opacity of something that goes away at `out` and comes back at `back`
 * (film seconds), easing each way over `dur`: a status that clears while an
 * agent waits and returns when it works again, never in one frame.
 */
export const dip = (t: number, out: number, back: number, dur = 0.3): number =>
  t < back ? 1 - fade(clamp((t - out) / dur)) : Math.max(1 - fade(clamp((back - out) / dur)), fade(clamp((t - back) / dur)));

/** Eased progress of a beat. */
export const progress = (t: number, cue: number, dur: number, ease: (x: number) => number = settle) => ease(clamp((t - cue) / dur));

/** The first `n` characters (or words) typed by t at `rate` per second. */
export function typed(text: string, t: number, cue: number, rate: number, words = false): string {
  const n = Math.max(0, Math.floor((t - cue) * rate));
  if (!words) return text.slice(0, n);
  const parts = text.split(" ");
  return parts.slice(0, Math.min(parts.length, n)).join(" ");
}

/* ── Camera ───────────────────────────────────────────────────────────── */

/** A hold breathes without leaving centre: a push toward the subject, which stays about the box's centre, and a slight turn symmetric about its middle. */
function holdPose(h: Hold, v: number, over?: Partial<Pose>): Pose {
  const p = { ...h.pose, ...over };
  if (!h.drift) return p;
  return { ...p, yaw: p.yaw + DRIFT.yaw * (v - 0.5), dist: p.dist + DRIFT.push * v };
}

/**
 * A Hermite segment from p1 to p2 whose tangents lean toward the neighbouring
 * holds, kept to the segment's own direction and to half its span, so a far
 * neighbour can never swing a short move past its ends (the curve stays
 * monotone between them).
 */
function catmull(p0: number, p1: number, p2: number, p3: number, u: number, tension = 0.35) {
  const d = p2 - p1;
  const lim = (m: number) => (d >= 0 ? clamp(m, 0, d * 0.5) : clamp(m, d * 0.5, 0));
  const m1 = lim((p2 - p0) * tension);
  const m2 = lim((p3 - p1) * tension);
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
}

const overOf = (i: number, mobile: boolean) => (mobile ? CAMERA_MOBILE[i] : undefined);

/** The camera at progress `u` of the move from hold i to hold i + 1, pulled back by `crest` px at its middle. */
function transitPose(i: number, u: number, mobile: boolean, crest: number): Pose {
  const holds = CAMERA;
  const [h, next] = [holds[i], holds[i + 1]];
  const a = holdPose(h, 1, overOf(i, mobile));
  const b = holdPose(next, 0, overOf(i + 1, mobile));
  const prev = i > 0 ? holdPose(holds[i - 1], 1, overOf(i - 1, mobile)) : a;
  const after = i + 2 < holds.length ? holdPose(holds[i + 2], 0, overOf(i + 2, mobile)) : b;
  const span = next.t0 - h.t1;
  const e = camEase(u);
  // Roll runs 150ms ahead of the turn so the move banks into itself: it starts with the move and settles before it lands.
  const eRoll = camEase(clamp(u / Math.max(0.5, 1 - 0.15 / span)));
  return {
    x: catmull(prev.x, a.x, b.x, after.x, e),
    y: catmull(prev.y, a.y, b.y, after.y, e),
    z: catmull(prev.z, a.z, b.z, after.z, e),
    pitch: lerp(a.pitch, b.pitch, e),
    yaw: lerp(a.yaw, b.yaw, e),
    roll: lerp(a.roll, b.roll, eRoll) + (next.crestRoll ?? 0) * Math.sin(Math.PI * eRoll),
    dist: lerp(a.dist, b.dist, e) + crest * Math.sin(Math.PI * e),
  };
}

/**
 * How far each move pulls back at its middle: the hold's own `crest`, or
 * more where that would let a window the move shows reach above or below the
 * box while it is on the page (a pan's turn brings a window's near edge
 * closer, and a full-height window would then outgrow the box). A move
 * therefore carries the windows it leaves off the side of the page and brings
 * the next ones in whole: nothing has to lift out mid-pan.
 */
const CREST_STEP = 25;
const CREST_FLOOR = -1600;
/** Room kept from the box's top and bottom while a window crosses, so sampling between frames never grazes the edge. */
const CREST_CLEAR = 8;

function solveCrests(mobile: boolean): number[] {
  const [px0, px1] = PAGE_X[mobile ? "mobile" : "desktop"];
  const h = boxH(mobile);
  return CAMERA.slice(0, -1).map((hold, i) => {
    const next = CAMERA[i + 1];
    const ids = [...new Set([...seesOf(hold, mobile), ...seesOf(next, mobile)])];
    const span = next.t0 - hold.t1;
    const steps = Math.max(24, Math.ceil(span * 40));
    // How many sampled frames would show a window across the top or bottom, over the part of the move a pull-back reaches (at least half of it applied).
    const crossings = (crest: number) => {
      let n = 0;
      for (let k = 1; k < steps; k++) {
        const u = k / steps;
        if (Math.sin(Math.PI * camEase(u)) < 0.5) continue;
        const at = projector(transitPose(i, u, mobile, crest), mobile);
        // A window either end is about is shown whenever it reaches the page (transitOpacity), so every one of them counts.
        for (const id of ids) {
          const b = bounds(CORNERS_OF[SURFACE_INDEX[id]], at);
          if (b && (b.x1 <= px0 || b.x0 >= px1)) continue;
          if (!b || b.y0 < EDGE_CLEAR + CREST_CLEAR || b.y1 > h - EDGE_CLEAR - CREST_CLEAR) n++;
        }
      }
      return n;
    };
    // The least pull-back that keeps the fewest crossings. Near a move's ends a pull-back has no effect; there a window crossing the edge has left the box by then and fades on its way out (presence).
    let best = (next.crest ?? 0) * (mobile ? 1.6 : 1);
    let fewest = crossings(best);
    for (let crest = best - CREST_STEP; fewest > 0 && crest >= CREST_FLOOR; crest -= CREST_STEP) {
      const n = crossings(crest);
      if (n < fewest) [best, fewest] = [crest, n];
    }
    return best;
  });
}

const CRESTS: Partial<Record<"desktop" | "mobile", number[]>> = {};
/** Each move's pull-back for a framing, solved once on first use. */
export const crestsFor = (mobile: boolean): number[] => (CRESTS[mobile ? "mobile" : "desktop"] ??= solveCrests(mobile));

export function cameraAt(t: number, mobile = false): { pose: Pose; moving: boolean } {
  const holds = CAMERA;
  for (let i = 0; i < holds.length; i++) {
    const h = holds[i];
    if (t >= h.t0 && t <= h.t1) return { pose: holdPose(h, h.t1 > h.t0 ? (t - h.t0) / (h.t1 - h.t0) : 0, overOf(i, mobile)), moving: false };
    const next = holds[i + 1];
    if (next && t > h.t1 && t < next.t0) return { pose: transitPose(i, (t - h.t1) / (next.t0 - h.t1), mobile, crestsFor(mobile)[i]), moving: true };
  }
  return { pose: holdPose(holds[0], 0, overOf(0, mobile)), moving: false };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function cameraTransform(p: Pose): string {
  return `translateZ(${r3(p.dist)}px) rotateX(${r3(p.pitch)}deg) rotateY(${r3(p.yaw)}deg) rotateZ(${r3(p.roll)}deg) translate3d(${r3(-p.x)}px, ${r3(-p.y)}px, ${r3(-p.z)}px)`;
}

/* ── The seam: the opening window's content dissolves home ───────────── */

/**
 * The last move eases home to the opening frame on the same desk, and the
 * window never leaves. The app goes back to the session the film opened on,
 * the way it opens any session: at `from` (world.ts SEAM_HOME) the inbox's
 * selection passes back to that row (the rows the film added have faded out
 * just before and their room closes now, so the list reaches its opening
 * state by itself), and the conversation pane (`pane`)
 * clears to the page's cream by `cleared`. Only then, from `in` to `to`, a
 * copy of the window's own content as it stands at t=0 (the views rendered on
 * a clock held at 0, its elements written with frame(0)) fades in over it, so
 * no frame ever shows two conversations at once: under the pane the copy
 * lands on the clean cover, and everywhere else the live window already shows
 * what the copy does. The film's last frame is its first, and the loop hands
 * from the copy to the live window with nothing changing on screen.
 * `SEAM_GHOST.mount` is when the copy is mounted (hidden), well before it is
 * seen, so its first render never lands on a frame that shows it.
 */
export const SEAM_GHOST = {
  surfaces: CAMERA[0].sees,
  /** The regions of the opening window whose content changes back: the open conversation's header and transcript. */
  pane: ["header", "transcript"],
  mount: DURATION - 3.4,
  from: SEAM_HOME,
  cleared: DURATION - 1.2,
  in: DURATION - 1.05,
  to: DURATION - 0.45,
} as const;

/** How far the pane's cover has cleared the live conversation at t (0 outside the seam). */
export const coverOpacity = (t: number): number => (t < SEAM_GHOST.from ? 0 : fade(clamp((t - SEAM_GHOST.from) / (SEAM_GHOST.cleared - SEAM_GHOST.from))));

/** How much of the seam's copy shows over the opening's windows at t (0 outside the seam). */
export const ghostOpacity = (t: number): number => (t < SEAM_GHOST.in ? 0 : fade(clamp((t - SEAM_GHOST.in) / (SEAM_GHOST.to - SEAM_GHOST.in))));

const SURFACE_INDEX = Object.fromEntries(SURFACES.map((s, i) => [s.id, i])) as Record<SurfaceId, number>;

/* ── A move dissolves from the windows it leaves to the ones it reaches ── */

const FADE_IN = 0.35;
const FADE_OUT = 0.45;

/**
 * How far the page reaches beyond either side of the box, in stage px, when
 * the driver has not said (tests, the prerender): a 1440x900 screen's on a
 * desktop, a phone's gutter on a phone. The driver passes the visitor's own
 * (HeroFlythrough `side`), so a window's fade happens beyond the page they
 * can actually see.
 */
export const PAGE_SIDE = { desktop: 458, mobile: 60 } as const;
const sideOf = (mobile: boolean, side?: number) => side ?? PAGE_SIDE[mobile ? "mobile" : "desktop"];

/**
 * How a move brings in and takes away the windows only one of its ends is
 * about, per framing and page width, solved once each on first use.
 *
 * A window arriving is carried in from beyond the side of the page: if the
 * pan alone would have it on the page as the move sets off (the band keeps
 * neighbours close, so the page is never empty mid-move), it starts slid out
 * along its own width to just past the page's edge (`dx`, in its own px) and
 * eases into its place by SLIDE of the move, coming on with the pan. A window
 * leaving is taken off the same way, sliding out over the last SLIDE of the
 * move when the pan alone would leave it on the page as the move lands.
 * Either way its fade (`from` to `to`) happens wholly beyond the page's edge,
 * where nobody sees it: a window is opaque whenever any of it is on the page.
 */
type Passage = { dx: number; from: number; to: number; u0: number; u1: number; pow: number };
const PASSAGES = new Map<string, Partial<Record<SurfaceId, Passage>>[]>();
/** Room kept past the page's edge, as a share of the window's width: its shadow's spread and a little more. */
const EDGE_PAD = 0.08;
const TOUCH_GAP = 0.02;
/**
 * Each move's slides are solved, not set: the gentlest slide (the largest
 * share of the move, the softest ease) that keeps the middle of the move at
 * least COVER_MIN as filled as the sparser of its two holds, while no carried
 * window crosses the page faster than SLIDE_SPEED. An arriving window is in
 * place by `share` of the move and a leaving one sets off at 1 - `share`, so
 * a short share fills the middle of the move with both ends.
 */
const SHARES = Array.from({ length: 23 }, (_, k) => Math.round((0.95 - k * 0.025) * 1000) / 1000);
const POWS = [2, 2.2, 2.4, 2.6, 2.8, 3.1, 3.4];
const COVER_MIN = { desktop: 0.6, mobile: 0.55 } as const;
/** The widest band of the box, as a share of its width, a move may leave empty: the next windows are in as the last ones leave. */
const GAP_MAX = 0.25;
/** Stage px per 1/60s: under the jump detector's 44 (filmQa LIMITS.rectPx), with room for the pan it rides on. */
const SLIDE_SPEED = 42;
export const __judge = (i: number, m: boolean, r: number, sh: number, pw: number) => judgeMove(i, m, r, solveMove(i, m, r, sh, pw));
/**
 * A carried window's slide, as a share of its offset still to go (arriving)
 * or gone (leaving) at progress p of its slide. An arriving window leaves its
 * mark beyond the page's edge at full speed and decelerates into place with
 * the camera; a leaving one sets off from rest and is at full speed only once
 * it is past the edge, so the fast part of every slide is where nobody sees it.
 */
const slideShare = (arriving: boolean, p: number, pow: number) => (arriving ? (1 - clamp(p)) ** pow : clamp(p) ** pow);
/**
 * The widest page (stage px beyond either side of the box) a move clears
 * before it lets a window fade: a 1536x864 laptop's, which covers 1280x800,
 * 1440x900 and 1920x1080 too. Clearing a wider page takes slides faster
 * than an eye can follow in the time a move has; there (1366x768 reaches
 * 726) a window comes and goes in the page's outermost strip.
 */
const CLEAR_SIDE_MAX = 620;
/** The shortest a carried window's fade takes, all of it beyond the page's edge (s). */
const CARRY_FADE = 0.06;
/** Room (stage px) a window carried in or off keeps from the box's top and bottom while any of it is on the page. */
const TALL_CLEAR = 4;

/** A surface's corners in world space, slid `dx` world px along the world's x (its depth kept, so a turned window keeps its size) and lowered `down` of its own px. */
function cornersMoved(id: SurfaceId, dx: number, down: number): V3[] {
  const s = SURFACE_BY_ID[id];
  if (Math.abs(dx) < 0.001 && down <= 0.001) return CORNERS_OF[SURFACE_INDEX[id]];
  return CORNERS.map(([lx, ly]) => {
    const [x, y, z] = localToWorld(id, (lx * s.w) / 2, (ly * s.h) / 2 + down);
    return [x + dx, y, z];
  });
}

/** A slide of `dx` world px along x in a surface's own px (what its card's translate3d takes inside its turn and zoom). */
const UNTURN = Object.fromEntries(
  SURFACES.map((s) => {
    const turn = rotation(s.rot);
    const axes = [turn([1, 0, 0]), turn([0, 1, 0]), turn([0, 0, 1])];
    return [s.id, (dx: number): V3 => axes.map((a) => (a[0] * dx) / (s.zoom ?? 1)) as V3];
  }),
) as Record<SurfaceId, (dx: number) => V3>;

/** One move's passages for a page reaching `reach` past the box, with a slide of `share` and ease `pow`. */
function solveMove(i: number, mobile: boolean, reach: number, share: number, pow: number): Partial<Record<SurfaceId, Passage>> {
  const w = mobile ? STAGE_SIZE.mobile.w : STAGE_SIZE.desktop.w;
  const [px0, px1] = [-reach, w + reach];
  const crests = crestsFor(mobile);
  const [h, next] = [CAMERA[i], CAMERA[i + 1]];
  const span = next.t0 - h.t1;
  const at = (u: number) => projector(transitPose(i, clamp(u), mobile, crests[i]), mobile);
  const boxOf = (id: SurfaceId, u: number, dx: number) => bounds(cornersMoved(id, dx, 0), at(u));
  const boxH = mobile ? STAGE_SIZE.mobile.h : STAGE_SIZE.desktop.h;
  const padOf = (b: Bounds) => (b.x1 - b.x0) * EDGE_PAD;
  const onPage = (b: Bounds | null) => !b || (b.x1 + padOf(b) > px0 && b.x0 - padOf(b) < px1);
  /** The slide (own px) that puts a window just past the page's edge on its own side at u, or 0 when it is past it already. */
  const clearAt = (id: SurfaceId, u: number) => {
    const b = boxOf(id, u, 0);
    if (!b || !onPage(b)) return 0;
    const dir = (b.x0 + b.x1) / 2 >= w / 2 ? 1 : -1;
    let [lo, hi] = [0, 6000];
    for (let r = 0; r < 30; r++) {
      const mid = (lo + hi) / 2;
      if (onPage(boxOf(id, u, dir * mid))) lo = mid;
      else hi = mid;
    }
    return dir * hi;
  };
  const passages: Partial<Record<SurfaceId, Passage>> = {};
  const steps = Math.max(40, Math.ceil(span * 120));
  const [hs, ns] = [seesOf(h, mobile), seesOf(next, mobile)];
  for (const id of new Set([...hs, ...ns])) {
    const [a, b] = [hs.includes(id), ns.includes(id)];
    if (a && b) continue;
    const arriving = b;
    // A window that would reach past the box's top or bottom while on the page (near a move's end the camera is too close for a tall one) is held beyond the page's edge until the camera has drawn back, or taken off before it closes in.
    const tall = (bx: Bounds | null) => !!bx && onPage(bx) && (bx.y0 < EDGE_CLEAR + TALL_CLEAR || bx.y1 > boxH - EDGE_CLEAR - TALL_CLEAR);
    const { fadeIn = FADE_IN, fadeOut = FADE_OUT } = SURFACE_BY_ID[id];
    // When it may come onto the page (arriving) or must be off it (leaving), and the part of the move its slide takes.
    let [wait, by] = [0, 1];
    if (arriving) {
      for (let k = steps; k >= 0; k--) if (tall(boxOf(id, k / steps, 0))) { wait = Math.min(0.75, (k + 1) / steps); break; }
    } else {
      for (let k = 0; k <= steps; k++) if (tall(boxOf(id, k / steps, 0))) { by = Math.max(0.25, (k - 1) / steps); break; }
    }
    let dx = 0;
    let [u0, u1] = [0, 1];
    const slideAt = (u: number) => dx * slideShare(arriving, (u - u0) / (u1 - u0), pow);
    // Slid out along its width, a turned window's far edge comes nearer the eye: wait (or leave) a step longer until the slid path stays inside the box's height too.
    for (let round = 0; round < 40; round++) {
      [u0, u1] = arriving ? [wait, wait + (1 - wait) * share] : [by * (1 - share), by];
      // Far enough to be past the page's edge for as long as it waits there, and for its fade, which happens there.
      dx = 0;
      // Past it a little after the slide sets off (arriving) and before it stops (leaving) too: a slide starts and stops at speed, which only beyond the edge goes unseen.
      const [held, gone] = [Math.min(1, wait + CARRY_FADE / span), Math.max(0, by - CARRY_FADE / span)];
      for (let k = 0; k <= 8; k++) {
        const c = clearAt(id, arriving ? (held * k) / 8 : gone + ((1 - gone) * k) / 8);
        if (Math.abs(c) > Math.abs(dx)) dx = c;
      }
      // The slide is already under way by then: further, until the slid path is still past the edge when the fade is done.
      const away = (k: number) => !onPage(boxOf(id, k / steps, slideAt(k / steps)));
      for (let r = 0; r < 60 && dx !== 0; r++) {
        let clear = true;
        for (let k = 0; k <= steps && clear; k++) if (arriving ? k / steps <= held : k / steps >= gone) clear = away(k);
        if (clear) break;
        dx *= 1.03;
      }
      let crossed = false;
      for (let k = 0; k <= steps && !crossed; k++) crossed = tall(boxOf(id, k / steps, slideAt(k / steps)));
      if (!crossed) break;
      if (arriving) wait = Math.min(0.75, wait + 0.02);
      else by = Math.max(0.25, by - 0.02);
    }
    const shownAt = (u: number) => onPage(boxOf(id, u, slideAt(u)));
    // The moment between u0 and u1 where the window crosses the page's edge.
    const edge = (u0: number, u1: number) => {
      const s0 = shownAt(u0);
      for (let r = 0; r < 24; r++) {
        const mid = (u0 + u1) / 2;
        if (shownAt(mid) === s0) u0 = mid;
        else u1 = mid;
      }
      return h.t1 + ((u0 + u1) / 2) * span;
    };
    if (arriving) {
      let k = 0;
      while (k <= steps && !shownAt(k / steps)) k++;
      const to = k === 0 ? h.t1 + fadeIn : k > steps ? next.t0 : Math.max(h.t1 + 1e-3, edge((k - 1) / steps, k / steps) - TOUCH_GAP);
      passages[id] = { dx, u0, u1, pow, from: k === 0 ? h.t1 : Math.max(h.t1, to - fadeIn), to };
    } else {
      let k = steps;
      while (k >= 0 && !shownAt(k / steps)) k--;
      const from = k === steps ? next.t0 - fadeOut : k < 0 ? h.t1 : Math.min(next.t0 - 1e-3, edge((k + 1) / steps, k / steps) + TOUCH_GAP);
      passages[id] = { dx, u0, u1, pow, from, to: Math.min(next.t0, from + fadeOut) };
    }
  }
  return passages;
}

/**
 * How a candidate slide does across its move: the least share of the box the
 * move's windows cover over the sparser of its holds, and the fastest a
 * carried window crosses the page (stage px per 1/60s).
 */
function judgeMove(i: number, mobile: boolean, reach: number, ps: Partial<Record<SurfaceId, Passage>>): { cover: number; speed: number; gap: number } {
  const { w, h: bh } = mobile ? STAGE_SIZE.mobile : STAGE_SIZE.desktop;
  const crests = crestsFor(mobile);
  const [h, next] = [CAMERA[i], CAMERA[i + 1]];
  const span = next.t0 - h.t1;
  const ids = [...new Set([...seesOf(h, mobile), ...seesOf(next, mobile)])];
  const slid = (id: SurfaceId, u: number) => {
    const p = ps[id];
    return p ? p.dx * slideShare(seesOf(next, mobile).includes(id), (u - p.u0) / (p.u1 - p.u0), p.pow) : 0;
  };
  const frameAt = (u: number) => {
    const at = projector(transitPose(i, clamp(u), mobile, crests[i]), mobile);
    return ids.map((id) => {
      const pts = cornersMoved(id, slid(id, u), 0).map((c) => at(c));
      return { id, pts, b: bounds(cornersMoved(id, slid(id, u), 0), at) };
    });
  };
  const coverOf = (bs: { b: Bounds | null }[]) =>
    bs.reduce((a, { b }) => a + (b ? (Math.max(0, Math.min(w, b.x1) - Math.max(0, b.x0)) * Math.max(0, Math.min(bh, b.y1) - Math.max(0, b.y0))) / (w * bh) : 0), 0);
  const [c0, c1] = [coverOf(frameAt(0).filter(({ id }) => seesOf(h, mobile).includes(id))), coverOf(frameAt(1).filter(({ id }) => seesOf(next, mobile).includes(id)))];
  const n = Math.ceil(span * 60);
  let [cover, speed, gap] = [Infinity, 0, 0];
  let prev = frameAt(0);
  for (let k = 1; k <= n; k++) {
    const cur = frameAt(k / n);
    cover = Math.min(cover, coverOf(cur) / Math.max(1e-6, Math.min(c0, c1)));
    // The widest band of the box, across its width, that no window reaches.
    const spans = cur.flatMap(({ b }) => (b && b.x1 > 0 && b.x0 < w ? [[Math.max(0, b.x0), Math.min(w, b.x1)]] : [])).sort((p, q) => p[0] - q[0]);
    let reached = 0;
    for (const [x0, x1] of spans) {
      gap = Math.max(gap, (x0 - reached) / w);
      reached = Math.max(reached, x1);
    }
    gap = Math.max(gap, (w - reached) / w);
    // A corner's pace on screen, as the jump detector measures it (filmQa rect speed), while any of the window is on the page.
    cur.forEach(({ id, b, pts }, j) => {
      const { b: a, pts: was } = prev[j];
      if (!ps[id] || !a || !b) return;
      const on = (x: Bounds) => x.x1 > -reach && x.x0 < w + reach;
      if (on(a) || on(b)) pts.forEach((p, c) => p && was[c] && (speed = Math.max(speed, Math.hypot(p.x - was[c]!.x, p.y - was[c]!.y))));
    });
    prev = cur;
  }
  return { cover, speed, gap };
}

/**
 * Each move's slide (share and ease) for a page reaching `reach` past the
 * box: the gentlest that keeps the move filled and every carried window under
 * SLIDE_SPEED; where none does, the slowest that still keeps the move at
 * its floor (coverFloor), and failing that the fullest.
 */
/** The fallback's floor, a little over the tests' (timeline.test PAGES), whose coverage also counts windows lifting out: half up to a 1440x900 page, a little less beyond. */
const coverFloor = (reach: number) => (reach <= 460 ? 0.53 : 0.48);
export function slidesFor(mobile: boolean, reach: number): { share: number; pow: number }[] {
  const key = mobile ? "mobile" : "desktop";
  return CAMERA.slice(0, -1).map((_, i) => {
    type Judged = { cover: number; speed: number; gap: number };
    let best: ({ share: number; pow: number } & Judged) | null = null;
    // Under the speed limit first, then the narrowest empty band, then the fullest.
    const score = (j: Judged) => (j.speed <= SLIDE_SPEED ? 0 : 10) + Math.max(0, j.gap - GAP_MAX) * 4 + Math.max(0, coverFloor(reach) - j.cover);
    const better = (a: Judged, b: Judged) => score(a) < score(b) || (score(a) === score(b) && a.speed < b.speed);
    for (const share of SHARES) {
      for (const pow of POWS) {
        const j = judgeMove(i, mobile, reach, solveMove(i, mobile, reach, share, pow));
        if (j.cover >= COVER_MIN[key] && j.speed <= SLIDE_SPEED && j.gap <= GAP_MAX) return { share, pow };
        if (!best || better(j, best)) best = { share, pow, ...j };
      }
    }
    return { share: best!.share, pow: best!.pow };
  });
}

/**
 * The page reaches a move's passages are solved for. A visitor takes the
 * first anchor at or beyond their own page's reach, whose windows clear at
 * least as far as theirs need: a page between two anchors carries its windows
 * a little further than it must, beyond its edge where nobody sees it.
 */
export const SLIDE_ANCHORS = { desktop: [160, 320, 460, 540, 600, CLEAR_SIDE_MAX], mobile: [PAGE_SIDE.mobile] } as const;
/** The anchor a page reaching `side` stage px past the box uses. */
export function anchorOf(mobile: boolean, side: number): number {
  const anchors = SLIDE_ANCHORS[mobile ? "mobile" : "desktop"];
  return anchors.find((a) => a >= side) ?? anchors[anchors.length - 1];
}

/** Every move's passages at an anchor, solved: what PASSAGE_TABLE holds. */
export function solvePassages(mobile: boolean, anchor: number): Partial<Record<SurfaceId, Passage>>[] {
  const slides = slidesFor(mobile, anchor);
  return CAMERA.slice(0, -1).map((_, i) => solveMove(i, mobile, anchor, slides[i].share, slides[i].pow));
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** One anchor's passages as a PASSAGE_TABLE row: moves split by "|", each window as "id dx u0 u1 pow from to". */
export const passageRow = (ps: Partial<Record<SurfaceId, Passage>>[]): string =>
  ps.map((m) => Object.entries(m).map(([id, p]) => [id, p!.dx, p!.u0, p!.u1, p!.pow, p!.from, p!.to].map((v) => (typeof v === "number" ? r4(v) : v)).join(" ")).join(",")).join("|");
const parseRow = (row: string): Partial<Record<SurfaceId, Passage>>[] =>
  row.split("|").map((m) =>
    Object.fromEntries(
      m ? m.split(",").map((e) => {
        const [id, ...v] = e.split(" ");
        const [dx, u0, u1, pow, from, to] = v.map(Number);
        return [id, { dx, u0, u1, pow, from, to }];
      }) : [],
    ),
  );

/**
 * Every move's passages at each anchor (solvePassages), so a page load and a
 * resize solve nothing: solving one anchor costs a few hundred ms of CPU,
 * several times that on a phone. timeline.test.ts keeps this table equal to
 * the solver and prints the rows to paste when the world or the camera moves.
 */
export const PASSAGE_TABLE: Record<string, string> = {
  "d:160": "||desk -202.4858 0.0478 0.9554 2 18.186 18.3,pairA 0 0 0.95 2 16.7822 17.1322,pairB 227.0935 0 0.95 2 16.5 16.5505|pairB -259.549 0.05 1 2 22.6429 22.7,phone 151.3552 0 0.95 2 20.8 20.8548|phone 156.4843 0.05 1 2 30.9514 31,pairB -241.9469 0 0.95 2 29.3 29.3498|pairA 0 0.05 1 2.8 36.9558 37.4058,pairB 209.3483 0.05 1 2.8 37.7933 37.85,desk -322.3066 0.1745 0.9587 2.8 35.2638 35.6138|desk 268.3918 0.0435 0.8708 2.4 43.3517 43.65,board -219.9933 0 0.95 2.4 41.65 41.6967|board 164.3236 0.05 1 2 49.454 49.5,auto -147.2227 0 0.95 2 47.8 47.8458|auto 212.8673 0.05 1 2 55.3519 55.4,team -148.2689 0 0.95 2 53.7 53.7459|team -484.1249 0.4518 0.753 3.4 62.066 62.516,pr 305.7955 0.1339 0.4804 3.4 60.0691 60.4191|pr -292.404 0.46 0.8 3.4 68.6576 69.1076,page 273.2412 0 0.425 3.4 66.7 66.7425|page -324.7463 0.05 1 2 75.7432 75.8,palette 54.3555 0 0.95 2 73.9 73.947|palette 149.0405 0.05 1 2 79.5519 79.6,blame -192.252 0 0.95 2 77.9 77.9481|blame -250.6564 0.05 1 3.4 83.15 83.2,desk 254.3495 0.2038 0.9602 3.4 81.1369 81.4869|",
  "d:320": "||desk -402.8355 0.0468 0.9354 2.8 18.1396 18.3,pairA 0 0 0.95 2.8 16.61 16.96,pairB 442.8636 0 0.95 2.8 16.5 16.5494|pairB -415.6144 0.05 1 2 22.6426 22.7,phone 354.0486 0 0.95 2 20.8 20.8564|phone 358.3784 0.05 1 2 30.9506 31,pairB -393.2688 0 0.95 2 29.3 29.3498|pairA 0 0.55 1 2.6 37.1887 37.6387,pairB 420.0489 0.55 1 2.6 37.8022 37.85,desk -585.0055 0.1945 0.557 2.6 35.3217 35.6717|desk 497.1199 0.283 0.8708 3.4 43.3518 43.65,board -461.4977 0 0.675 3.4 41.65 41.6979|board 347.5131 0.05 1 2.4 49.4611 49.5,auto -322.6556 0 0.95 2.4 47.8 47.8389|auto 405.0293 0.05 1 2.4 55.3613 55.4,team -317.7529 0 0.95 2.4 53.7 53.7389|team -644.5442 0.3388 0.753 3.1 62.0654 62.5154,pr 496.0577 0.1339 0.6103 3.1 60.0667 60.4167|pr -501.7163 0.48 0.8 3.4 68.6599 69.1099,page 500.2491 0 0.4 3.4 66.7 66.7391|page -553.7511 0.05 1 3.1 75.7527 75.8,palette 219.0841 0 0.95 3.1 73.9 73.9459|palette 317.8503 0.05 1 2.2 79.5566 79.6,blame -377.1916 0 0.95 2.2 77.9 77.9434|blame -491.844 0.475 1 3.1 83.156 83.2,desk 476.1019 0.2038 0.6218 3.1 81.1379 81.4879|",
  "d:460": "||desk -589.1038 0.1602 0.9154 3.4 18.1093 18.3,pairA 0 0 0.825 3.4 16.5 16.7148,pairB 645.8809 0 0.825 3.4 16.5 16.543|pairB -549.4011 0.05 1 2 22.6425 22.7,phone 533.8533 0 0.95 2 20.8 20.8569|phone 536.9148 0.05 1 2 30.9504 31,pairB -522.6588 0 0.95 2 29.3 29.3499|pairA 0 0.425 1 2 37.4531 37.85,pairB 557.6019 0.425 1 2 37.8022 37.85,desk -756.9105 0.2145 0.6662 2 35.3764 35.7264|desk 655.491 0.4136 0.8708 2.2 43.3521 43.65,board -637.2885 0 0.525 2.2 41.65 41.6976|board 539.9876 0.05 1 3.4 49.4524 49.5,auto -504.9208 0 0.95 3.4 47.8 47.8475|auto 609.4123 0.05 1 3.4 55.3519 55.4,team -492.8998 0 0.95 3.4 53.7 53.7475|team -772.4854 0.3577 0.753 2.2 62.0697 62.5197,pr 667.196 0.1339 0.5886 2.2 60.0702 60.4202|pr -626.7519 0.42 0.8 2.8 68.6612 69.1112,page 660.7369 0 0.475 2.8 66.7 66.741|page -770.689 0.175 1 3.4 75.7535 75.8,palette 372.8578 0 0.825 3.4 73.9 73.9459|palette 477.624 0.05 1 3.1 79.5596 79.6,blame -556.9508 0 0.95 3.1 77.9 77.9404|blame -651.3379 0.4 1 2.4 83.1567 83.2,desk 610.6645 0.2038 0.6815 2.4 81.1401 81.4901|",
  "d:540": "||desk -679.1974 0.3204 0.9154 2.8 18.1116 18.3,pairA 59.1788 0 0.65 2.8 16.5 16.5401,pairB 754.8948 0 0.65 2.8 16.5 16.5401|pairB -624.7194 0.05 1 2 22.6425 22.7,phone 637.6426 0 0.95 2 20.8 20.8571|phone 639.7336 0.05 1 2 30.9504 31,pairB -595.368 0 0.95 2 29.3 29.3499|pairA 0 0.325 1 2 37.7385 37.85,pairB 649.3205 0.325 1 2 37.7916 37.85,desk -848.6549 0.2145 0.7447 2 35.3818 35.7318|desk 754.1307 0.3919 0.8708 2 43.3459 43.65,board -724.2853 0 0.55 2 41.65 41.6929|board 638.4119 0.1 1 3.4 49.4555 49.5,auto -597.745 0 0.9 3.4 47.8 47.8445|auto 712.6723 0.1 1 3.4 55.3552 55.4,team -581.291 0 0.9 3.4 53.7 53.7445|team -866.2177 0.3388 0.753 2 62.0642 62.5142,pr 774.0572 0.1339 0.6103 2 60.0779 60.4279|pr -722.5308 0.48 0.8 2 68.6546 69.1046,page 769.6921 0 0.4 2 66.7 66.7507|page -886.3184 0.25 1 3.4 75.7594 75.8,palette 457.0606 0 0.75 3.4 73.9 73.9406|palette 579.5708 0.05 1 3.4 79.5518 79.6,blame -673.5731 0 0.95 3.4 77.9 77.9482|blame -759.2002 0.4 1 2 83.1452 83.2,desk 682.0709 0.2038 0.6815 2 81.1385 81.4885|",
  "d:600": "||desk -744.922 0.3134 0.8954 2 18.0716 18.3,pairA 137.5653 0 0.65 2 16.5 16.5448,pairB 812.5646 0 0.65 2 16.5 16.5466|pairB -680.6783 0.05 1 2 22.6424 22.7,phone 715.9893 0 0.95 2 20.8 20.8572|phone 717.2324 0.05 1 2.2 30.9563 31,pairB -649.3263 0 0.95 2.2 29.3 29.3437|pairA 58.8846 0.175 1 2 37.8074 37.85,pairB 696.8897 0.175 1 2 37.8046 37.85,desk -943.3686 0.2345 0.866 2 35.43 35.78|desk 803.9297 0.3483 0.8708 2 43.3517 43.65,board -803.7306 0 0.6 2 41.65 41.6982|board 712.4859 0.15 1 3.4 49.4587 49.5,auto -667.3159 0 0.85 3.4 47.8 47.8413|auto 790.3887 0.15 1 3.4 55.3586 55.4,team -647.2841 0 0.85 3.4 53.7 53.7413|team -936.2706 0.2824 0.753 2 62.0588 62.5088,pr 829.7031 0.1339 0.6752 2 60.0694 60.4194|pr -771.2288 0.44 0.8 2 68.6572 69.1072,page 827.0025 0 0.45 2 66.7 66.7444|page -1002.808 0.3 1 3.4 75.7525 75.8,palette 535.8623 0 0.7 3.4 73.9 73.947|palette 644.9033 0.1 1 3.4 79.5552 79.6,blame -748.8809 0 0.9 3.4 77.9 77.9448|blame -815.9031 0.3 1 2 83.1536 83.2,desk 748.6706 0.2038 0.7611 2 81.1448 81.4948|",
  "d:620": "||desk -766.7767 0.291 0.8954 2 18.07 18.3,pairA 164.3222 0 0.675 2 16.5 16.5468,pairB 839.1701 0 0.675 2 16.5 16.549|pairB -699.2314 0.05 1 2.2 22.6491 22.7,phone 742.2017 0 0.95 2.2 20.8 20.8507|phone 743.139 0.05 1 2.2 30.9563 31,pairB -667.2044 0 0.95 2.2 29.3 29.3437|pairA 81.1126 0.15 1 2 37.8061 37.85,pairB 718.9926 0.15 1 2 37.8028 37.85,desk -965.9354 0.2345 0.8852 2 35.4309 35.7809|desk 827.8395 0.3266 0.8708 2 43.3499 43.65,board -830.2653 0 0.625 2 41.65 41.7008|board 737.2262 0.15 1 3.4 49.4587 49.5,auto -690.4973 0 0.85 3.4 47.8 47.8413|auto 816.3461 0.175 1 3.4 55.3603 55.4,team -669.2249 0 0.825 3.4 53.7 53.7397|team -959.5749 0.2824 0.753 2 62.0588 62.5088,pr 855.8397 0.1339 0.6752 2 60.0694 60.4194|pr -794.4765 0.44 0.8 2 68.6572 69.1072,page 853.6539 0 0.45 2 66.7 66.7444|page -1032.8854 0.325 1 3.4 75.7549 75.8,palette 557.5671 0 0.675 3.4 73.9 73.9448|palette 666.6086 0.1 1 3.4 79.5552 79.6,blame -774.0549 0 0.9 3.4 77.9 77.9448|blame -842.2276 0.275 1 2 83.1514 83.2,desk 770.8147 0.2038 0.781 2 81.1463 81.4963|",
  "m:60": "||desk -216.6516 0.4233 0.7696 3.4 17.8471 18.2971,pairA 0 0 0.45 3.4 17.3916 17.7416,pairB 13.4078 0 0.45 3.4 16.5 16.5404|pairA -142.5597 0.6 1 3.4 22.6567 22.7,pairB 0 0.6 1 3.4 21.8085 22.2585,phone 0 0 0.4 3.4 21.3301 21.6801|phone 0 0.6 1 3.4 30.1974 30.6474,pairA -139.3137 0 0.4 3.4 29.3 29.3426,pairB 0 0 0.4 3.4 29.7774 30.1274|pairA 0 0.6 1 3.4 35.9394 36.3894,pairB 0 0.6 1 3.4 37.0016 37.4516,desk -236.9541 0.2212 0.5327 3.4 35.3969 35.7469|desk 0 0.05 1 2 42.9115 43.3615,board 0 0 0.95 2 41.8457 42.1957|board 0 0.05 1 2 48.8368 49.2868,auto 0 0 0.95 2 47.8 47.9568|auto 0 0.05 1 2 54.6832 55.1332,team 0 0 0.95 2 53.7 53.8053|team 0 0.05 1 2 62.5117 62.8,pr 0 0 0.95 2 60.8411 61.1911|pr 0 0.05 1 2 68.835 69.2,page 0 0 0.95 2 67.2895 67.6395|page -54.0357 0.45 1 2.6 75.7526 75.8,palette 0 0 0.55 2.6 74.2889 74.6389|palette 0 0.05 1 2 78.9042 79.3542,blame 0 0 0.95 2 77.9 78.0474|blame -17.7158 0.05 1 2 83.1598 83.2,desk 0 0 0.95 2 81.598 81.948|",
};

function passagesFor(mobile: boolean, side: number): Partial<Record<SurfaceId, Passage>>[] {
  const key = `${mobile ? "m" : "d"}:${anchorOf(mobile, side)}`;
  let hit = PASSAGES.get(key);
  if (!hit) PASSAGES.set(key, (hit = PASSAGE_TABLE[key] ? parseRow(PASSAGE_TABLE[key]) : solvePassages(mobile, anchorOf(mobile, side))));
  return hit;
}

/** The move under way at t: its index, how far through it is, and the hold it leaves and the one it reaches. */
function moveAt(t: number): { i: number; u: number; h: Hold; next: Hold } | null {
  for (let i = 0; i + 1 < CAMERA.length; i++) {
    const [h, next] = [CAMERA[i], CAMERA[i + 1]];
    if (t > h.t1 && t < next.t0) return { i, u: (t - h.t1) / (next.t0 - h.t1), h, next };
  }
  return null;
}

/** How far a window is slid along the world's x at t (world px) while a move carries it in or takes it off. */
function slideOf(id: SurfaceId, t: number, mobile = false, side?: number): number {
  const m = moveAt(t);
  if (!m) return 0;
  const p = passagesFor(mobile, sideOf(mobile, side))[m.i][id];
  if (!p || p.dx === 0) return 0;
  return p.dx * slideShare(seesOf(m.next, mobile).includes(id), (m.u - p.u0) / (p.u1 - p.u0), p.pow);
}

/**
 * Opacity of a surface across the camera's path. A hold shows only the
 * surfaces it is about, so nothing sits idle at the page's edges while a
 * chapter holds. A move shows both ends, the windows it leaves carried off
 * the side of the page and the ones it reaches carried in, each wholly
 * opaque while any of it is on the page (passagesFor). A surface neither hold
 * is about stays hidden.
 */
function transitOpacity(id: SurfaceId, t: number, mobile = false, side?: number): number {
  for (let i = 0; i < CAMERA.length; i++) {
    const h = CAMERA[i];
    if (t >= h.t0 && t <= h.t1) return seesOf(h, mobile).includes(id) ? 1 : 0;
    const next = CAMERA[i + 1];
    if (!next || t <= h.t1 || t >= next.t0) continue;
    const [a, b] = [seesOf(h, mobile).includes(id), seesOf(next, mobile).includes(id)];
    if (a && b) return 1;
    if (!a && !b) return 0;
    const r = passagesFor(mobile, sideOf(mobile, side))[i][id]!;
    const k = glide(clamp((t - r.from) / Math.max(1e-6, r.to - r.from)));
    return b ? k : 1 - k;
  }
  return 0;
}

/** How far a surface with `rise` has to go: 1 out of view, 0 in place, following its own fade. */
const riseOf = (id: SurfaceId, t: number, mobile = false, side?: number) => (SURFACE_BY_ID[id].rise ? 1 - transitOpacity(id, t, mobile, side) : 0);

/**
 * A contact shadow: just behind its surface and a little below, so the
 * surface reads as resting on the page, never far enough back to slide into
 * frame on its own while its surface is out of it. `h` is the surface's
 * height above the page plane (z = -420): high surfaces cast a wider, softer
 * one; low ones a tight one.
 */
const PAGE_Z = -420;
function shadowOf(s: (typeof SURFACES)[number], [sx, sy, sz]: V3 = [0, 0, 0]): El {
  const h = s.pos[2] - PAGE_Z;
  // Held behind the surface by as far as its tilt swings its edges, so no part of the shadow pokes through it.
  const tilt = Math.sin((Math.max(Math.abs(s.rot[0]), Math.abs(s.rot[1])) * Math.PI) / 180) * (Math.max(s.w, s.h) / 2);
  const clear = 12 + tilt * 1.1;
  const scale = 1 + h / 2400;
  return {
    transform: `translate3d(${r3(sx)}px, ${r3(sy + 6 + h * 0.02)}px, ${r3(sz - (clear + 24 + h * 0.05))}px) scale(${r3(scale)})`,
    opacity: r3(clamp(0.3 - (0.12 * h) / 600, 0.08, 0.3) / 0.3),
  };
}

/* ── What the camera can see, and the edge rule ───────────────────────── */

/**
 * Nothing clips the film (HeroFlythrough BLEED), so above and below it is the
 * page itself: the headline, the nav, the chapter bar. At every moment a
 * window that reaches the page's width is wholly inside the box's height, or
 * it is not shown. The sides are open: the bleed runs to the browser's edges,
 * about 700 stage px either side of the box on a 2560px screen (350 at
 * 1440); a phone shows a gutter. PAGE_X is how far the page reaches.
 */
export const PAGE_X = { desktop: [-700, 1980], mobile: [-60, 700] } as const;
const boxH = (mobile: boolean) => (mobile ? STAGE_SIZE.mobile.h : STAGE_SIZE.desktop.h);
/** How close to the top or bottom a window may come before it counts as outside. */
const EDGE_CLEAR = 2;

type Bounds = { x0: number; x1: number; y0: number; y1: number };

const CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

/** Each surface's corners in world space. */
const CORNERS_OF = SURFACES.map((s) => CORNERS.map(([lx, ly]) => localToWorld(s.id, (lx * s.w) / 2, (ly * s.h) / 2)));

/** A surface's corners at t, slid while a move carries it and lowered by its rise while it comes or goes (the card's transform in `frame`). */
function cornersAt(i: number, t: number, mobile: boolean, side?: number): V3[] {
  const s = SURFACES[i];
  return cornersMoved(s.id, slideOf(s.id, t, mobile, side), (s.rise ?? 0) * riseOf(s.id, t, mobile, side));
}

/** The stage box of a card's corners, or null when part of it is behind the eye. */
function bounds(corners: V3[], at: (pt: V3) => { x: number; y: number } | null): Bounds | null {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const c of corners) {
    const p = at(c);
    if (!p) return null;
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, x1, y0, y1 };
}

const STEP = 1 / 20;
/** A rendered surface stays mounted this long either side of the moments it reaches the page, so a seek between samples never shows a gap. */
const LIVE_PAD = 0.3;
/**
 * A window that would cross the top or bottom leaves as an object: it lifts
 * out (opacity to 0, scale to 0.95, easing both ways) over LIFT_OUT before the first
 * moment it would touch the edge, and drops back in (from 0.95)
 * over DROP_IN once it is wholly inside again. A held frame stays still, so a
 * lift-out waits for the camera to set off and a drop-in lands before it
 * stops, in no less than MIN_BEAT. Two absences closer than MIN_SHOWN merge,
 * so nothing blinks.
 */
const LIFT_OUT = 0.25;
const DROP_IN = 0.3;
const MIN_BEAT = 0.15;
const MIN_SHOWN = 0.9;
const AWAY_SCALE = 0.05;

/** An absence: the lift-out starts at `from`, the window is gone over [a, b], and the drop-in lands at `to`. */
type Away = { from: number; a: number; b: number; to: number };
type Track = { live: [number, number][][]; away: Away[][] };

function beats([a, b]: [number, number]): Away {
  let from = a - LIFT_OUT;
  let to = b + DROP_IN;
  for (const h of CAMERA) {
    if (h.t1 > from && h.t1 < a) from = Math.min(h.t1, a - MIN_BEAT);
    if (h.t0 < to && h.t0 > b) to = Math.max(h.t0, b + MIN_BEAT);
  }
  return { from, a, b, to };
}

const merge = (spans: [number, number][], gap: number): [number, number][] => {
  const out: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
};

/**
 * Sampled once per framing, on first use: for each surface, when any part of
 * it (its shadow's spread included) reaches the page, and when any part of it
 * would lie above or below the box while it is within the page's width. Both derive from the same projection the stage
 * draws, so what is rendered and what is shown follow what the camera sees.
 */
function buildTrack(mobile: boolean, side?: number): Track {
  // The visitor's own page: a window beyond its sides is neither drawn nor seen, whatever its height.
  const [px0, px1] = [-sideOf(mobile, side), (mobile ? STAGE_SIZE.mobile.w : STAGE_SIZE.desktop.w) + sideOf(mobile, side)];
  const h = boxH(mobile);
  const live: [number, number][][] = SURFACES.map(() => []);
  const away: [number, number][][] = SURFACES.map(() => []);
  const n = Math.ceil(DURATION / STEP);
  for (let k = 0; k <= n; k++) {
    const t = Math.min(k * STEP, DURATION - 1e-6);
    const at = projector(cameraAt(t, mobile).pose, mobile);
    SURFACES.forEach((_, i) => {
      const b = bounds(cornersAt(i, t, mobile, side), at);
      // Rendered while any of it reaches the page, its shadow's spread (5% either side) included.
      const [sx, sy] = b ? [(b.x1 - b.x0) * 0.05, (b.y1 - b.y0) * 0.05] : [0, 0];
      if (!b || (b.x1 + sx > px0 && b.x0 - sx < px1 && b.y1 + sy > 0 && b.y0 - sy < h)) live[i].push([Math.max(0, t - LIVE_PAD), Math.min(DURATION, t + LIVE_PAD)]);
      const sideways = b && (b.x1 <= px0 || b.x0 >= px1);
      // Only a window the camera's path shows can cross: one hidden at a hold (beside the window a hold is about) never needs to leave.
      const crossing = transitOpacity(SURFACES[i].id, t, mobile, side) > 0 && (!b || (!sideways && (b.y0 < EDGE_CLEAR || b.y1 > h - EDGE_CLEAR)));
      if (crossing) away[i].push([Math.max(0, t - STEP), Math.min(DURATION, t + STEP)]);
    });
  }
  return { live: live.map((s) => merge(s, 0)), away: away.map((s) => merge(s, MIN_SHOWN).map(beats)) };
}

const TRACKS = new Map<string, Track>();
/** Built per anchor (anchorOf), on the anchor's page: a window is rendered whenever any of it could reach that page, a superset of the visitor's. */
function track(mobile: boolean, side?: number): Track {
  const reach = sideOf(mobile, side);
  const anchors = SLIDE_ANCHORS[mobile ? "mobile" : "desktop"];
  // Past the widest anchor the page's own reach, to 40px, so the outermost strip of a very wide screen still renders what crosses it.
  const anchor = reach <= anchors[anchors.length - 1] ? anchorOf(mobile, reach) : Math.ceil(reach / 40) * 40;
  const key = `${mobile ? "m" : "d"}:${anchor}`;
  let tr = TRACKS.get(key);
  if (!tr) TRACKS.set(key, (tr = buildTrack(mobile, anchor)));
  return tr;
}

/** The hold under way at t, or null mid-move. A hold shows exactly the windows it is about, whole (timeline.test), so it needs neither the track nor the passages. */
const holdAt = (t: number): Hold | null => CAMERA.find((h) => t >= h.t0 && t <= h.t1) ?? null;

/** Builds what the moves need for a page (its passages and track) ahead of the first move, so no animation frame pays for it. */
export function warm(mobile: boolean, side?: number): void {
  track(mobile, side);
}

/** Whether a surface is rendered at t: some part of it reaches the page, and it is not away from the frame. */
export function isLive(id: SurfaceId, t: number, mobile = false, side?: number): boolean {
  const h = holdAt(t);
  if (h) return seesOf(h, mobile).includes(id);
  return track(mobile, side).live[SURFACE_INDEX[id]].some(([a, b]) => t >= a && t <= b) && presence(id, t, mobile, side).o > 0;
}

/** How present a window is at t (1 shown, 0 away) and the scale it wears while lifting out or dropping in. */
export function presence(id: SurfaceId, t: number, mobile = false, side?: number): { o: number; scale: number } {
  if (holdAt(t)) return { o: 1, scale: 1 };
  let o = 1;
  for (const { from, a, b, to } of track(mobile, side).away[SURFACE_INDEX[id]]) {
    if (t >= a && t <= b) return { o: 0, scale: 1 - AWAY_SCALE };
    // Both ease at each end, so the window neither blinks out at the last frame nor pops in at the first.
    if (t < a && t > from) o = Math.min(o, 1 - glide((t - from) / (a - from)));
    if (t > b && t < to) o = Math.min(o, glide((t - b) / (to - b)));
  }
  return { o, scale: 1 - AWAY_SCALE * (1 - o) };
}

/* ── Beats ────────────────────────────────────────────────────────────── */

export type El = { transform?: string; opacity?: number; dash?: number; visible?: boolean };

function beatState(b: Beat, t: number): { tf: string; o: number } {
  const s = t - b.cue;
  const dur = b.dur ?? 0.55;
  const p = clamp(s / dur);
  switch (b.preset) {
    case "drop": {
      const k = DROP(s);
      const y = b.y ?? -24;
      const z = b.z ?? 220;
      const rx = b.rx ?? -18;
      const inv = 1 - k;
      return {
        tf: inv === 0 ? "" : `perspective(800px) translate3d(0px, ${r3(y * inv)}px, ${r3(z * inv)}px) rotateX(${r3(rx * inv)}deg)`,
        o: clamp(s / 0.17),
      };
    }
    case "fadeIn":
      return { tf: "", o: fadeP(s, dur) };
    case "fadeOut":
      return { tf: "", o: 1 - fadeP(s, dur) };
    case "push":
    case "lift": {
      // A push shorter than a frame is a step, done from its cue on (the FLIP half of glideOver), so it never cancels its lift on the cue frame itself.
      const instant = b.preset === "push" && dur < 1 / 60;
      const inv = instant ? (s >= 0 ? 0 : 1) : 1 - (b.preset === "lift" ? glide(p) : glideOut(p));
      if (inv === 0) return { tf: "", o: 1 };
      return { tf: `translate3d(${r3((b.x ?? 0) * inv)}px, ${r3((b.y ?? 0) * inv)}px, 0px)`, o: 1 };
    }
    case "pulse": {
      if (p <= 0 || p >= 1) return { tf: "", o: 1 };
      return { tf: `scale(${r3(1 + (b.s ?? 0.12) * Math.sin(Math.PI * fade(p)))})`, o: 1 };
    }
    case "popIn": {
      // Never quicker than the spring's own pace, so the pop eases in rather than appearing grown.
      const k = SETTLE(s * Math.min(1.6, 0.6 / dur));
      const from = b.s ?? 0.6;
      return { tf: k >= 1 ? "" : `scale(${r3(from + (1 - from) * k)})`, o: fade(clamp(s / 0.25)) };
    }
    case "ring": {
      // At least 0.6s, rising in before it fades out as it grows.
      const q = clamp(s / Math.max(dur, 0.6));
      if (q <= 0 || q >= 1) return { tf: "scale(0.5)", o: 0 };
      const e = fade(q);
      return { tf: `scale(${r3(0.5 + 0.9 * e)})`, o: 0.5 * fade(clamp(q / 0.25)) * (1 - e) };
    }
    case "growX": {
      const from = b.s ?? 0;
      const e = glideOut(p);
      return { tf: e >= 1 ? "" : `scaleX(${r3(from + (1 - from) * e)})`, o: 1 };
    }
    case "growY": {
      const k = SNAP(s);
      return { tf: k >= 1 ? "" : `scaleY(${r3(k)})`, o: 1 };
    }
    case "liftOut": {
      const e = glideOut(p);
      return { tf: e <= 0 ? "" : `perspective(800px) translate3d(0px, ${r3((b.y ?? 0) * e)}px, ${r3((b.z ?? 80) * e)}px)`, o: 1 };
    }
    case "press": {
      if (p <= 0 || p >= 1) return { tf: "", o: 1 };
      return { tf: `scale(${r3(1 - 0.06 * Math.sin(Math.PI * p))})`, o: 1 };
    }
  }
}

/* ── Flyers ───────────────────────────────────────────────────────────── */

const fall = (u: number) => u * u * (3 - 2 * u) * 0.35 + u * u * 0.65;

function bezier3(a: V3, c: V3, b: V3, u: number): V3 {
  const v = 1 - u;
  return [0, 1, 2].map((k) => v * v * a[k] + 2 * v * u * c[k] + u * u * b[k]) as V3;
}

function flyerState(f: Flyer, t: number): El {
  const u0 = (t - f.cue) / f.dur;
  if (u0 <= 0 || u0 >= 1) return { opacity: 0, transform: "translate3d(0px, 0px, -2000px)" };
  const u = f.ease === "glide" ? glide(u0) : f.ease === "settle" ? settle(u0) : fall(u0);
  const mid: V3 = [(f.from[0] + f.to[0]) / 2, (f.from[1] + f.to[1]) / 2, (f.from[2] + f.to[2]) / 2 + f.arc * 2];
  if (f.ease === "fall") mid[1] = Math.min(f.from[1], f.to[1]) - f.arc;
  const [x, y, z] = bezier3(f.from, mid, f.to, u);
  const rot = f.rot;
  const ru = u < 0.5 ? u * 2 : (u - 0.5) * 2;
  const [ra, rb] = u < 0.5 ? [rot[0], rot[1]] : [rot[1], rot[2]];
  const sr = Math.sin((Math.PI / 2) * ru);
  const rx = lerp(ra[0], rb[0], sr);
  const ry = lerp(ra[1], rb[1], sr);
  const rz = lerp(ra[2], rb[2], sr);
  const sc = (f.scale ? lerp(f.scale[0], f.scale[1], u) : 1) * (1 + (f.swell ?? 0) * Math.sin(Math.PI * u));
  // Fades last at least a fifth of a second either end, eased, so a card never blinks on or off.
  const edge = 0.25 / f.dur;
  const o = Math.min(fade(clamp(u0 / Math.max(f.fade[0], edge))), fade(clamp((1 - u0) / Math.max(f.fade[1], edge))));
  return {
    opacity: r3(o),
    transform: `translate3d(${r3(x)}px, ${r3(y)}px, ${r3(z)}px) rotateX(${r3(rx)}deg) rotateY(${r3(ry)}deg) rotateZ(${r3(rz)}deg) scale(${r3(sc)})`,
  };
}

/* ── The frame ────────────────────────────────────────────────────────── */

export type Frame = {
  camera: string;
  moving: boolean;
  els: Record<string, El>;
  texts: Record<string, string>;
};

/** Every element id the film animates, with its surface; used by the driver and the tests. */
export const ELEMENT_IDS: string[] = [
  ...SURFACES.flatMap((s) => [`card:${s.id}`, `shadow:${s.id}`, `mount:${s.id}`, `face:${s.id}`]),
  ...SEAM_GHOST.surfaces.flatMap((id) => [`ghost:${id}`, `cover:${id}`]),
  ...Object.entries(BEATS).flatMap(([sid, beats]) => [...new Set(beats.map((b) => `${sid}/${b.id}`))]),
  ...FLYERS.map((f) => f.id),
  ...ARCS.flatMap((a) => [a.id, `${a.id}.dot`, `${a.id}.ring`]),
  "label3w",
];

/** Film time in [0, DURATION), to the microsecond, so a looped t renders exactly the frame of the same t (118.5 % 88.8 is not 29.7 in floats). */
export function wrapT(t: number): number {
  const m = t % DURATION;
  return Math.round((m < 0 ? m + DURATION : m) * 1e6) / 1e6;
}

/**
 * The film at t. `side` is how far the visitor's page reaches beyond either
 * side of the box (stage px); windows fade only beyond it (transitOpacity).
 */
export function frame(tIn: number, mobile = false, side?: number): Frame {
  const t = wrapT(tIn);
  const els: Record<string, El> = {};
  const texts: Record<string, string> = {};
  const cam = cameraAt(t, mobile);

  SURFACES.forEach((s) => {
    const here = presence(s.id, t, mobile, side);
    // A surface that rises into view (the phone, raised beside the desk) comes up from below as it fades in and goes down as it fades out; one a move carries slides along its width.
    const lowered = (s.rise ?? 0) * riseOf(s.id, t, mobile, side);
    const dx = slideOf(s.id, t, mobile, side);
    const slid: V3 = Math.abs(dx) > 0.001 ? UNTURN[s.id](dx) : [0, 0, 0];
    const moved = lowered > 0.001 || Math.abs(dx) > 0.001;
    const tf = [moved ? `translate3d(${r3(slid[0])}px, ${r3(slid[1] + lowered)}px, ${r3(slid[2])}px)` : "", here.scale < 1 ? `scale(${r3(here.scale)})` : ""].filter(Boolean).join(" ");
    els[`card:${s.id}`] = { transform: tf || "none" };
    const shadow = shadowOf(s, slid);
    // Opacity goes on the face, not the card: opacity on a preserve-3d element flattens it.
    const shown = transitOpacity(s.id, t, mobile, side) * here.o;
    els[`shadow:${s.id}`] = { ...shadow, opacity: r3((shadow.opacity ?? 1) * shown) };
    // A hidden surface takes no clicks and costs no paint.
    els[`mount:${s.id}`] = { visible: shown > 0 && isLive(s.id, t, mobile, side) };
    els[`face:${s.id}`] = { opacity: r3(shown) };
    if (SEAM_GHOST.surfaces.includes(s.id)) {
      const g = ghostOpacity(t);
      els[`ghost:${s.id}`] = { opacity: r3(g), visible: g > 0 };
      const c = coverOpacity(t);
      els[`cover:${s.id}`] = { opacity: r3(c), visible: c > 0 };
    }

    const grouped: Record<string, { tf: string[]; o: number }> = {};
    for (const b of BEATS[s.id]) {
      const st = beatState(b, t);
      const g = (grouped[b.id] ??= { tf: [], o: 1 });
      if (st.tf) g.tf.push(st.tf);
      g.o *= st.o;
    }
    for (const [id, g] of Object.entries(grouped)) {
      els[`${s.id}/${id}`] = { transform: g.tf.join(" ") || "none", opacity: r3(g.o) };
    }
    for (const tb of TEXTS[s.id]) {
      if (tb.kind === "keys") {
        let v = tb.keys[0][1];
        for (const [kt, kv] of tb.keys) if (t >= kt) v = kv;
        texts[`${s.id}/${tb.id}`] = v;
      } else {
        texts[`${s.id}/${tb.id}`] = typed(tb.text, t, tb.cue, tb.rate, tb.kind === "words");
      }
    }
  });

  for (const f of FLYERS) els[f.id] = flyerState(f, t);

  for (const a of ARCS) {
    const arcIn = progress(t, a.cue, a.dur);
    const arcOut = progress(t, a.cue + a.dur + a.hold, 0.4, fade);
    els[a.id] = { dash: r3(1 - arcIn), opacity: r3(fade(clamp((t - a.cue) / 0.25)) * (1 - arcOut)) };
    els[`${a.id}.dot`] = { opacity: r3(fade(clamp((t - a.cue - a.dur * 0.7) / 0.3)) * (1 - arcOut)) };
    // The end answers its arrival with one ring.
    const ring = beatState({ id: `${a.id}.ring`, cue: a.cue + a.dur, dur: 0.35, preset: "ring" }, t);
    els[`${a.id}.ring`] = { transform: ring.tf, opacity: r3(ring.o) };
  }

  const lIn = progress(t, LABEL_3W.cue, 0.35, fade);
  const lOut = progress(t, LABEL_3W.end - 0.45, 0.45, fade);
  els.label3w = { opacity: r3(lIn * (1 - lOut)) };

  return { camera: cameraTransform(cam.pose), moving: cam.moving, els, texts };
}

export { SURFACE_INDEX };
