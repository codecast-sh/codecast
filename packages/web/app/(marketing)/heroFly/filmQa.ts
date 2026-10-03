/**
 * Film quality checks over the pure timeline, shared by timeline.test.ts and
 * ad hoc probes: every visible change is continuous (no element, window or
 * camera moves, scales or fades faster than a person can follow between two
 * frames), and no frame of a move leaves the film box near empty.
 */

import { cameraAt, frame, PAGE_SIDE, SEAM_GHOST, type Frame } from "./timeline";
import { project, STAGE_SIZE } from "./project";
import { BEATS, FLYERS } from "./motion";
import { DURATION, SURFACES, localToWorld, type SurfaceId } from "./world";

export const FPS = 60;

/** The most a change may take in one frame at 60fps. */
export const LIMITS = {
  /** A window corner, in stage px: a fast pan crosses the box in about half a second. */
  rectPx: 44,
  /** A window corner's change of speed between frames, in stage px: a pop or a kink in a move. */
  rectJerk: 4,
  /** Opacity of a window or an element: a fade takes at least 6 frames (100ms). */
  opacity: 0.17,
  /** An element's own translate (px), scale and rotation (deg). */
  translate: 26,
  scale: 0.07,
  rotate: 9,
};

/**
 * A transform list folded per function: translates and rotations add up,
 * scales multiply, so a beat that stacks two shifts (a FLIP pair) reads as
 * their sum. Exact for the lists beats write (translates and one scale).
 */
function parse(tf: string | undefined): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!tf || tf === "none") return out;
  for (const m of tf.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)) {
    const name = m[1];
    if (name === "perspective") continue;
    const args = m[2].split(",").map((v) => parseFloat(v));
    const prev = out.get(name);
    out.set(name, prev ? args.map((v, i) => (name.startsWith("scale") ? (prev[i] ?? 1) * v : (prev[i] ?? 0) + v)) : args);
  }
  return out;
}

const identity = (name: string): number => (name.startsWith("scale") ? 1 : 0);

/** Per-kind largest change between two transforms; a function missing on one side counts as its identity. */
function transformDelta(a: string | undefined, b: string | undefined): { translate: number; scale: number; rotate: number } {
  const fa = parse(a);
  const fb = parse(b);
  const d = { translate: 0, scale: 0, rotate: 0 };
  for (const name of new Set([...fa.keys(), ...fb.keys()])) {
    const xa = fa.get(name);
    const xb = fb.get(name);
    const n = Math.max(xa?.length ?? 0, xb?.length ?? 0);
    for (let i = 0; i < n; i++) {
      const delta = Math.abs((xa?.[i] ?? identity(name)) - (xb?.[i] ?? identity(name)));
      const kind = name.startsWith("translate") ? "translate" : name.startsWith("scale") ? "scale" : "rotate";
      d[kind] = Math.max(d[kind], delta);
    }
  }
  return d;
}

/**
 * Layout compensations: a view that mounts or grows in one frame shifts what
 * is under it, and a FLIP pair of beats (fixtures/desk.ts glideOver) shifts it
 * back in that same frame and glides it home. That shift is a jump in the
 * frame's numbers and none on screen, so it is checked in the browser (step
 * `window.__heroFly.seek` at 1/30s and compare each element's rect against
 * its window's face), not here; film.test.tsx covers FilmGrow and FilmSwap.
 */
const FLIPS: { id: string; cue: number }[] = Object.entries(BEATS).flatMap(([sid, beats]) =>
  beats.filter((b) => b.preset === "push" && (b.dur ?? 1) < 1 / FPS).map((b) => ({ id: `${sid}/${b.id}`, cue: b.cue })),
);
const FLYER_IDS = new Set(FLYERS.map((f) => f.id));
const flipAt = (id: string, t: number) => FLIPS.some((f) => f.id === id && f.cue > t - 1 / FPS - 1e-9 && f.cue <= t + 1e-9);

const surfaceOf = (id: string): SurfaceId | null => {
  const m = /^(?:card|shadow|mount|face|ghost):(\w+)$/.exec(id) ?? /^(\w+)\//.exec(id);
  return m ? (m[1] as SurfaceId) : null;
};

/**
 * Under the seam's copy (timeline.ts SEAM_GHOST) an opening window's live
 * content shows only as far as the copy lets it through, and the copy itself
 * is frame(0): at the loop the copy covers the window wholly, so what was seen
 * the frame before the wrap is frame(0)'s content, which is what the live
 * window shows after it.
 */
const OPENING: Partial<Record<"desktop" | "mobile", Frame>> = {};
const opening = (mobile: boolean) => (OPENING[mobile ? "mobile" : "desktop"] ??= frame(0, mobile));
const underCopy = (id: string): SurfaceId | null => {
  const sid = /^(\w+)\//.exec(id)?.[1] as SurfaceId | undefined;
  return sid && SEAM_GHOST.surfaces.includes(sid) ? sid : null;
};
/** How much of an element's live layer shows through its window's seam copy. */
const throughGhost = (fr: Frame, id: string) => {
  const sid = underCopy(id);
  return sid ? 1 - (fr.els[`ghost:${sid}`]?.opacity ?? 0) : 1;
};

