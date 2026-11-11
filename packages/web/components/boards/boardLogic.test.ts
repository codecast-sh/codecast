import { describe, expect, test } from "bun:test";
import { resizedBox, resizeOps, hitKey, withGroup } from "./useBoardGestures";
import { fitCam, zoomAround } from "./useBoardCamera";
import type { BoardEl } from "./boardTypes";

const el = (key: string, kind: string, f: Record<string, any>) => ({ key, kind, rev: 1, ...f }) as BoardEl;

describe("resize", () => {
  const b = { x: 0, y: 0, w: 200, h: 100 };
  test("corner and side handles move the right edges", () => {
    expect(resizedBox(b, "se", 50, 20, false)).toEqual({ x: 0, y: 0, w: 250, h: 120 });
    expect(resizedBox(b, "nw", 50, 20, false)).toEqual({ x: 50, y: 20, w: 150, h: 80 });
    expect(resizedBox(b, "e", 50, 999, false)).toEqual({ x: 0, y: 0, w: 250, h: 100 });
  });
  test("never collapses below the minimum and keeps aspect with shift", () => {
    expect(resizedBox(b, "e", -500, 0, false).w).toBe(16);
    const k = resizedBox(b, "se", 200, 0, true);
    expect(k.w / k.h).toBeCloseTo(2, 5);
  });
  test("multi-select scales positions and sizes into the new box", () => {
    const items = new Map([
      ["a", el("a", "sticky", { x: 0, y: 0, w: 100, h: 100 })],
      ["b", el("b", "sticky", { x: 100, y: 0, w: 100, h: 100 })],
    ]);
    const ops = resizeOps(items, { x: 0, y: 0, w: 200, h: 100 }, { x: 0, y: 0, w: 400, h: 100 }, "e");
    expect(ops).toEqual([
      { k: "a", set: { x: 0, y: 0, w: 200, h: 100 } },
      { k: "b", set: { x: 200, y: 0, w: 200, h: 100 } },
    ]);
  });
  test("text corner scales the type, side rewraps", () => {
    const items = new Map([["t", el("t", "text", { x: 0, y: 0, w: 100, text: "hi", size: 20 })]]);
    const from = { x: 0, y: 0, w: 100, h: 26 };
    expect((resizeOps(items, from, { x: 0, y: 0, w: 200, h: 52 }, "se")[0] as any).set.size).toBe(40);
    expect((resizeOps(items, from, { x: 0, y: 0, w: 200, h: 26 }, "e")[0] as any).set.size).toBeUndefined();
  });
  test("pens scale their points", () => {
    const items = new Map([["p", el("p", "pen", { x: 10, y: 10, points: [0, 0, 10, 10], width: 0 })]]);
    const op = resizeOps(items, { x: 10, y: 10, w: 10, h: 10 }, { x: 10, y: 10, w: 20, h: 20 }, "se")[0] as any;
    expect(op.set.points).toEqual([0, 0, 20, 20]);
  });
});

describe("camera", () => {
  test("fit centers the box and never zooms past the cap", () => {
    const c = fitCam({ x: 0, y: 0, w: 100, h: 100 }, 1000, 800);
    expect(c.z).toBe(1);
    expect(c.x).toBe(450);
    const big = fitCam({ x: 0, y: 0, w: 4000, h: 1000 }, 1000, 800, 80);
    expect(big.z).toBeCloseTo((1000 - 160) / 4000, 5);
  });
  test("zoom keeps the point under the cursor still", () => {
    const cam = { x: 100, y: 50, z: 1 };
    const at = { x: 300, y: 200 };
    const worldBefore = { x: (at.x - cam.x) / cam.z, y: (at.y - cam.y) / cam.z };
    const next = zoomAround(cam, 2, at);
    expect((at.x - next.x) / next.z).toBeCloseTo(worldBefore.x, 6);
    expect((at.y - next.y) / next.z).toBeCloseTo(worldBefore.y, 6);
  });
});

describe("hit and groups", () => {
  test("groups select together", () => {
    const m = new Map([["a", el("a", "sticky", { group: "g" })], ["b", el("b", "sticky", { group: "g" })], ["c", el("c", "sticky", {})]]);
    expect(withGroup("a", m).sort()).toEqual(["a", "b"]);
    expect(withGroup("c", m)).toEqual(["c"]);
  });
  test("hitKey on nothing is null", () => {
    expect(hitKey(null)).toBeNull();
  });
});
