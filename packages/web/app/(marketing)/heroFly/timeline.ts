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
  SURFACE_BY_ID,
  SURFACES,
  localToWorld,
  type Beat,
  type Flyer,
  type Hold,
  type Pose,
  type SurfaceId,
  type V3,
} from "./world";
import { projector, STAGE_SIZE } from "./project";

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
    const ids = [...new Set([...hold.sees, ...next.sees])];
    const span = next.t0 - hold.t1;
    const steps = Math.max(24, Math.ceil(span * 40));
    // How many sampled frames would show a window across the top or bottom, over the part of the move a pull-back reaches (at least half of it applied).
    const crossings = (crest: number) => {
      let n = 0;
      for (let k = 1; k < steps; k++) {
        const u = k / steps;
        if (Math.sin(Math.PI * camEase(u)) < 0.5) continue;
        const at = projector(transitPose(i, u, mobile, crest), mobile);
        for (const id of ids) {
          if (transitOpacity(id, hold.t1 + u * span) <= 0.01) continue;
          const b = bounds(cornersAt(SURFACE_INDEX[id], hold.t1 + u * span), at);
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
 * window never leaves: over it, a copy of the window's own content as it
 * stands at t=0 (the views rendered on a clock held at 0, its elements
 * written with frame(0)) dissolves in until it covers the window wholly,
 * so the film's last frame shows exactly its first, and the loop hands from
 * the copy to the live window with nothing changing on screen.
 * `SEAM_GHOST.mount` is when the copy is mounted (hidden), well before it
 * is seen, so its first render never lands on a frame that shows it.
 */
export const SEAM_GHOST = {
  surfaces: CAMERA[0].sees,
  mount: DURATION - 3.4,
  from: DURATION - 1.5,
  to: DURATION - 0.2,
} as const;

/** How much of the seam's copy covers the opening's windows at t (0 outside the seam). */
export const ghostOpacity = (t: number): number => (t < SEAM_GHOST.from ? 0 : fade(clamp((t - SEAM_GHOST.from) / (SEAM_GHOST.to - SEAM_GHOST.from))));

const SURFACE_INDEX = Object.fromEntries(SURFACES.map((s, i) => [s.id, i])) as Record<SurfaceId, number>;

/* ── A move dissolves from the windows it leaves to the ones it reaches ── */

const FADE_IN = 0.35;
const FADE_OUT = 0.45;

/**
 * Opacity of a surface across the camera's path. A hold shows only the
 * surfaces it is about, so nothing sits idle at the page's edges while a
 * chapter holds. A move shows both ends: the windows it heads for dissolve in
 * over its first FADE_IN (their own `fadeIn`) while they are still off to the
 * side, and the windows it leaves stay until its last FADE_OUT (their own
 * `fadeOut`), by when the pan has carried them off the side of the page, so
 * the page is never empty mid-move. A surface neither hold is about stays
 * hidden.
 */
function transitOpacity(id: SurfaceId, t: number): number {
  for (let i = 0; i < CAMERA.length; i++) {
    const h = CAMERA[i];
    if (t >= h.t0 && t <= h.t1) return h.sees.includes(id) ? 1 : 0;
    const next = CAMERA[i + 1];
    if (!next || t <= h.t1 || t >= next.t0) continue;
    const [a, b] = [h.sees.includes(id), next.sees.includes(id)];
    if (a && b) return 1;
    const { fadeIn = FADE_IN, fadeOut = FADE_OUT } = SURFACE_BY_ID[id];
    if (a) return glide(clamp((next.t0 - t) / fadeOut));
    if (b) return glide(clamp((t - h.t1) / fadeIn));
    return 0;
  }
  return 0;
}

/** How far a surface with `rise` has to go: 1 out of view, 0 in place, following its own fade. */
const riseOf = (id: SurfaceId, t: number) => (SURFACE_BY_ID[id].rise ? 1 - transitOpacity(id, t) : 0);

/**
 * A contact shadow: just behind its surface and a little below, so the
 * surface reads as resting on the page, never far enough back to slide into
 * frame on its own while its surface is out of it. `h` is the surface's
 * height above the page plane (z = -420): high surfaces cast a wider, softer
 * one; low ones a tight one.
 */
const PAGE_Z = -420;
function shadowOf(s: (typeof SURFACES)[number]): El {
  const h = s.pos[2] - PAGE_Z;
  // Held behind the surface by as far as its tilt swings its edges, so no part of the shadow pokes through it.
  const tilt = Math.sin((Math.max(Math.abs(s.rot[0]), Math.abs(s.rot[1])) * Math.PI) / 180) * (Math.max(s.w, s.h) / 2);
  const clear = 12 + tilt * 1.1;
  const scale = 1 + h / 2400;
  return {
    transform: `translate3d(0px, ${r3(6 + h * 0.02)}px, ${r3(-(clear + 24 + h * 0.05))}px) scale(${r3(scale)})`,
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

/** A surface's corners at t, lowered by its rise while it comes or goes (the card's transform in `frame`). */
function cornersAt(i: number, t: number): V3[] {
  const s = SURFACES[i];
  const down = (s.rise ?? 0) * riseOf(s.id, t);
  if (down <= 0.001) return CORNERS_OF[i];
  return CORNERS.map(([lx, ly]) => localToWorld(s.id, (lx * s.w) / 2, (ly * s.h) / 2 + down));
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
function buildTrack(mobile: boolean): Track {
  const [px0, px1] = PAGE_X[mobile ? "mobile" : "desktop"];
  const h = boxH(mobile);
  const live: [number, number][][] = SURFACES.map(() => []);
  const away: [number, number][][] = SURFACES.map(() => []);
  const n = Math.ceil(DURATION / STEP);
  for (let k = 0; k <= n; k++) {
    const t = Math.min(k * STEP, DURATION - 1e-6);
    const at = projector(cameraAt(t, mobile).pose, mobile);
    SURFACES.forEach((_, i) => {
      const b = bounds(cornersAt(i, t), at);
      // Rendered while any of it reaches the page, its shadow's spread (5% either side) included.
      const [sx, sy] = b ? [(b.x1 - b.x0) * 0.05, (b.y1 - b.y0) * 0.05] : [0, 0];
      if (!b || (b.x1 + sx > px0 && b.x0 - sx < px1 && b.y1 + sy > 0 && b.y0 - sy < h)) live[i].push([Math.max(0, t - LIVE_PAD), Math.min(DURATION, t + LIVE_PAD)]);
      const sideways = b && (b.x1 <= px0 || b.x0 >= px1);
      const crossing = !b || (!sideways && (b.y0 < EDGE_CLEAR || b.y1 > h - EDGE_CLEAR));
      if (crossing) away[i].push([Math.max(0, t - STEP), Math.min(DURATION, t + STEP)]);
    });
  }
  return { live: live.map((s) => merge(s, 0)), away: away.map((s) => merge(s, MIN_SHOWN).map(beats)) };
}

const TRACKS: Partial<Record<"desktop" | "mobile", Track>> = {};
const track = (mobile: boolean): Track => (TRACKS[mobile ? "mobile" : "desktop"] ??= buildTrack(mobile));

/** Whether a surface is rendered at t: some part of it reaches the page, and it is not away from the frame. */
export const isLive = (id: SurfaceId, t: number, mobile = false): boolean =>
  track(mobile).live[SURFACE_INDEX[id]].some(([a, b]) => t >= a && t <= b) && presence(id, t, mobile).o > 0;

/** How present a window is at t (1 shown, 0 away) and the scale it wears while lifting out or dropping in. */
export function presence(id: SurfaceId, t: number, mobile = false): { o: number; scale: number } {
  let o = 1;
  for (const { from, a, b, to } of track(mobile).away[SURFACE_INDEX[id]]) {
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
  ...SEAM_GHOST.surfaces.map((id) => `ghost:${id}`),
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

export function frame(tIn: number, mobile = false): Frame {
  const t = wrapT(tIn);
  const els: Record<string, El> = {};
  const texts: Record<string, string> = {};
  const cam = cameraAt(t, mobile);

  SURFACES.forEach((s) => {
    const here = presence(s.id, t, mobile);
    // A surface that rises into view (the phone, raised beside the desk) comes up from below as it fades in and goes down as it fades out.
    const lowered = (s.rise ?? 0) * riseOf(s.id, t);
    const tf = [lowered > 0.001 ? `translate3d(0px, ${r3(lowered)}px, 0px)` : "", here.scale < 1 ? `scale(${r3(here.scale)})` : ""].filter(Boolean).join(" ");
    els[`card:${s.id}`] = { transform: tf || "none" };
    const shadow = shadowOf(s);
    // Opacity goes on the face, not the card: opacity on a preserve-3d element flattens it.
    const shown = transitOpacity(s.id, t) * here.o;
    els[`shadow:${s.id}`] = { ...shadow, opacity: r3((shadow.opacity ?? 1) * shown) };
    // A hidden surface takes no clicks and costs no paint.
    els[`mount:${s.id}`] = { visible: shown > 0 && isLive(s.id, t, mobile) };
    els[`face:${s.id}`] = { opacity: r3(shown) };
    if (SEAM_GHOST.surfaces.includes(s.id)) {
      const g = ghostOpacity(t);
      els[`ghost:${s.id}`] = { opacity: r3(g), visible: g > 0 };
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
