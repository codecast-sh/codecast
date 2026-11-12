import { describe, expect, test } from "bun:test";
import { nextStickySpot } from "./boardPlacement";
import type { BoardEl } from "./boardTypes";

const el = (key: string, kind: string, f: Record<string, unknown>) => ({ key, kind, rev: 1, ...f }) as BoardEl;
const s = (key: string, x: number, y: number) => el(key, "sticky", { x, y, w: 200, h: 160 });

describe("Tab places the next sticky", () => {
  test("beside the current one on an open canvas, past what is there", () => {
    const els = [s("a", 0, 0), s("b", 224, 0)];
    expect(nextStickySpot({ x: 0, y: 0, w: 200, h: 160 }, 160, 1, els)).toEqual({ x: 448, y: 0 });
  });
  test("inside a frame the row wraps at the frame's edge and the frame grows", () => {
    const els = [el("f", "frame", { x: -24, y: -24, w: 472, h: 208 }), s("a", 0, 0), s("b", 224, 0), el("g", "frame", { x: 520, y: -24, w: 400, h: 300 })];
    const r = nextStickySpot({ x: 224, y: 0, w: 200, h: 160 }, 160, 1, els);
    expect(r.x).toBe(0);
    expect(r.y).toBe(184);
    expect(r.growFrame).toEqual({ key: "f", h: 392 });
  });
  test("on an open canvas the fifth in a row starts the next row", () => {
    const row = [s("a", 0, 0), s("b", 224, 0), s("c", 448, 0), s("d", 672, 0)];
    expect(nextStickySpot({ x: 672, y: 0, w: 200, h: 160 }, 160, 1, row)).toEqual({ x: 0, y: 184 });
  });
});
