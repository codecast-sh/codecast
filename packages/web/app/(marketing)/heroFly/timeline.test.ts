import { describe, expect, test } from "bun:test";
import { BEATS } from "./motion";
import { DROP, FACE_UP, LANDED, SETTLE, SNAP, cameraAt, frame, typed } from "./timeline";
import { CAMERA, CAMERA_MOBILE, DEALT, DURATION, FLIP_DUR, SCENES, SURFACES, SURFACE_BY_ID, type SurfaceId, type V3 } from "./world";

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
  });

  // The seam breathes: every card has landed face-down before the loop deals it again.
  test("the overview rests face-down for the film's last stretch", () => {
    for (let t = LANDED; t <= DURATION; t += 0.05) {
      for (const sf of SURFACES) {
        const angle = Number(/rotateX\((-?[\d.]+)deg\)/.exec(frame(Math.min(t, DURATION - 1e-6)).els[`card:${sf.id}`].transform ?? "")?.[1]);
        expect(angle, `${sf.id} at ${t.toFixed(2)}`).toBeCloseTo(180, 3);
      }
    }
    expect(DURATION - LANDED).toBeGreaterThanOrEqual(0.6 - 1e-9);
  });

  // The camera never flies toward a blank card: a surface turns face-up before the first hold that sees it,
  // and what it shows there is in place by the time the camera sets off (the previous hold's end, plus 0.2s).
  // The desk, the board and the phone open on content that is always there (rows, the plan, the lock screen),
  // and the team's channel opens on its history; every other surface fills from its chapter's beats.
  const STATIC: SurfaceId[] = ["desk", "board", "phone", "team"];
  test("every surface is face-up and filled before the camera reaches it", () => {
    CAMERA.forEach((h, k) => {
      if (h.sees === "all" || k === 0) return;
      const setOff = CAMERA[k - 1].t1 + 0.2;
      for (const id of h.sees) {
        expect(FACE_UP[id], `${id} turns before hold ${k} (${h.t0})`).toBeLessThan(h.t0);
        if (STATIC.includes(id)) continue;
        const filled = BEATS[id].filter((b) => b.preset !== "fadeIn" && b.preset !== "fadeOut").some((b) => b.cue <= setOff + 0.3);
        expect(filled, `${id} has content in place by ${(setOff + 0.3).toFixed(2)} for hold ${k} (${h.t0})`).toBe(true);
      }
    });
  });

  // A chapter opens on its product, not on a card's back: every chapter surface has finished turning half a second before the camera lands on it.
  test("every chapter surface has landed face-up 0.5s before its first hold", () => {
    for (const sf of SURFACES) {
      if (DEALT.includes(sf.id)) continue;
      const first = CAMERA.find((h) => h.sees !== "all" && h.sees.includes(sf.id))!;
      expect(FACE_UP[sf.id] + FLIP_DUR, `${sf.id} lands before ${first.t0}`).toBeLessThanOrEqual(first.t0 - 0.5 + 1e-9);
      const angle = Number(/rotateX\((-?[\d.]+)deg\)/.exec(frame(first.t0 - 0.5).els[`card:${sf.id}`].transform ?? "")?.[1]);
      expect(angle, `${sf.id} face-up at ${first.t0 - 0.5}`).toBeCloseTo(0, 3);
    }
  });

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
  const HERO: (SurfaceId | null)[] = [null, "desk", "desk", "desk", "pairA", "phone", null, "pairB", "desk", "board", "auto", "team", "pr", "page", "palette", "blame", "desk", null];

  test("every camera hold has a hero entry and a mobile override", () => {
    expect(HERO.length).toBe(CAMERA.length);
    expect(CAMERA_MOBILE.length).toBe(CAMERA.length);
  });

  test("every chapter holds the camera still for at least 3s", () => {
    SCENES.forEach((s) => {
      const held = CAMERA.filter((h) => h.t0 >= s.start && h.t0 < s.end && h.sees !== "all").reduce((n, h) => n + h.t1 - h.t0, 0);
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
        // Up to a third larger when a hold frames one region of its surface (the decision card, the Anywhere inset).
        expect(scale, `${id} scale at hold ${i}`).toBeLessThan(mobile ? 1.45 : 1.33);
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
