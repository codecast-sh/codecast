// The wide leaf's cells (store.stageWide): the leaf spans the stage less one
// rail per sibling, siblings before it fold to the left edge and those after
// it to the right, and the tree is never rewritten.
// Run: bun test --timeout 240000 store/stageSplit.wide.test.ts
import { describe, expect, test } from "bun:test";
import { STAGE_RAIL_PX, stageWideCells, type StageNode } from "./stageSplit";

const leaf = (id: string, path: string): StageNode => ({ type: "leaf", id, path });
const row = (children: StageNode[], sizes: number[]): StageNode => ({ type: "split", id: "b", dir: "row", children, sizes });

describe("stageWideCells", () => {
  test("two panes: the sibling before folds to the left edge, the leaf takes the rest", () => {
    const root = row([leaf("inbox", "/inbox"), leaf("org", "/org")], [40, 60]);
    const cells = stageWideCells(root, "org")!;
    expect(cells.map((c) => [c.id, c.rail, c.style.left, c.style.width])).toEqual([
      ["inbox", "left", "0px", `${STAGE_RAIL_PX}px`],
      ["org", null, `${STAGE_RAIL_PX}px`, `calc(100% - ${STAGE_RAIL_PX}px)`],
    ]);
    expect(cells.every((c) => c.style.top === "0%" && c.style.height === "100%")).toBe(true);
    // The sizes are not rewritten: leaving restores the arrangement exactly.
    expect((root as any).sizes).toEqual([40, 60]);
  });

  test("three panes: one rail each side, the leaf between them", () => {
    const root = row([leaf("a", "/tasks"), leaf("org", "/org"), leaf("b", "/docs")], [30, 40, 30]);
    const cells = stageWideCells(root, "org", 36)!;
    expect(cells.map((c) => [c.id, c.rail, c.style.left, c.style.width])).toEqual([
      ["a", "left", "0px", "36px"],
      ["org", null, "36px", "calc(100% - 72px)"],
      ["b", "right", "calc(100% - 36px)", "36px"],
    ]);
  });

  test("a nested column reads in tree order; the leaf last takes everything but the rails before it", () => {
    const root: StageNode = { type: "split", id: "r", dir: "row", sizes: [50, 50], children: [
      { type: "split", id: "c", dir: "col", sizes: [50, 50], children: [leaf("a", "/tasks"), leaf("b", "/docs")] },
      leaf("org", "/org"),
    ] };
    const cells = stageWideCells(root, "org", 36)!;
    expect(cells.map((c) => [c.id, c.rail, c.style.left])).toEqual([["a", "left", "0px"], ["b", "left", "36px"], ["org", null, "72px"]]);
    expect(cells[2].style.width).toBe("calc(100% - 72px)");
  });

  test("nothing to fold: a leaf not in the tree, or alone", () => {
    expect(stageWideCells(row([leaf("a", "/tasks"), leaf("b", "/docs")], [50, 50]), "org")).toBeNull();
    expect(stageWideCells(leaf("org", "/org"), "org")).toBeNull();
  });
});
