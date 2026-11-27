import { describe, expect, test } from "bun:test";
import {
  activeGroup,
  alternateTab,
  cycleGroup,
  equalizeGroups,
  exchangeGroup,
  focusGroupId,
  maximizeGroup,
  moveGroupToEdge,
  previousGroup,
  resizeGroup,
  rotateGroups,
  MIN_GROUP_SIZE,
  groupRects,
  lanesOf,
  setSizes,
  closeOthers,
  closeTab,
  closeToRight,
  cycleTab,
  emptyWorkspace,
  forgetPath,
  renamePath,
  gotoTab,
  keepOpen,
  moveTab,
  mruTabs,
  neighborGroup,
  onlyGroup,
  openTab,
  reopenClosed,
  reviveWorkspace,
  serializeWorkspace,
  splitTo,
  togglePinned,
  type Workspace,
} from "./model";

const paths = (ws: Workspace, i = 0) => ws.groups[i].tabs.map((t) => (t.preview ? `*${t.path}` : t.pinned ? `^${t.path}` : t.path));

describe("tabs", () => {
  test("a preview open replaces the group's preview; a kept open does not", () => {
    let ws = openTab(emptyWorkspace(), "a.ts", { preview: true });
    ws = openTab(ws, "b.ts", { preview: true });
    expect(paths(ws)).toEqual(["*b.ts"]);
    ws = keepOpen(ws, "g1", "b.ts");
    ws = openTab(ws, "c.ts", { preview: true });
    expect(paths(ws)).toEqual(["b.ts", "*c.ts"]);
    ws = openTab(ws, "c.ts");
    expect(paths(ws)).toEqual(["b.ts", "c.ts"]);
  });

  test("new tabs land right of the active one", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = openTab(ws, "b");
    ws = openTab(ws, "c");
    ws = openTab(ws, "a");
    ws = openTab(ws, "d");
    expect(paths(ws)).toEqual(["a", "d", "b", "c"]);
  });

  test("closing shows the most recently used tab, and reopen puts it back", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = openTab(ws, "b");
    ws = openTab(ws, "c");
    ws = openTab(ws, "a");
    ws = closeTab(ws, "g1", "a");
    expect(activeGroup(ws).active).toBe("c");
    ws = reopenClosed(ws);
    expect(paths(ws)).toEqual(["a", "b", "c"]);
    expect(activeGroup(ws).active).toBe("a");
  });

  test("close others and to the right keep pinned tabs", () => {
    let ws = emptyWorkspace();
    for (const p of ["a", "b", "c", "d"]) ws = openTab(ws, p);
    ws = togglePinned(ws, "g1", "c");
    expect(paths(ws)).toEqual(["^c", "a", "b", "d"]);
    expect(paths(closeOthers(ws, "g1", "b"))).toEqual(["^c", "b"]);
    expect(paths(closeToRight(ws, "g1", "a"))).toEqual(["^c", "a"]);
  });

  test("reorder within a group respects the pinned line", () => {
    let ws = emptyWorkspace();
    for (const p of ["a", "b", "c"]) ws = openTab(ws, p);
    expect(paths(moveTab(ws, "g1", "c", "g1", 0))).toEqual(["c", "a", "b"]);
    expect(paths(moveTab(ws, "g1", "a", "g1", 3))).toEqual(["b", "c", "a"]);
    ws = togglePinned(ws, "g1", "a");
    expect(paths(moveTab(ws, "g1", "c", "g1", 0))).toEqual(["^a", "c", "b"]);
  });

  test("goto and cycle", () => {
    let ws = emptyWorkspace();
    for (const p of ["a", "b", "c"]) ws = openTab(ws, p);
    expect(activeGroup(gotoTab(ws, 0)).active).toBe("a");
    expect(activeGroup(gotoTab(ws, 8)).active).toBe("c");
    expect(activeGroup(cycleTab(ws, 1)).active).toBe("a");
    expect(activeGroup(cycleTab(ws, -1)).active).toBe("b");
  });
});

