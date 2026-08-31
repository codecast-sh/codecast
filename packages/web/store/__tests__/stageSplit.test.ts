import { describe, expect, test } from "bun:test";
import {
  insertLeaf,
  leafNode,
  leavesOf,
  countLeaves,
  normalize,
  removeLeaf,
  resolveDropZone,
  sanitizeLayout,
  setBranchSizes,
  setLeafPath,
  stageGeometry,
  predictDrop,
  MAX_STAGE_LEAVES,
  type StageBranch,
  type StageNode,
} from "../stageSplit";

const leaf = (path: string, id: string) => leafNode(path, id);

describe("insertLeaf", () => {
  test("splitting a lone leaf right makes a 50/50 row with the newcomer second", () => {
    const res = insertLeaf(leaf("/tasks", "a"), { leafId: "a" }, "right", "/inbox")!;
    expect(res.root.type).toBe("split");
    const b = res.root as StageBranch;
    expect(b.dir).toBe("row");
    expect(leavesOf(b).map((l) => l.path)).toEqual(["/tasks", "/inbox"]);
    expect(b.sizes).toEqual([50, 50]);
    expect(res.leafId).toBe(leavesOf(b)[1].id);
  });

  test("left/top place the newcomer first", () => {
    const r1 = insertLeaf(leaf("/tasks", "a"), { leafId: "a" }, "left", "/inbox")!;
    expect(leavesOf(r1.root).map((l) => l.path)).toEqual(["/inbox", "/tasks"]);
    const r2 = insertLeaf(leaf("/tasks", "a"), { leafId: "a" }, "top", "/inbox")!;
    expect((r2.root as StageBranch).dir).toBe("col");
    expect(leavesOf(r2.root).map((l) => l.path)).toEqual(["/inbox", "/tasks"]);
  });

  test("splitting along the parent's own direction shares the leaf's slot instead of nesting", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const bId = leavesOf(two.root)[1].id;
    const three = insertLeaf(two.root, { leafId: bId }, "right", "/c")!;
    const b = three.root as StageBranch;
    expect(b.children).toHaveLength(3);
    expect(b.children.every((c) => c.type === "leaf")).toBe(true);
    expect(b.sizes[0]).toBeCloseTo(50);
    expect(b.sizes[1]).toBeCloseTo(25);
    expect(b.sizes[2]).toBeCloseTo(25);
  });

  test("cross-direction split nests one level", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const bId = leavesOf(two.root)[1].id;
    const mixed = insertLeaf(two.root, { leafId: bId }, "bottom", "/c")!;
    const root = mixed.root as StageBranch;
    expect(root.dir).toBe("row");
    const right = root.children[1] as StageBranch;
    expect(right.type).toBe("split");
    expect(right.dir).toBe("col");
    expect(leavesOf(right).map((l) => l.path)).toEqual(["/b", "/c"]);
  });

  test("root split wraps the whole arrangement and favors the incumbent", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const res = insertLeaf(two.root, "root", "bottom", "/c")!;
    const root = res.root as StageBranch;
    expect(root.dir).toBe("col");
    expect(root.sizes[0]).toBeGreaterThan(root.sizes[1]);
    expect(leavesOf(root).map((l) => l.path)).toEqual(["/a", "/b", "/c"]);
  });

  test("root split along the root's own direction melts in as a sibling", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const res = insertLeaf(two.root, "root", "left", "/c")!;
    const root = res.root as StageBranch;
    expect(root.dir).toBe("row");
    expect(root.children).toHaveLength(3);
    expect(leavesOf(root)[0].path).toBe("/c");
    expect(root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  test("missing target returns null", () => {
    expect(insertLeaf(leaf("/a", "a"), { leafId: "zzz" }, "right", "/b")).toBeNull();
  });
});

describe("removeLeaf", () => {
  test("removing one of two hoists the survivor to the root", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const next = removeLeaf(two.root, "a")!;
    expect(next.type).toBe("leaf");
    expect((next as any).path).toBe("/b");
  });

  test("removing the last leaf returns null", () => {
    expect(removeLeaf(leaf("/a", "a"), "a")).toBeNull();
  });

  test("share flows back proportionally", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const bId = leavesOf(two.root)[1].id;
    const three = insertLeaf(two.root, { leafId: bId }, "right", "/c")!; // 50/25/25
    const next = removeLeaf(three.root, "a") as StageBranch; // b,c remain
    expect(next.sizes[0]).toBeCloseTo(50);
    expect(next.sizes[1]).toBeCloseTo(50);
  });

  test("removing from a nested branch hoists through", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const bId = leavesOf(two.root)[1].id;
    const mixed = insertLeaf(two.root, { leafId: bId }, "bottom", "/c")!;
    const cId = leavesOf(mixed.root)[2].id;
    const next = removeLeaf(mixed.root, cId) as StageBranch;
    expect(next.dir).toBe("row");
    expect(next.children.every((c) => c.type === "leaf")).toBe(true);
    expect(leavesOf(next).map((l) => l.path)).toEqual(["/a", "/b"]);
  });
});

