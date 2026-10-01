import { describe, expect, test } from "bun:test";
import { ARCS, BEATS, FLYERS } from "./motion";
import { project, rotateXYZ, STAGE_SIZE } from "./project";
import { DROP, SETTLE, SNAP, cameraAt, frame, isLive, presence, typed } from "./timeline";
import { CAMERA, CAMERA_MOBILE, DURATION, SCENES, SURFACES, SURFACE_BY_ID, localToWorld, surfacePt, type Pose, type SurfaceId, type V3 } from "./world";

const nums = (s: string | undefined) => (s ?? "").match(/-?\d+(\.\d+)?(e-?\d+)?/g)?.map(Number) ?? [];

function expectSameFrame(a: ReturnType<typeof frame>, b: ReturnType<typeof frame>, eps: number) {
  const close = (x: number[], y: number[], what: string) => {
    expect(x.length, what).toBe(y.length);
    x.forEach((v, i) => expect(Math.abs(v - y[i]), `${what} [${i}] ${v} vs ${y[i]}`).toBeLessThan(eps));
  };
  close(nums(a.camera), nums(b.camera), "camera");
  expect(Object.keys(a.els).sort()).toEqual(Object.keys(b.els).sort());
  for (const id of Object.keys(a.els)) {
    const [ea, eb] = [a.els[id], b.els[id]];
    // An identity transform may be spelled "none" on one side and a zero-offset transform on the other.
    const ta = nums(ea.transform);
    const tb = nums(eb.transform);
    if (ta.length === tb.length) close(ta, tb, `${id} transform`);
    else expect([...ta, ...tb].every((v) => Math.abs(v) < eps || Math.abs(v - 1) < eps || Math.abs(v - 800) < eps || Math.abs(v - 400) < eps), `${id} transform ${ea.transform} vs ${eb.transform}`).toBe(true);
    expect(Math.abs((ea.opacity ?? 1) - (eb.opacity ?? 1)), `${id} opacity`).toBeLessThan(eps);
    expect(ea.visible, `${id} visible`).toBe(eb.visible);
  }
  expect(a.texts).toEqual(b.texts);
}