const CORNERS = SURFACES.map((s) => [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([lx, ly]) => localToWorld(s.id, (lx * s.w) / 2, (ly * s.h) / 2)));

/** A card's own slide, lift and scale as the frame writes them: `translate3d(x, y, z)` in its own px (a move carrying it along the world's x, a surface's rise) then `scale(k)` about its centre. */
export function cardOffset(tf: string | undefined): { x: number; y: number; z: number; k: number } {
  const m = /translate3d\((-?[\d.e-]+)px, (-?[\d.e-]+)px, (-?[\d.e-]+)px\)/.exec(tf ?? "");
  return { x: Number(m?.[1] ?? 0), y: Number(m?.[2] ?? 0), z: Number(m?.[3] ?? 0), k: Number(/scale\(([\d.]+)\)/.exec(tf ?? "")?.[1] ?? 1) };
}

/** Each shown window's projected corners (stage px), with how shown it is. */
export function shownRects(t: number, mobile: boolean, f: Frame = frame(t, mobile), all = false) {
  const { pose } = cameraAt(t, mobile);
  const out: { id: SurfaceId; o: number; pts: { x: number; y: number }[] }[] = [];
  SURFACES.forEach((s, i) => {
    const o = f.els[`mount:${s.id}`].visible ? (f.els[`face:${s.id}`].opacity ?? 1) : 0;
    if (o <= 0.02 && !all) return;
    const { x: slid, y: lift, z: near, k } = cardOffset(f.els[`card:${s.id}`].transform);
    // The card's slide and lift are in the surface's own px (turned and zoomed with it), and its scale is about the surface's centre.
    const down = localToWorld(s.id, slid, lift, near).map((v, a) => v - s.pos[a]);
    const pts = CORNERS[i].map((c) => {
      const [x, y, z] = [0, 1, 2].map((a) => s.pos[a] + (c[a] - s.pos[a]) * k + down[a]);
      return project(pose, [x, y, z], mobile) ?? { x: NaN, y: NaN };
    });
    out.push({ id: s.id, o, pts });
  });
  return out;
}

/** The share of the film box covered by shown windows, weighted by how shown each is (overlaps count once per window). */
export function coverage(t: number, mobile: boolean, f: Frame = frame(t, mobile)): number {
  const { w, h } = mobile ? STAGE_SIZE.mobile : STAGE_SIZE.desktop;
  let sum = 0;
  for (const r of shownRects(t, mobile, f)) {
    const xs = r.pts.map((p) => p.x);
    const ys = r.pts.map((p) => p.y);
    const iw = Math.max(0, Math.min(w, Math.max(...xs)) - Math.max(0, Math.min(...xs)));
    const ih = Math.max(0, Math.min(h, Math.max(...ys)) - Math.max(0, Math.min(...ys)));
    sum += ((iw * ih) / (w * h)) * r.o;
  }
  return Math.min(1, sum);
}

export type Jump = { t: number; what: string; amount: number; limit: number };

/**
 * Step the film frame by frame and report every change faster than LIMITS,
 * on a page reaching `side` stage px beyond the box. `rectScale` loosens the
 * window speed limits for a smaller film, where a stage px is fewer of the
 * screen's (the limits are a 1440x900 screen's).
 */