describe("normalize", () => {
  test("same-direction nesting melts with scaled sizes", () => {
    const nested: StageNode = {
      type: "split",
      id: "p",
      dir: "row",
      sizes: [60, 40],
      children: [
        leaf("/a", "a"),
        { type: "split", id: "q", dir: "row", sizes: [50, 50], children: [leaf("/b", "b"), leaf("/c", "c")] },
      ],
    };
    const flat = normalize(nested) as StageBranch;
    expect(flat.children).toHaveLength(3);
    expect(flat.sizes[0]).toBeCloseTo(60);
    expect(flat.sizes[1]).toBeCloseTo(20);
    expect(flat.sizes[2]).toBeCloseTo(20);
  });

  test("single-child branch hoists", () => {
    const wrapped: StageNode = { type: "split", id: "p", dir: "col", sizes: [100], children: [leaf("/a", "a")] };
    expect(normalize(wrapped).type).toBe("leaf");
  });
});

describe("setLeafPath / setBranchSizes", () => {
  test("path updates only the target and keeps identity elsewhere", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const next = setLeafPath(two.root, "a", "/a2") as StageBranch;
    expect(leavesOf(next)[0].path).toBe("/a2");
    expect(leavesOf(next)[1]).toBe(leavesOf(two.root)[1]);
  });

  test("sizes renormalize and reject arity mismatches", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const id = (two.root as StageBranch).id;
    const next = setBranchSizes(two.root, id, [30, 90]) as StageBranch;
    expect(next.sizes[0]).toBeCloseTo(25);
    expect(next.sizes[1]).toBeCloseTo(75);
    expect(setBranchSizes(two.root, id, [10, 10, 10])).toBe(two.root);
  });
});

describe("stageGeometry", () => {
  test("a 50/50 row yields two half-width cells and one boundary", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const geo = stageGeometry(two.root);
    expect(geo.leaves[0].rect).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    expect(geo.leaves[1].rect).toEqual({ left: 50, top: 0, width: 50, height: 100 });
    expect(geo.handles).toHaveLength(1);
    expect(geo.handles[0].rect.left).toBe(50);
    expect(geo.handles[0].dir).toBe("row");
  });

  test("nested geometry composes", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const bId = leavesOf(two.root)[1].id;
    const mixed = insertLeaf(two.root, { leafId: bId }, "bottom", "/c")!;
    const geo = stageGeometry(mixed.root);
    const c = geo.leaves.find((l) => l.path === "/c")!;
    expect(c.rect).toEqual({ left: 50, top: 50, width: 50, height: 50 });
    expect(geo.handles).toHaveLength(2);
  });
});

describe("resolveDropZone", () => {
  const single = stageGeometry(leaf("/a", "a"));
  const stage = { width: 1000, height: 600 };

  test("center of a lone pane is center", () => {
    expect(resolveDropZone(single, stage, 500, 300)).toEqual({ kind: "center", leafId: "a" });
  });

  test("near an edge is an edge split", () => {
    expect(resolveDropZone(single, stage, 60, 300)).toEqual({ kind: "edge", leafId: "a", edge: "left" });
    expect(resolveDropZone(single, stage, 940, 300)).toEqual({ kind: "edge", leafId: "a", edge: "right" });
    expect(resolveDropZone(single, stage, 500, 40)).toEqual({ kind: "edge", leafId: "a", edge: "top" });
    expect(resolveDropZone(single, stage, 500, 560)).toEqual({ kind: "edge", leafId: "a", edge: "bottom" });
  });

  test("stage bounds become root splits only when already split", () => {
    expect(resolveDropZone(single, stage, 5, 300)!.kind).toBe("edge");
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const geo = stageGeometry(two.root);
    expect(resolveDropZone(geo, stage, 5, 300)).toEqual({ kind: "root", edge: "left" });
    expect(resolveDropZone(geo, stage, 500, 595)).toEqual({ kind: "root", edge: "bottom" });
  });
});