describe("groups", () => {
  test("split opens beside, up to three, then refuses", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = splitTo(ws, "g1", "a", "right");
    ws = splitTo(ws, "g2", "b", "right");
    expect(ws.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    expect(ws.activeGroup).toBe("g3");
    expect(splitTo(ws, "g3", "c", "right")).toBe(ws);
    expect(splitTo(ws, "g3", "c", "down")).toBe(ws);
  });

  test(":sp after :vs divides the group in its column; the other column keeps its width", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = splitTo(ws, "g1", "b", "right");
    ws = setSizes(ws, null, [30, 70]);
    ws = splitTo(ws, "g2", "c", "down");
    expect(ws.orientation).toBe("horizontal");
    expect(lanesOf(ws).map((l) => l.count)).toEqual([1, 2]);
    expect(ws.sizes).toEqual([30, 70]);
    const r = groupRects(ws);
    expect(r.get("g3")).toEqual({ x: 0.3, y: 0.5, w: 0.7, h: 0.5 });
    // Focus walks the geometry.
    expect(neighborGroup(ws, "up")).toBe("g2");
    expect(neighborGroup(ws, "left")).toBe("g1");
    expect(neighborGroup(focusGroupId(ws, "g1"), "right")).toBe("g2");
    // Height commands act inside the column, width commands across columns.
    const taller = resizeGroup(ws, "height", 10);
    expect(lanesOf(taller)[1].sizes!.map(Math.round)).toEqual([40, 60]);
    expect(taller.sizes).toEqual([30, 70]);
    expect(resizeGroup(ws, "width", -10).sizes!.map(Math.round)).toEqual([40, 60]);
    // <C-w>x swaps within the column; <C-w>r rotates it.
    expect(exchangeGroup(ws).groups.map((g) => g.id)).toEqual(["g1", "g3", "g2"]);
    expect(rotateGroups(ws, 1).groups.map((g) => g.id)).toEqual(["g1", "g3", "g2"]);
    // Closing one of the stack gives its share back to the column.
    const closed = closeTab(ws, "g3", "c");
    expect(lanesOf(closed).map((l) => l.count)).toEqual([1, 1]);
    expect(closed.sizes).toEqual([30, 70]);
  });

  test("closing a column keeps the rest's proportions; one column of a stack becomes the stack", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = splitTo(ws, "g1", "b", "right");
    ws = splitTo(ws, "g2", "c", "right");
    ws = setSizes(ws, null, [20, 30, 50]);
    expect(closeTab(ws, "g1", "a").sizes!.map(Math.round)).toEqual([38, 63]);
    let v = openTab(emptyWorkspace(), "a");
    v = splitTo(v, "g1", "b", "right");
    v = splitTo(v, "g2", "c", "down");
    v = closeTab(v, "g1", "a");
    expect([v.orientation, lanesOf(v).map((l) => l.count)]).toEqual(["vertical", [1, 1]]);
  });

  test("a layout persists with its lanes and sizes", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = splitTo(ws, "g1", "b", "right");
    ws = splitTo(ws, "g2", "c", "down");
    ws = setSizes(ws, 1, [25, 75]);
    const back = reviveWorkspace(JSON.parse(JSON.stringify(serializeWorkspace(ws))))!;
    expect(back.lanes).toEqual([{ count: 1, sizes: null }, { count: 2, sizes: [25, 75] }]);
    // An older workspace with no lanes is one lane a group.
    expect(lanesOf(reviveWorkspace({ groups: [{ id: "g1", tabs: [{ path: "a" }] }, { id: "g2", tabs: [{ path: "b" }] }] })!).map((l) => l.count)).toEqual([1, 1]);
  });

  test("an emptied group collapses and focus moves to its neighbor", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = splitTo(ws, "g1", "b", "right");
    ws = closeTab(ws, "g2", "b");
    expect(ws.groups.length).toBe(1);
    expect(ws.activeGroup).toBe("g1");
  });

  test("moving the last tab out of a group collapses it", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = splitTo(ws, "g1", "b", "right");
    ws = moveTab(ws, "g2", "b", "g1", 0);
    expect(ws.groups.length).toBe(1);
    expect(paths(ws)).toEqual(["b", "a"]);
    expect(ws.closed).toEqual([]);
  });

  test("neighbors follow the orientation, and :only closes the rest", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = splitTo(ws, "g1", "b", "down");
    expect(ws.orientation).toBe("vertical");
    expect(neighborGroup(ws, "up")).toBe("g1");
    expect(neighborGroup(ws, "left")).toBeNull();
    ws = onlyGroup(ws, "g1");
    expect(ws.groups.map((g) => g.id)).toEqual(["g1"]);
    expect(ws.closed[0].path).toBe("b");
  });

  test("vim's window commands: cycle, previous, exchange, rotate, edges", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = splitTo(ws, "g1", "b", "right");
    ws = splitTo(ws, "g2", "c", "right");
    expect(ws.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    expect(cycleGroup(ws, 1)).toBe("g1");
    expect(cycleGroup(ws, -1)).toBe("g2");
    ws = focusGroupId(ws, "g1");
    expect(previousGroup(ws)).toBe("g3");
    // <C-w>x in the first place swaps with the next; focus stays in place.
    const x = exchangeGroup(ws);
    expect(x.groups.map((g) => g.id)).toEqual(["g2", "g1", "g3"]);
    expect(x.activeGroup).toBe("g2");
    expect(rotateGroups(ws, 1).groups.map((g) => g.id)).toEqual(["g3", "g1", "g2"]);
    expect(rotateGroups(ws, -1).groups.map((g) => g.id)).toEqual(["g2", "g3", "g1"]);
    // <C-w>J: the group goes full width along the bottom; the rest stay side by side.
    const k = moveGroupToEdge(ws, "bottom");
    expect([k.orientation, k.groups.map((g) => g.id), lanesOf(k).map((l) => l.count)]).toEqual(["vertical", ["g2", "g3", "g1"], [2, 1]]);
    expect(neighborGroup(focusGroupId(k, "g3"), "down")).toBe("g1");
  });

  test("vim's window sizes: resize, maximize along the layout only, equalize", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = splitTo(ws, "g1", "b", "down");
    expect(resizeGroup(ws, "width", 5)).toBe(ws);
    ws = resizeGroup(ws, "height", -10);
    expect(ws.sizes!.map(Math.round)).toEqual([60, 40]);
    ws = maximizeGroup(ws, "height");
    expect(ws.sizes!.map(Math.round)).toEqual([MIN_GROUP_SIZE, 100 - MIN_GROUP_SIZE]);
    expect(maximizeGroup(ws, "width")).toBe(ws);
    expect(equalizeGroups(ws).sizes).toBeNull();
  });

  test("the alternate file is the tab used before, in this group first", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = openTab(ws, "b");
    ws = splitTo(ws, "g1", "c", "right");
    expect(alternateTab(ws)).toEqual({ groupId: "g1", path: "b" });
    ws = focusGroupId(ws, "g1");
    expect(alternateTab(ws)).toEqual({ groupId: "g1", path: "a" });
    expect(alternateTab(openTab(emptyWorkspace(), "a"))).toBeNull();
  });

  test("mru lists every open tab, the focused first", () => {
    let ws = openTab(emptyWorkspace(), "a");
    ws = openTab(ws, "b");
    ws = splitTo(ws, "g1", "a", "right");
    expect(mruTabs(ws)).toEqual([
      { groupId: "g2", path: "a" },
      { groupId: "g1", path: "b" },
      { groupId: "g1", path: "a" },
    ]);
  });
});