describe("hero fly-through timeline", () => {
  test("the loop seam is exact: frame(0) equals frame(DURATION - 1e-6)", () => {
    expectSameFrame(frame(0), frame(DURATION - 1e-6), 0.01);
    expectSameFrame(frame(0, true), frame(DURATION - 1e-6, true), 0.01);
    // The first frame of each framing samples the whole film once (timeline.ts buildTrack).
  }, 60_000);

  test("frame is a pure function of t", () => {
    for (const t of [0, 1.2, 6.6, 12.4, 22.8, 29.7, 44.1, 58.3, 71.2, 79.9, 84.5, DURATION - 0.01]) {
      expect(frame(t)).toEqual(frame(t));
      expect(frame(t + DURATION)).toEqual(frame(t));
    }
  });

  test("scenes are contiguous and cover the whole film", () => {
    expect(SCENES[0].start).toBe(0);
    expect(SCENES[SCENES.length - 1].end).toBe(DURATION);
    SCENES.forEach((s, i) => {
      if (i > 0) expect(s.start).toBe(SCENES[i - 1].end);
      expect(s.hold).toBeGreaterThanOrEqual(s.start);
      expect(s.hold).toBeLessThan(s.end);
    });
  });

  test("springs start at 0 and land exactly on 1", () => {
    for (const sp of [DROP, SETTLE, SNAP]) {
      expect(sp(-1)).toBe(0);
      expect(sp(0)).toBe(0);
      expect(sp(2.5)).toBe(1);
      expect(sp(9)).toBe(1);
      expect(sp(0.4, 0.4)).toBe(1);
    }
  });

  test("typing reveals characters and words by rate", () => {
    expect(typed("hello world", 1, 0, 3)).toBe("hel");
    expect(typed("one two three", 1, 0, 2, true)).toBe("one two");
    expect(typed("abc", -1, 0, 10)).toBe("");
  });

  // Every hold frames its hero surface near scale 1 and near face-on, so text reads crisply.
  const HERO: (SurfaceId | null)[] = ["desk", "desk", "desk", "pairA", "phone", null, "pairB", "desk", "board", "auto", "team", "pr", "page", "palette", "blame", "desk", null];

  test("every camera hold has a hero entry and a mobile override", () => {
    expect(HERO.length).toBe(CAMERA.length);
    expect(CAMERA_MOBILE.length).toBe(CAMERA.length);
  });

  test("every chapter holds the camera still for at least 3s", () => {
    SCENES.forEach((s) => {
      const held = CAMERA.filter((h) => h.t0 >= s.start && h.t0 < s.end).reduce((n, h) => n + h.t1 - h.t0, 0);
      expect(held, `${s.id} holds ${held.toFixed(2)}s`).toBeGreaterThanOrEqual(3);
    });
  });

  // A move may lean toward its neighbours but never run past its own ends and come back.
  for (const mobile of [false, true]) {
    test(`no transit overshoots its endpoints${mobile ? " (mobile)" : ""}`, () => {
      for (let i = 0; i + 1 < CAMERA.length; i++) {
        const [h, next] = [CAMERA[i], CAMERA[i + 1]];
        const a = cameraAt(h.t1, mobile).pose;
        const b = cameraAt(next.t0, mobile).pose;
        for (let k = 1; k < 40; k++) {
          const p = cameraAt(h.t1 + ((next.t0 - h.t1) * k) / 40, mobile).pose;
          for (const axis of ["x", "y", "z"] as const) {
            expect(p[axis], `transit ${h.t1}->${next.t0} ${axis}`).toBeGreaterThanOrEqual(Math.min(a[axis], b[axis]) - 10);
            expect(p[axis], `transit ${h.t1}->${next.t0} ${axis}`).toBeLessThanOrEqual(Math.max(a[axis], b[axis]) + 10);
          }
        }
      }
    });
  }

  // Apple-paced: no move crosses more than about 2.5 widths of the frame (1280px) a second on average.
  test("transits are sized to their distance", () => {
    for (let i = 0; i + 1 < CAMERA.length; i++) {
      const [h, next] = [CAMERA[i], CAMERA[i + 1]];
      const a = cameraAt(h.t1).pose;
      const b = cameraAt(next.t0).pose;
      const travel = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const span = next.t0 - h.t1;
      expect(span, `transit ${h.t1}->${next.t0}`).toBeGreaterThanOrEqual(1.05);
      expect(travel / span, `transit ${h.t1}->${next.t0} px/s`).toBeLessThan(1280 * 2.5);
    }
  });

  test("every scene is one chapter, in order, holding inside itself", () => {
    SCENES.forEach((s) => expect(CAMERA.some((h) => h.t0 === s.hold), `${s.id} hold ${s.hold} starts a camera hold`).toBe(true));
    expect(new Set(SCENES.map((s) => s.id)).size).toBe(SCENES.length);
  });

  for (const mobile of [false, true]) {
    test(`holds frame their hero surface near scale 1 and face-on${mobile ? " (mobile)" : ""}`, () => {
      CAMERA.forEach((h, i) => {
        const id = HERO[i];
        if (!id) return;
        const s = SURFACE_BY_ID[id];
        const { pose } = cameraAt((h.t0 + h.t1) / 2, mobile);
        const scale = project(pose, s.pos, mobile)!.scale;
        const lo = id === "pairB" || id === "board" ? 0.8 : 0.88;
        expect(scale, `${id} scale at hold ${i}`).toBeGreaterThan(lo);
        // Up to a third larger when a hold frames one region of its surface (the decision card, the Anywhere inset).
        expect(scale, `${id} scale at hold ${i}`).toBeLessThan(1.25);
        // The surface normal after the surface's own rotation and the camera's.
        const n: V3 = rotateXYZ(rotateXYZ([0, 0, 1], s.rot), [pose.pitch, pose.yaw, pose.roll]);
        const off = (Math.acos(Math.min(1, n[2])) * 180) / Math.PI;
        expect(off, `${id} angle at hold ${i}`).toBeLessThan(12);
      });
    });
  }

  // The film clips at exactly its own height and that clip is never seen: at every moment of the film, holds and transits alike,
  // each window that is shown is wholly inside the box's height, or it is not shown. The sides are open (the page runs to the
  // browser's edges, 700 stage px either side of the box on a 2560px screen; a phone shows a 60px gutter). Each card's corners
  // are taken from the transform the frame writes (its lift, turn and scale) and projected through the camera's perspective.
  const FLYER_HALF = 40;
  const PAGE = { desktop: { x0: -700, x1: 1980, h: STAGE_SIZE.desktop.h }, mobile: { x0: -60, x1: 700, h: STAGE_SIZE.mobile.h } };
  function cardCorners(id: SurfaceId, tf: string | undefined, pose: Pose, mobile: boolean) {
    const sf = SURFACE_BY_ID[id];
    const lift = Number(/translateZ\((-?[\d.e-]+)px\)/.exec(tf ?? "")?.[1] ?? 0);
    const angle = (Number(/rotateX\((-?[\d.e-]+)deg\)/.exec(tf ?? "")?.[1] ?? 0) * Math.PI) / 180;
    const k = Number(/scale\((-?[\d.e-]+)\)/.exec(tf ?? "")?.[1] ?? 1);
    return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([lx, ly]) => {
      const [x, y] = [(lx * sf.w * k) / 2, (ly * sf.h * k) / 2];
      return project(pose, localToWorld(id, x, y * Math.cos(angle), y * Math.sin(angle) + lift), mobile);
    });
  }

  for (const mobile of [false, true]) {
    test(`no shown window crosses the top or bottom of the box${mobile ? " (mobile)" : ""}`, () => {
      const page = PAGE[mobile ? "mobile" : "desktop"];
      const bad: string[] = [];
      for (let k = 0; k * (1 / 60) < DURATION; k++) {
        const t = k / 60;
        const f = frame(t, mobile);
        const { pose } = cameraAt(t, mobile);
        for (const sf of SURFACES) {
          if (!f.els[`mount:${sf.id}`].visible) continue;
          if ((f.els[`face:${sf.id}`].opacity ?? 1) <= 0.02) continue;
          const pts = cardCorners(sf.id, f.els[`card:${sf.id}`].transform, pose, mobile);
          if (pts.some((p) => !p)) {
            bad.push(`${sf.id} at ${t.toFixed(3)} behind the eye`);
            continue;
          }
          const xs = pts.map((p) => p!.x);
          const ys = pts.map((p) => p!.y);
          if (Math.max(...xs) <= page.x0 || Math.min(...xs) >= page.x1) continue;
          if (Math.max(...ys) <= 0 || Math.min(...ys) >= page.h) continue;
          if (Math.min(...ys) < -0.5 || Math.max(...ys) > page.h + 0.5) bad.push(`${sf.id} at ${t.toFixed(3)}: ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)}`);
        }
        // A flyer is a card centred on its point, no more than FLYER_HALF tall either side of it; an arc is drawn between its ends, peaking halfway to its control point.
        const points: [string, V3, number][] = [];
        for (const fl of FLYERS) {
          if ((f.els[fl.id].opacity ?? 0) <= 0.02) continue;
          const m = /translate3d\((-?[\d.e-]+)px, (-?[\d.e-]+)px, (-?[\d.e-]+)px\)/.exec(f.els[fl.id].transform ?? "");
          if (m) points.push([fl.id, m.slice(1, 4).map(Number) as V3, FLYER_HALF]);
        }
        for (const a of ARCS) {
          if ((f.els[a.id].opacity ?? 0) <= 0.02) continue;
          const top = Math.min(a.from[1], a.to[1]);
          const peak: V3 = [(a.from[0] + a.to[0]) / 2, top - (a.apex ?? 170) / 2, (a.from[2] + a.to[2]) / 2];
          points.push([`${a.id} from`, a.from, 8], [`${a.id} to`, a.to, 8], [`${a.id} peak`, peak, 8]);
        }
        for (const [id, pt, half] of points) {
          const p = project(pose, pt, mobile);
          if (!p || p.x <= page.x0 || p.x >= page.x1) continue;
          if (p.y - half * p.scale < -0.5 || p.y + half * p.scale > page.h + 0.5) bad.push(`${id} at ${t.toFixed(3)}: y ${p.y.toFixed(0)}`);
        }
      }
      expect(bad.slice(0, 20)).toEqual([]);
    }, 240_000);

    // The edge rule is kept by composing the holds, not by hiding what they are about: every hold's own window is shown,
    // whole and at full opacity, from the moment the camera lands until it sets off.
    test(`every hold shows its windows whole${mobile ? " (mobile)" : ""}`, () => {
      CAMERA.forEach((h, i) => {
        const ids = h.sees;
        for (let t = h.t0; t <= h.t1; t += 0.05) {
          for (const id of ids) expect(presence(id, t, mobile).o, `${id} at ${t.toFixed(2)} (hold ${i})`).toBe(1);
        }
      });
    });
  }

  // A surface is rendered whenever it is shown and any of it lands within the page (a 1440px window: 350 stage px either side of the box).
  test("no surface is culled while the camera can see it", () => {
    const view = { x0: -350, x1: 1630, y0: 0, y1: STAGE_SIZE.desktop.h };
    for (let t = 0; t < DURATION; t += 0.05) {
      const { pose } = cameraAt(t);
      for (const sf of SURFACES) {
        if (presence(sf.id, t).o <= 0) continue;
        const pts = [[0, 0], [sf.w, 0], [0, sf.h], [sf.w, sf.h]].map(([x, y]) => project(pose, surfacePt(sf.id, x, y)));
        if (pts.some((p) => !p)) continue;
        const xs = pts.map((p) => p!.x);
        const ys = pts.map((p) => p!.y);
        const seen = Math.max(...xs) > view.x0 && Math.min(...xs) < view.x1 && Math.max(...ys) > view.y0 && Math.min(...ys) < view.y1;
        if (seen) expect(isLive(sf.id, t), `${sf.id} rendered at ${t.toFixed(2)}`).toBe(true);
      }
    }
  }, 60_000);
});