export function findJumps(mobile: boolean, from = 0, to = DURATION, side?: number, rectScale = 1): Jump[] {
  const jumps: Jump[] = [];
  const n = Math.round((to - from) * FPS);
  let prev: Frame | null = null;
  let prevRects: Map<SurfaceId, { o: number; pts: { x: number; y: number }[] }> | null = null;
  let prevVel = new Map<SurfaceId, { x: number; y: number }[]>();
  let prevOffPage = new Set<SurfaceId>();
  const report = (t: number, what: string, amount: number, limit: number) => {
    if (amount > limit) jumps.push({ t: Math.round(t * 1000) / 1000, what, amount: Math.round(amount * 1000) / 1000, limit });
  };
  for (let k = 0; k <= n; k++) {
    // The loop: the frame after the last is the first.
    const t = Math.min(from + k / FPS, DURATION);
    const f = frame(t >= DURATION ? 0 : t, mobile, side);
    const rects = new Map(shownRects(t >= DURATION ? 0 : t, mobile, f).map((r) => [r.id, r]));
    // Where every window is, shown or not: one that in each of two frames is either wholly beyond the page's sides or not shown at all shows nothing between them, whatever it does there.
    const [px0, px1] = [-(side ?? PAGE_SIDE[mobile ? "mobile" : "desktop"]), (mobile ? STAGE_SIZE.mobile.w : STAGE_SIZE.desktop.w) + (side ?? PAGE_SIDE[mobile ? "mobile" : "desktop"])];
    const offPage = new Set(shownRects(t >= DURATION ? 0 : t, mobile, f, true).filter((r) => r.o <= 0.02 || r.pts.every((p) => p.x <= px0) || r.pts.every((p) => p.x >= px1)).map((r) => r.id));
    if (prev && prevRects) {
      const faceOf = (fr: Frame, sid: SurfaceId | null) => (sid ? (fr.els[`mount:${sid}`]?.visible ? (fr.els[`face:${sid}`]?.opacity ?? 1) : 0) : 1);
      const wrapped = t >= DURATION;
      for (const id of Object.keys(f.els)) {
        // Across the wrap, what was seen of an opening window's content was its copy: frame(0).
        const a = wrapped && underCopy(id) ? opening(mobile).els[id] : prev.els[id];
        const b = f.els[id];
        if (!a || !b) continue;
        const sid = surfaceOf(id);
        // The copy hands over to the live window at the loop, which then shows what the copy showed.
        if (wrapped && id.startsWith("ghost:")) continue;
        const shown = Math.max(faceOf(prev, sid) * (wrapped && underCopy(id) ? 1 : throughGhost(prev, id)), faceOf(f, sid) * throughGhost(f, id));
        if (shown <= 0.02) continue;
        if (sid && offPage.has(sid) && prevOffPage.has(sid)) continue;
        if (id.startsWith("mount:")) {
          // Culling a window wholly off the page shows nothing.
          const [x0, x1] = [px0, px1];
          const onPage = (r?: { pts: { x: number }[] }) => !!r && r.pts.some((p) => p.x > x0) && r.pts.some((p) => p.x < x1);
          const s = sid as SurfaceId;
          if (a.visible !== b.visible && shown > 0.05 && (onPage(rects.get(s)) || onPage(prevRects.get(s)))) report(t, `${id} visibility while shown (${shown.toFixed(2)})`, 1, 0);
          continue;
        }
        const oa = a.opacity ?? 1;
        const ob = b.opacity ?? 1;
        report(t, `${id} opacity ${oa}->${ob}`, Math.abs(ob - oa) * Math.min(1, shown * 1.5), LIMITS.opacity);
        if (Math.min(oa, ob) * shown <= 0.02) continue;
        if (id.startsWith("shadow:")) continue;
        const d = transformDelta(a.transform, b.transform);
        // A flyer is a card crossing the world, held to a window's pace.
        // A card's translate is a move carrying its window, whose pace on screen its rect is held to below.
        if (!flipAt(id, t) && !id.startsWith("card:")) report(t, `${id} translate`, d.translate, FLYER_IDS.has(id) ? LIMITS.rectPx : LIMITS.translate);
        report(t, `${id} scale`, d.scale, LIMITS.scale);
        report(t, `${id} rotate`, d.rotate, LIMITS.rotate);
      }
      const vel = new Map<SurfaceId, { x: number; y: number }[]>();
      for (const [sid, r] of rects) {
        const p = prevRects.get(sid);
        if (!p) continue;
        const v = r.pts.map((pt, i) => ({ x: pt.x - p.pts[i].x, y: pt.y - p.pts[i].y }));
        vel.set(sid, v);
        // Only what reaches the page: a window off its side may race.
        const [x0, x1] = [px0, px1];
        const near = r.pts.some((pt) => pt.x > x0) && r.pts.some((pt) => pt.x < x1);
        if (!near || Math.min(r.o, p.o) < 0.15) continue;
        report(t, `${sid} rect speed`, Math.max(...v.map((q) => Math.hypot(q.x, q.y))), LIMITS.rectPx * rectScale);
        const pv = prevVel.get(sid);
        if (pv) report(t, `${sid} rect jerk`, Math.max(...v.map((q, i) => Math.hypot(q.x - pv[i].x, q.y - pv[i].y))), LIMITS.rectJerk * rectScale);
      }
      prevVel = vel;
    }
    prev = f;
    prevRects = rects;
    prevOffPage = offPage;
  }
  return jumps;
}

/** Group consecutive jumps of the same thing into one line each. */
export function summarise(jumps: Jump[]): string[] {
  const out: { what: string; t0: number; t1: number; max: number; limit: number }[] = [];
  for (const j of jumps) {
    const key = j.what.replace(/ opacity .*/, " opacity");
    const last = out.find((o) => o.what === key && j.t - o.t1 < 0.1);
    if (last) {
      last.t1 = j.t;
      last.max = Math.max(last.max, j.amount);
    } else out.push({ what: key, t0: j.t, t1: j.t, max: j.amount, limit: j.limit });
  }
  return out.map((o) => `${o.t0.toFixed(3)}..${o.t1.toFixed(3)} ${o.what}: ${o.max} > ${o.limit}`);
}