test("round trips through persistence, dropping reveal requests and junk", () => {
  let ws = openTab(emptyWorkspace(), "a", { at: "4" });
  ws = splitTo(ws, "g1", "b", "right");
  const back = reviveWorkspace(JSON.parse(JSON.stringify(serializeWorkspace(ws))))!;
  expect(back.groups.map((g) => g.tabs.map((t) => t.path))).toEqual([["a"], ["b"]]);
  expect(back.groups[0].reveal).toBeUndefined();
  expect(back.activeGroup).toBe("g2");
  expect(reviveWorkspace({ groups: "x" })).toBeNull();
  expect(reviveWorkspace({ groups: [{ id: "g1", tabs: [{ path: "a" }, { path: "a" }, 3], active: "zz" }] })!.groups[0]).toEqual({
    id: "g1",
    tabs: [{ path: "a" }],
    active: "a",
  });
});

test("a rename moves tabs, history and the closed stack; a delete forgets the path", () => {
  let ws = openTab(emptyWorkspace(), "src/a.ts");
  ws = openTab(ws, "src/b.ts");
  ws = splitTo(ws, "g1", "src/a.ts", "right");
  ws = closeTab(ws, "g1", "src/b.ts");
  ws = renamePath(ws, "src", "lib");
  expect(ws.groups.map((g) => g.tabs.map((t) => t.path))).toEqual([["lib/a.ts"], ["lib/a.ts"]]);
  expect(ws.closed.map((c) => c.path)).toEqual(["lib/b.ts"]);
  expect(ws.mru.every((k) => k.includes("lib/"))).toBe(true);

  const kept = forgetPath(ws, "lib/a.ts", { keepTabs: true });
  expect(kept.groups.length).toBe(2);
  const gone = forgetPath(forgetPath(ws, "lib/a.ts"), "lib/b.ts");
  expect(gone.groups.length).toBe(1);
  expect(gone.groups[0].tabs).toEqual([]);
  expect(gone.closed).toEqual([]);
});
