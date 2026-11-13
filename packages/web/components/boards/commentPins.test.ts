import { describe, expect, test } from "bun:test";
import { pinPoint, pinPoints } from "./commentThreads";
import type { BoardEl } from "./boardTypes";

const sticky = { key: "s", kind: "sticky", rev: 1, x: 0, y: 0, w: 200, h: 160 } as BoardEl;
const byKey = new Map([["s", sticky]]);
const c = (key: string, f: Record<string, unknown>) => ({ key, kind: "comment", rev: 1, ...f }) as any;

describe("comment pins", () => {
  test("a comment dropped on an element stays where it was dropped", () => {
    expect(pinPoint(c("a", { anchor: "s", point: { x: 90, y: 70 } }), byKey)).toEqual({ x: 90, y: 70 });
  });
  test("once the element moves off the drop spot, the pin goes to its corner", () => {
    const moved = new Map([["s", { ...sticky, x: 500 }]]);
    expect(pinPoint(c("a", { anchor: "s", point: { x: 90, y: 70 } }), moved)).toEqual({ x: 692, y: -8 });
  });
  test("pins on one spot fan out so each thread shows", () => {
    const pts = pinPoints([{ root: c("a", { anchor: "s" }) }, { root: c("b", { anchor: "s" }) }], byKey);
    expect(pts.get("a")).toEqual({ x: 192, y: -8 });
    expect(pts.get("b")).toEqual({ x: 166, y: -8 });
  });
});

describe("fitting with pins", () => {
  test("a pin near the content is framed; one out in empty space is not", async () => {
    const { fitBox } = await import("./boardFrame");
    expect(fitBox([sticky], byKey, [{ x: 210, y: -10 }])).toEqual({ x: 0, y: -46, w: 246, h: 206 });
    expect(fitBox([sticky], byKey, [{ x: -110, y: -194 }])).toEqual({ x: 0, y: 0, w: 200, h: 160 });
  });
});
