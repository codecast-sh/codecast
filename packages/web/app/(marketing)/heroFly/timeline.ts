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
  DURATION,
  LABEL_3W,
  LIVE,
  SURFACES,
  type Beat,
  type Flyer,
  type Hold,
  type Pose,
  type SurfaceId,
  type V3,
} from "./world";

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
/** The camera's move: leaves briskly and lands gently. */
export const camEase = cubicBezier(0.45, 0, 0.2, 1);
export const settle = cubicBezier(0.16, 1, 0.3, 1);
export const out = cubicBezier(0.4, 0, 1, 1);

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

export const DROP = spring(14, 0.62);
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

/** A hold breathes: a slow slide and turn, and a push toward the subject. */
const DRIFT_X = 28;
const DRIFT_YAW = 1.2;
const DRIFT_PUSH = 36;

function holdPose(h: Hold, v: number, over?: Partial<Pose>): Pose {
  const p = { ...h.pose, ...over };
  if (!h.drift) return p;
  const d = v - 0.5;
  return { ...p, x: p.x + DRIFT_X * d, yaw: p.yaw + DRIFT_YAW * d, dist: p.dist + (h.push ?? DRIFT_PUSH) * v };
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

export function cameraAt(t: number, mobile = false): { pose: Pose; moving: boolean } {
  const holds = CAMERA;
  const over = (i: number) => (mobile ? CAMERA_MOBILE[i] : undefined);
  for (let i = 0; i < holds.length; i++) {
    const h = holds[i];
    if (t >= h.t0 && t <= h.t1) return { pose: holdPose(h, h.t1 > h.t0 ? (t - h.t0) / (h.t1 - h.t0) : 0, over(i)), moving: false };
    const next = holds[i + 1];
    if (next && t > h.t1 && t < next.t0) {
      const a = holdPose(h, 1, over(i));
      const b = holdPose(next, 0, over(i + 1));
      const prev = i > 0 ? holdPose(holds[i - 1], 1, over(i - 1)) : a;
      const after = i + 2 < holds.length ? holdPose(holds[i + 2], 0, over(i + 2)) : b;
      const span = next.t0 - h.t1;
      const u = (t - h.t1) / span;
      const e = camEase(u);
      // Roll leads the turn by 150ms so the move banks into itself.
      const eRoll = camEase(clamp(u + 0.15 / span));
      const crest = (next.crest ?? 0) * Math.sin(Math.PI * e) * (mobile ? 1.6 : 1);
      const pose: Pose = {
        x: catmull(prev.x, a.x, b.x, after.x, e),
        y: catmull(prev.y, a.y, b.y, after.y, e),
        z: catmull(prev.z, a.z, b.z, after.z, e),
        pitch: lerp(a.pitch, b.pitch, e),
        yaw: lerp(a.yaw, b.yaw, e),
        roll: lerp(a.roll, b.roll, eRoll) + (next.crestRoll ?? 0) * Math.sin(Math.PI * eRoll),
        dist: lerp(a.dist, b.dist, e) + crest,
      };
      return { pose, moving: true };
    }
  }
  return { pose: holdPose(holds[0], 0, over(0)), moving: false };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function cameraTransform(p: Pose): string {
  return `translateZ(${r3(p.dist)}px) rotateX(${r3(p.pitch)}deg) rotateY(${r3(p.yaw)}deg) rotateZ(${r3(p.roll)}deg) translate3d(${r3(-p.x)}px, ${r3(-p.y)}px, ${r3(-p.z)}px)`;
}

/* ── Surfaces: the deal at the start, the reverse deal at the seam ───── */

/**
 * The opening deals only the surfaces the dive lands on; every other one
 * waits face-down in the overview, showing its chapter's name like a table of
 * contents, and turns over just ahead of the camera's first visit, so each
 * chapter opens with its own reveal.
 */
const DEALT: SurfaceId[] = ["desk", "board"];
const FLIP_UP = 0.15;
const FLIP_STEP = 0.12;
const DEAL_T = 2.2;
/** A chapter's surface starts to turn this long before the first hold that sees it, and lands this long after. */
const FLIP_LEAD = 0.7;
const FLIP_DUR = 0.9;
/**
 * The seam: the desk turns face-down first and the outliers last, as the
 * camera dives out, and every card has landed by LANDED so the overview rests
 * face-down before the loop deals it again.
 */
const FLIP_DOWN = DURATION - 2.0;
const FLIP_DOWN_STEP = 0.08;
export const LANDED = DURATION - 0.6;
const FLIP_LIFT_UP = 160;
const FLIP_LIFT_DOWN = 140;

const firstHold = (id: SurfaceId) => CAMERA.find((h) => h.sees !== "all" && h.sees.includes(id));

const upCue = (i: number) => {
  const s = SURFACES[i];
  const dealt = DEALT.indexOf(s.id);
  if (dealt >= 0) return FLIP_UP + dealt * FLIP_STEP;
  const h = firstHold(s.id);
  return h ? h.t0 - FLIP_LEAD : FLIP_UP;
};
const upDur = (i: number) => (DEALT.includes(SURFACES[i].id) ? DEAL_T : FLIP_DUR);
const downCue = (i: number) => FLIP_DOWN + i * FLIP_DOWN_STEP;
const downDur = (i: number) => LANDED - downCue(i);

/** Seconds after its down cue at which a surface's flip passes edge-on (90deg). */
const DOWN_HALF = SURFACES.map((_, i) => {
  let s = 0;
  while (SETTLE(s, downDur(i)) < 0.5) s += 0.001;
  return s;
});

/** Content time for a surface: its finished state until it turns edge-on at the seam, then its t=0 state for the deal. */
export function contentT(i: number, t: number): number {
  return t < downCue(i) + DOWN_HALF[i] ? t : 0;
}

function surfaceFlip(i: number, t: number): { angle: number; lift: number } {
  const d = downCue(i);
  if (t >= d) {
    const k = SETTLE(t - d, downDur(i));
    return { angle: 180 * k, lift: FLIP_LIFT_DOWN * Math.sin(Math.PI * clamp(k)) };
  }
  const k = DROP(t - upCue(i), upDur(i));
  return { angle: 180 * (1 - k), lift: FLIP_LIFT_UP * Math.sin(Math.PI * clamp(k)) };
}

/** The film second each surface starts to turn face-up; the tests hold every chapter's resting state to it. */
export const FACE_UP: Record<SurfaceId, number> = Object.fromEntries(SURFACES.map((s, i) => [s.id, upCue(i)])) as Record<SurfaceId, number>;

/* ── Surfaces near the camera's path fade across transits ────────────── */

const sees = (h: Hold, id: SurfaceId) => h.sees === "all" || h.sees.includes(id);
const FADE = 0.3;

/**
 * Opacity of a `fadeInTransit` surface: out over the first 0.3s of a move
 * away from a hold that sees it, in over the first 0.3s of a move toward one,
 * and in over the dive's last second (short of the flips) toward the overview.
 */
function transitOpacity(id: SurfaceId, t: number): number {
  for (let i = 0; i < CAMERA.length; i++) {
    const h = CAMERA[i];
    if (t >= h.t0 && t <= h.t1) return sees(h, id) ? 1 : 0;
    const next = CAMERA[i + 1];
    if (!next || t <= h.t1 || t >= next.t0) continue;
    const [a, b] = [sees(h, id), sees(next, id)];
    const s = t - h.t1;
    if (a && b) return 1;
    if (a) return 1 - settle(clamp(s / FADE));
    if (!b) return 0;
    if (next.sees === "all") return settle(clamp((t - (next.t0 - 1)) / 0.6));
    return settle(clamp(s / FADE));
  }
  return 1;
}

/**
 * Shadows lie on the backdrop (z = -420), so a surface's height above it
 * reads as depth: high surfaces cast wide, soft shadows; low ones tight.
 */
const BACKDROP_Z = -420;
function shadowOf(s: (typeof SURFACES)[number], liftN: number): El {
  const h = s.pos[2] - BACKDROP_Z;
  // Held off the backdrop by as far as the surface's tilt swings its edges, so no part of it sinks behind the plane.
  const tilt = Math.sin((Math.max(Math.abs(s.rot[0]), Math.abs(s.rot[1])) * Math.PI) / 180) * (Math.max(s.w, s.h) / 2);
  const clear = 12 + tilt * 1.1;
  const scale = (1 + h / 1400) * (1 + 0.18 * liftN);
  return {
    transform: `translate3d(0px, ${r3(18 + h * 0.06)}px, ${r3(-h + clear)}px) scale(${r3(scale)})`,
    opacity: r3(clamp(0.3 - (0.12 * h) / 600, 0.08, 0.3) / 0.3 * (1 - 0.65 * liftN)),
  };
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
      return { tf: "", o: settle(p) };
    case "fadeOut":
      return { tf: "", o: 1 - settle(p) };
    case "push": {
      const inv = 1 - settle(p);
      if (inv === 0) return { tf: "", o: 1 };
      return { tf: `translate3d(${r3((b.x ?? 0) * inv)}px, ${r3((b.y ?? 0) * inv)}px, 0px)`, o: 1 };
    }
    case "pulse": {
      if (p <= 0 || p >= 1) return { tf: "", o: 1 };
      return { tf: `scale(${r3(1 + (b.s ?? 0.12) * Math.sin(Math.PI * settle(p)))})`, o: 1 };
    }
    case "popIn": {
      const k = SNAP(s * (0.45 / dur));
      const from = b.s ?? 0.6;
      return { tf: k >= 1 ? "" : `scale(${r3(from + (1 - from) * k)})`, o: clamp(s / Math.min(0.2, dur)) };
    }
    case "ring": {
      if (p <= 0 || p >= 1) return { tf: "scale(0.4)", o: 0 };
      const e = settle(p);
      return { tf: `scale(${r3(0.4 + 1.2 * e)})`, o: 0.5 * (1 - e) };
    }
    case "growX": {
      const from = b.s ?? 0;
      const e = settle(p);
      return { tf: e >= 1 ? "" : `scaleX(${r3(from + (1 - from) * e)})`, o: 1 };
    }
    case "growY": {
      const k = SNAP(s);
      return { tf: k >= 1 ? "" : `scaleY(${r3(k)})`, o: 1 };
    }
    case "flipOut":
      return { tf: p <= 0 ? "" : `perspective(400px) rotateY(${r3(180 * settle(p))}deg)`, o: 1 };
    case "flipIn":
      return { tf: p >= 1 ? "" : `perspective(400px) rotateY(${r3(-180 + 180 * settle(p))}deg)`, o: 1 };
    case "liftOut": {
      const e = settle(p);
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
  const sc = f.scale ? lerp(f.scale[0], f.scale[1], u) : 1;
  const o = Math.min(clamp(u0 / f.fade[0]), clamp((1 - u0) / f.fade[1]));
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

const SURFACE_INDEX = Object.fromEntries(SURFACES.map((s, i) => [s.id, i])) as Record<SurfaceId, number>;

/** Every element id the film animates, with its surface; used by the driver and the tests. */
export const ELEMENT_IDS: string[] = [
  ...SURFACES.flatMap((s) => [`card:${s.id}`, `shadow:${s.id}`, `mount:${s.id}`, ...(s.fadeInTransit ? [`face:${s.id}`] : [])]),
  ...Object.entries(BEATS).flatMap(([sid, beats]) => [...new Set(beats.map((b) => `${sid}/${b.id}`))]),
  ...FLYERS.map((f) => f.id),
  ...ARCS.map((a) => a.id),
  "label3w",
];

export function wrapT(t: number): number {
  const m = t % DURATION;
  return m < 0 ? m + DURATION : m;
}

export function frame(tIn: number, mobile = false): Frame {
  const t = wrapT(tIn);
  const els: Record<string, El> = {};
  const texts: Record<string, string> = {};
  const cam = cameraAt(t, mobile);

  SURFACES.forEach((s, i) => {
    const { angle, lift } = surfaceFlip(i, t);
    const liftN = lift / FLIP_LIFT_UP;
    els[`card:${s.id}`] = { transform: `translateZ(${r3(lift)}px) rotateX(${r3(angle)}deg)` };
    const shadow = shadowOf(s, liftN);
    const fade = s.fadeInTransit ? transitOpacity(s.id, t) : 1;
    els[`shadow:${s.id}`] = { ...shadow, opacity: r3((shadow.opacity ?? 1) * fade) };
    els[`mount:${s.id}`] = { visible: LIVE[s.id].some(([a, b]) => t >= a && t <= b) };
    if (s.fadeInTransit) els[`face:${s.id}`] = { opacity: r3(fade) };

    const ct = contentT(i, t);
    const grouped: Record<string, { tf: string[]; o: number }> = {};
    for (const b of BEATS[s.id]) {
      const st = beatState(b, ct);
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
        for (const [kt, kv] of tb.keys) if (ct >= kt) v = kv;
        texts[`${s.id}/${tb.id}`] = v;
      } else {
        texts[`${s.id}/${tb.id}`] = typed(tb.text, ct, tb.cue, tb.rate, tb.kind === "words");
      }
    }
  });

  for (const f of FLYERS) els[f.id] = flyerState(f, t);

  for (const a of ARCS) {
    const arcIn = progress(t, a.cue, a.dur);
    const arcOut = progress(t, a.cue + a.dur + a.hold, 0.4);
    els[a.id] = { dash: r3(1 - arcIn), opacity: r3(arcIn > 0 ? 1 - arcOut : 0) };
  }

  const lIn = progress(t, LABEL_3W.cue, 0.3);
  const lOut = progress(t, LABEL_3W.end - 0.45, 0.45);
  els.label3w = { opacity: r3(lIn * (1 - lOut)) };

  return { camera: cameraTransform(cam.pose), moving: cam.moving, els, texts };
}

export { SURFACE_INDEX };
