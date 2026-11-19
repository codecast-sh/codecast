import { describe, expect, test } from "bun:test";
import { pageOps, pasteOps } from "./boardActions";
import { keepsAspect } from "./useBoardGestures";
import type { BoardEl } from "./boardTypes";

const sticky = (key: string, x: number, y: number): BoardEl => ({ key, kind: "sticky", rev: 1, x, y, w: 200, h: 160 } as BoardEl);

describe("page elements on the canvas", () => {
  test("a pasted share URL becomes a page centered on the pointer", () => {
    const { ops, keys } = pasteOps("  https://codecast.sh/a/Ab12Cd34Ef \n", { x: 1000, y: 1000 }, [], () => false);
    expect(keys).toHaveLength(1);
    expect((ops[0] as any).put).toMatchObject({ kind: "page", slug: "Ab12Cd34Ef", x: 680, y: 760, w: 640, h: 480 });
  });

  test("a URL among other lines stays text, a sticky per line", () => {
    const { ops } = pasteOps("see https://codecast.sh/a/Ab12Cd34Ef\nand this", { x: 0, y: 0 }, [], () => false);
    expect(ops.every((op: any) => op.put.kind === "sticky")).toBe(true);
  });

  test("a dropped page clears what is under it and lands on top", () => {
    const all = [{ ...sticky("a", 0, 0), z: 7 } as BoardEl];
    const { ops } = pageOps("Ab12Cd34Ef", { x: 100, y: 80 }, all);
    const p = (ops[0] as any).put;
    expect(p.z).toBe(8);
    const clear = p.x >= 224 || p.y >= 184 || p.x + p.w <= -24 || p.y + p.h <= -24;
    expect(clear).toBe(true);
  });

  test("a page resizes freely: its width and height are independent", () => {
    expect(keepsAspect(new Map([["p", { key: "p", kind: "page", rev: 1 } as BoardEl]]))).toBe(false);
  });
});
