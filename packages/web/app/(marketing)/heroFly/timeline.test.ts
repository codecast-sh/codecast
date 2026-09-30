import { describe, expect, test } from "bun:test";
import { DROP, SETTLE, SNAP, cameraAt, frame, typed } from "./timeline";
import { CAMERA, DURATION, SCENES, SURFACE_BY_ID, type SurfaceId, type V3 } from "./world";

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
  test("the loop seam is exact: frame(0) equals frame(36 - 1e-6)", () => {
    expectSameFrame(frame(0), frame(DURATION - 1e-6), 0.01);
    expectSameFrame(frame(0, true), frame(DURATION - 1e-6, true), 0.01);
  });

  test("frame is a pure function of t", () => {
    for (const t of [0, 1.2, 5.4, 12.4, 22.8, 29.7, 35.99]) {
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
  const HERO: (SurfaceId | null)[] = [null, "desk", "desk", "phone", null, "pairB", "board", "palette", "blame", "page", null];
  const rad = (d: number) => (d * Math.PI) / 180;
  const rotX = ([x, y, z]: V3, a: number): V3 => [x, y * Math.cos(rad(a)) - z * Math.sin(rad(a)), y * Math.sin(rad(a)) + z * Math.cos(rad(a))];
  const rotY = ([x, y, z]: V3, a: number): V3 => [x * Math.cos(rad(a)) + z * Math.sin(rad(a)), y, -x * Math.sin(rad(a)) + z * Math.cos(rad(a))];
  const rotZ = ([x, y, z]: V3, a: number): V3 => [x * Math.cos(rad(a)) - y * Math.sin(rad(a)), x * Math.sin(rad(a)) + y * Math.cos(rad(a)), z];

  for (const mobile of [false, true]) {
    test(`holds frame their hero surface near scale 1 and face-on${mobile ? " (mobile)" : ""}`, () => {
      CAMERA.forEach((h, i) => {
        const id = HERO[i];
        if (!id) return;
        const s = SURFACE_BY_ID[id];
        const { pose } = cameraAt((h.t0 + h.t1) / 2, mobile);
        const rel: V3 = [s.pos[0] - pose.x, s.pos[1] - pose.y, s.pos[2] - pose.z];
        const cam = rotX(rotY(rotZ(rel, pose.roll), pose.yaw), pose.pitch);
        const scale = 1800 / (1800 - (cam[2] + pose.dist));
        const lo = id === "pairB" || id === "board" ? 0.8 : mobile ? 0.95 : 0.93;
        expect(scale, `${id} scale at hold ${i}`).toBeGreaterThan(lo);
        expect(scale, `${id} scale at hold ${i}`).toBeLessThan(mobile ? 1.45 : 1.12);
        // The surface normal after the surface's own rotation and the camera's.
        let n: V3 = [0, 0, 1];
        n = rotX(rotY(rotZ(n, s.rot[2]), s.rot[1]), s.rot[0]);
        n = rotX(rotY(rotZ(n, pose.roll), pose.yaw), pose.pitch);
        const off = (Math.acos(Math.min(1, n[2])) * 180) / Math.PI;
        expect(off, `${id} angle at hold ${i}`).toBeLessThan(12);
      });
    });
  }
});
