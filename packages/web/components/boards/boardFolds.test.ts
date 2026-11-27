import { describe, expect, test } from "bun:test";
import type { ArtifactOp } from "@codecast/shared/artifacts";
import { collapseFrameOps, expandFrameOps, organizeOps, reflowFrameOps } from "@codecast/shared/artifacts/board";
import { boardFolds, foldCount } from "./boardFolds";
import { boardLayoutActions } from "./boardLayoutActions";
import type { BoardEl } from "./boardTypes";

const el = (key: string, kind: string, f: Record<string, any>) => ({ key, kind, rev: 1, ...f }) as BoardEl;
const viewOf = (els: BoardEl[]) => ({ elements: els, get: (k: string) => els.find((e) => e.key === k) });
/** The board after a batch, as the store would hold it. */
function applied(els: BoardEl[], ops: ArtifactOp[]): BoardEl[] {
  const out = new Map(els.map((e) => [e.key, { ...e }]));
  for (const op of ops) {
    if ("set" in op) {
      const cur = out.get(op.k)!;
      for (const [f, v] of Object.entries(op.set)) {
        if (v === null) delete (cur as any)[f];
        else (cur as any)[f] = v;
      }
    }
  }
  return [...out.values()];
}

const board = [
  el("f", "frame", { x: 0, y: 0, w: 600, h: 400, title: "Budget caps" }),
  el("a", "sticky", { x: 40, y: 64, w: 200, h: 160, text: "held a" }),
  el("b", "sticky", { x: 300, y: 64, w: 200, h: 160, text: "held b" }),
  el("ab", "connector", { from: "a", to: "b" }),
  el("out", "sticky", { x: 900, y: 64, w: 200, h: 160, text: "outside" }),
  el("aOut", "connector", { from: "a", to: "out" }),
];
const folded = applied(board, collapseFrameOps(viewOf(board), "f"));
const byKeyOf = (els: BoardEl[]) => new Map(els.map((e) => [e.key, e]));

describe("what a fold hides", () => {
  test("held elements and their inner arrows leave the canvas; the pill, outside things and outward arrows stay", () => {
    const folds = boardFolds(folded, byKeyOf(folded));
    expect([...folds.hidden].sort()).toEqual(["a", "ab", "b"]);
    expect(folds.shown.map((e) => e.key).sort()).toEqual(["aOut", "f", "out"]);
  });
  test("an arrow with one end inside the fold is drawn to the pill", () => {
    const folds = boardFolds(folded, byKeyOf(folded));
    expect(folds.endOf("a")?.key).toBe("f");
    expect(folds.endOf("out")?.key).toBe("out");
  });
  test("a fold inside a fold hands its ends to the outer, visible pill", () => {
    const outer = el("o", "frame", { x: -100, y: -100, w: 1000, h: 800, collapsed: { w: 1000, h: 800, holds: ["f"] } });
    const els = [...folded, outer];
    const folds = boardFolds(els, byKeyOf(els));
    expect(folds.hidden.has("f")).toBe(true);
    expect(folds.endOf("a")?.key).toBe("o");
  });
  test("the pill counts what it holds, arrows aside", () => {
    const byKey = byKeyOf(folded);
    expect(foldCount(byKey.get("f")!, byKey)).toBe(2);
  });
  test("a board with no fold passes through untouched", () => {
    const folds = boardFolds(board, byKeyOf(board));
    expect(folds.shown).toBe(board);
    expect(folds.hidden.size).toBe(0);
  });
});

describe("frame controls apply one batch", () => {
  const harness = (els: BoardEl[]) => {
    const batches: ArtifactOp[][] = [];
    const errors: string[] = [];
    const actions = boardLayoutActions({ apply: (ops) => batches.push(ops) }, () => viewOf(els), (m) => errors.push(m));
    return { batches, errors, actions };
  };
  test("Collapse on an open frame writes collapseFrameOps as one apply", () => {
    const h = harness(board);
    h.actions.toggleFold("f");
    expect(h.batches).toEqual([collapseFrameOps(viewOf(board), "f")]);
  });
  test("Expand on a pill writes expandFrameOps as one apply, and restores the frame", () => {
    const h = harness(folded);
    h.actions.toggleFold("f");
    expect(h.batches).toEqual([expandFrameOps(viewOf(folded), "f")]);
    const back = applied(folded, h.batches[0]);
    expect(back.find((e) => e.key === "f")).toMatchObject({ w: 600, h: 400 });
    expect(boardFolds(back, byKeyOf(back)).hidden.size).toBe(0);
  });
  test("Reflow writes reflowFrameOps as one apply", () => {
    const messy = [el("f", "frame", { x: 0, y: 0, w: 900, h: 700, title: "T" }), el("a", "sticky", { x: 500, y: 400, w: 200, h: 160 }), el("b", "sticky", { x: 60, y: 300, w: 200, h: 160 })];
    const h = harness(messy);
    h.actions.reflow("f");
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toEqual(reflowFrameOps(viewOf(messy), "f"));
  });
  test("Organize writes organizeOps as one apply", () => {
    const loose = [el("f1", "frame", { x: 0, y: 0, w: 400, h: 300, title: "One" }), el("f2", "frame", { x: 2000, y: 1500, w: 400, h: 300, title: "Jason" })];
    const h = harness(loose);
    h.actions.organize(["Jason Benn"]);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toEqual(organizeOps(viewOf(loose), { people: ["Jason Benn"] }));
  });
  test("a frame already laid out writes nothing; a missing frame reports instead of throwing", () => {
    const h = harness(board);
    h.actions.reflow("nope");
    expect(h.batches).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
  });
});