describe("predictDrop", () => {
  test("edge prediction returns the newcomer's cell", () => {
    const root = leaf("/a", "a");
    const p = predictDrop(root, { kind: "edge", leafId: "a", edge: "right" }, "/b")!;
    const cell = p.geometry.leaves.find((l) => l.id === p.newLeafId)!;
    expect(cell.rect.left).toBe(50);
    expect(cell.rect.width).toBe(50);
  });

  test("center prediction keeps geometry and targets the hovered leaf", () => {
    const root = leaf("/a", "a");
    const p = predictDrop(root, { kind: "center", leafId: "a" }, "/b")!;
    expect(p.newLeafId).toBe("a");
    expect(p.geometry.leaves).toHaveLength(1);
  });

  test("at the leaf cap edge drops predict nothing", () => {
    let root: StageNode = leaf("/a", "a");
    let lastId = "a";
    for (let i = 0; i < MAX_STAGE_LEAVES - 1; i++) {
      const r = insertLeaf(root, { leafId: lastId }, "right", `/p${i}`)!;
      root = r.root;
      lastId = r.leafId;
    }
    expect(countLeaves(root)).toBe(MAX_STAGE_LEAVES);
    expect(predictDrop(root, { kind: "edge", leafId: lastId, edge: "right" }, "/x")).toBeNull();
    expect(predictDrop(root, { kind: "center", leafId: lastId }, "/x")).not.toBeNull();
  });
});

describe("sanitizeLayout", () => {
  test("round-trips a real tree", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const back = sanitizeLayout(JSON.parse(JSON.stringify(two.root)));
    expect(back).toBeDefined();
    expect(leavesOf(back!).map((l) => l.path)).toEqual(["/a", "/b"]);
  });

  test("rejects malformed shapes, duplicate ids, and bad paths", () => {
    expect(sanitizeLayout(null)).toBeUndefined();
    expect(sanitizeLayout({ type: "leaf", id: "", path: "/a" })).toBeUndefined();
    expect(
      sanitizeLayout({
        type: "split", id: "p", dir: "row", sizes: [50, 50],
        children: [{ type: "leaf", id: "x", path: "/a" }, { type: "leaf", id: "x", path: "/b" }],
      }),
    ).toBeUndefined();
    expect(
      sanitizeLayout({ type: "leaf", id: "x", path: "/settings" }, (p) => p !== "/settings"),
    ).toBeUndefined();
  });

  test("rejects a tree over the leaf cap", () => {
    let root: StageNode = leaf("/a", "a");
    let lastId = "a";
    for (let i = 0; i < MAX_STAGE_LEAVES; i++) {
      const r = insertLeaf(root, { leafId: lastId }, "right", `/p${i}`)!;
      root = r.root;
      lastId = r.leafId;
    }
    expect(sanitizeLayout(JSON.parse(JSON.stringify(root)))).toBeUndefined();
  });
});

describe("geometry tiling property", () => {
  // Whatever sequence of splits builds the tree, the leaf rects must tile the
  // stage exactly: full area, no overlaps, all within bounds. This is the
  // contract the flat renderer and the drop preview both stand on.
  test("random trees tile 100x100 exactly", () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const edges = ["left", "right", "top", "bottom"] as const;
    for (let trial = 0; trial < 40; trial++) {
      let root: StageNode = leaf("/p0", `t${trial}_0`);
      for (let i = 1; i < MAX_STAGE_LEAVES; i++) {
        const targets = leavesOf(root);
        const target = targets[Math.floor(rand() * targets.length)];
        const edge = edges[Math.floor(rand() * 4)];
        const useRoot = rand() < 0.25;
        const res = insertLeaf(root, useRoot ? "root" : { leafId: target.id }, edge, `/p${i}`)!;
        root = res.root;
      }
      const { leaves } = stageGeometry(root);
      const area = leaves.reduce((a, l) => a + l.rect.width * l.rect.height, 0);
      expect(Math.abs(area - 10000)).toBeLessThan(0.01);
      for (const l of leaves) {
        expect(l.rect.left).toBeGreaterThanOrEqual(-1e-6);
        expect(l.rect.top).toBeGreaterThanOrEqual(-1e-6);
        expect(l.rect.left + l.rect.width).toBeLessThanOrEqual(100 + 1e-6);
        expect(l.rect.top + l.rect.height).toBeLessThanOrEqual(100 + 1e-6);
      }
      // Pairwise: no two rects overlap (touching edges allowed).
      for (let a = 0; a < leaves.length; a++) {
        for (let b = a + 1; b < leaves.length; b++) {
          const A = leaves[a].rect, B = leaves[b].rect;
          const overlapX = Math.min(A.left + A.width, B.left + B.width) - Math.max(A.left, B.left);
          const overlapY = Math.min(A.top + A.height, B.top + B.height) - Math.max(A.top, B.top);
          expect(Math.min(overlapX, overlapY)).toBeLessThan(0.01);
        }
      }
    }
  });

  test("normalize is idempotent", () => {
    const two = insertLeaf(leaf("/a", "a"), { leafId: "a" }, "right", "/b")!;
    const bId = leavesOf(two.root)[1].id;
    const three = insertLeaf(two.root, { leafId: bId }, "bottom", "/c")!;
    const once = normalize(three.root);
    expect(normalize(once)).toEqual(once);
  });
});
