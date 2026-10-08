import { describe, expect, it } from "bun:test";
import { bandOrigin, computeOrgViewport, FIT_PAD, fitTarget, hiddenRoots, MIN_READABLE_ZOOM, panIntoView } from "./orgViewport";
import { layoutGoals } from "./goalsLayout";
import { UNION_GOALS_DATA, UNION_GOALS_TREE } from "./goalsFixture";
import { layoutOrgTree, personNodeId } from "./orgLayout";
import { ORG_FIXTURE } from "./orgFixture";

const none = { collapsed: new Set<string>(), expanded: {} };
const nodes = layoutOrgTree(ORG_FIXTURE, none).nodes;

describe("computeOrgViewport", () => {
  it("anchors the tree to the top of the free canvas, not the vertical middle", () => {
    const vp = computeOrgViewport(nodes, 1600, 1000, 0, null)!;
    const topY = Math.min(...nodes.map((n) => n.y));
    // Root row lands at the top padding.
    expect(topY * vp.zoom + vp.y).toBeCloseTo(24, 5);
  });

  it("fits the whole tree when it stays readable and leaves the panel width free", () => {
    const open = computeOrgViewport(nodes, 1600, 1000, 380, null)!;
    const closed = computeOrgViewport(nodes, 1600, 1000, 0, null)!;
    expect(open.whole).toBe(true);
    // Everything drawn sits left of the panel.
    const right = Math.max(...nodes.map((n) => n.x + n.w));
    expect(right * open.zoom + open.x).toBeLessThanOrEqual(1600 - 380);
    // Opening the panel can only shrink or shift the tree, never grow it.
    expect(open.zoom).toBeLessThanOrEqual(closed.zoom);
  });

  it("refuses to fit below the readable floor and fits the root tier instead", () => {
    // A canvas far too narrow for the whole tree.
    const vp = computeOrgViewport(nodes, 700, 500, 0, personNodeId("fixture-user-me"))!;
    expect(vp.whole).toBe(false);
    expect(vp.zoom).toBeGreaterThanOrEqual(0.92);
    // Wider than the free area: the row starts at the left padding so the most
    // roots show, and the viewer (sorted first) is on screen.
    const left = Math.min(...nodes.map((n) => n.x));
    expect(left * vp.zoom + vp.x).toBeCloseTo(24, 5);
    const me = nodes.find((n) => n.id === personNodeId("fixture-user-me"))!;
    expect((me.x + me.w) * vp.zoom + vp.x).toBeLessThanOrEqual(700);
  });

  it("names the root cards clipped past each edge of the free canvas", () => {
    // Root-tier fit on a narrow canvas: the last person is off to the right.
    // The fixture's root tier is three cards (two people and a role) about 820
    // wide, so a 500 canvas at the readable floor clips the last one.
    const vp = computeOrgViewport(nodes, 500, 500, 0, null)!;
    const before = hiddenRoots(nodes, { x: vp.x, y: vp.y, zoom: vp.zoom }, 500);
    expect(before.left.length).toBe(0);
    expect(before.right.length).toBeGreaterThan(0);
    expect(before.right[0].kind).toBe("person");
    // Panned far right: the viewer's card falls off the left edge.
    const after = hiddenRoots(nodes, { x: vp.x - 2000, y: vp.y, zoom: vp.zoom }, 500);
    expect(after.left.some((n) => n.id === personNodeId("fixture-user-me"))).toBe(true);
  });
});

describe("fitTarget (the column a narrow pane fits first)", () => {
  const everything = layoutGoals({ tree: UNION_GOALS_TREE, initiatives: UNION_GOALS_DATA.initiatives, projects: UNION_GOALS_DATA.projects, people: "everyone" }, "mid").nodes;
  const spine = everything.filter((n) => n.kind !== "owner");
  const owners = everything.filter((n) => n.kind === "owner");
  const right = (ns: readonly { x: number; w: number }[]) => Math.max(...ns.map((n) => n.x + n.w));

  it("a wide pane fits both columns at the width they need", () => {
    const vp = computeOrgViewport(everything, 1600, 1000, 0, null)!;
    expect(vp.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
    expect(right(owners) * vp.zoom + vp.x).toBeLessThanOrEqual(1600 - FIT_PAD);
    expect(Math.min(...spine.map((n) => n.x)) * vp.zoom + vp.x).toBeGreaterThanOrEqual(FIT_PAD);
  });

  it("a 540px pane fits the outline at a readable zoom and leaves the owners to a pan", () => {
    const fit = fitTarget(everything, 540 - FIT_PAD * 2, 800 - FIT_PAD * 2)!;
    expect(fit.whole).toBe(false);
    expect(fit.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
    expect(fit.rect.w).toBe(right(spine) - Math.min(...spine.map((n) => n.x)));
    expect(fit.rect.w * fit.zoom).toBeLessThanOrEqual(540 - FIT_PAD * 2);
    // The viewport starts at the outline's left edge, with the owners off to the right.
    const vp = computeOrgViewport(everything, 540, 800, 0, null)!;
    expect(vp.zoom).toBe(fit.zoom);
    expect(Math.min(...spine.map((n) => n.x)) * vp.zoom + vp.x).toBeCloseTo(FIT_PAD, 5);
    expect(right(owners) * vp.zoom + vp.x).toBeGreaterThan(540);
    // The 12px labels on the cards never render under 11px.
    expect(12 * vp.zoom).toBeGreaterThanOrEqual(11);
    // Every owner the edge cuts, even in part, is counted for the fade and the pill.
    const cue = hiddenRoots(everything, vp, 540, (n) => n.kind === "owner");
    const cut = owners.filter((n) => (n.x + n.w) * vp.zoom + vp.x > 541);
    expect(cut.length).toBeGreaterThan(0);
    expect(cue.right.map((n) => n.id)).toEqual(cut.map((n) => n.id));
    expect(cue.left.length).toBe(0);
  });

  it("a card the edge cuts in part counts as hidden, so a half card never shows without a cue", () => {
    const row = [{ id: "a", kind: "person", x: 0, y: 0, w: 200, h: 80 }, { id: "b", kind: "person", x: 240, y: 0, w: 200, h: 80 }];
    const vp = { x: 0, y: 0, zoom: 1 };
    expect(hiddenRoots(row, vp, 340).right.map((n) => n.id)).toEqual(["b"]);
    expect(hiddenRoots(row, vp, 440).right.length).toBe(0);
    expect(hiddenRoots(row, { ...vp, x: -100 }, 1000).left.map((n) => n.id)).toEqual(["a"]);
  });

  it("the people chart still fits its root tier, never the outline rule", () => {
    const fit = fitTarget(nodes, 700 - FIT_PAD * 2, 500 - FIT_PAD * 2)!;
    expect(fit.whole).toBe(false);
    const roots = nodes.filter((n) => n.kind === "person" || n.kind === "role");
    expect(fit.rect.w).toBe(right(roots) - Math.min(...roots.map((n) => n.x)));
  });
});

describe("panIntoView (a focus pans by the least that shows the card)", () => {
  const everything = layoutGoals({ tree: UNION_GOALS_TREE, initiatives: UNION_GOALS_DATA.initiatives, projects: UNION_GOALS_DATA.projects, people: "everyone" }, "mid").nodes;
  const free = { w: 540, h: 800 };
  const fit = computeOrgViewport(everything, free.w, free.h, 0, null)!;
  const at = { x: fit.x, y: fit.y, zoom: fit.zoom };
  const spineLeft = Math.min(...everything.filter((n) => n.kind !== "owner").map((n) => n.x));
  const treeLeft = Math.min(...everything.map((n) => n.x));
  const treeRight = Math.max(...everything.map((n) => n.x + n.w));
  const box = (id: string, vp: { x: number; y: number; zoom: number }) => {
    const n = everything.find((b) => b.id === id)!;
    return { left: n.x * vp.zoom + vp.x, right: (n.x + n.w) * vp.zoom + vp.x, top: n.y * vp.zoom + vp.y, bottom: (n.y + n.h) * vp.zoom + vp.y };
  };

  it("a card already fully in view does not move the map", () => {
    const first = everything.find((n) => n.kind !== "owner" && box(n.id, at).bottom <= free.h)!;
    expect(panIntoView(everything, first.id, at, free)).toBeNull();
    // A card the chart does not draw asks for nothing either.
    expect(panIntoView(everything, "goal:nope", at, free)).toBeNull();
  });

  it("a card off to the right pans just far enough to show it, and never re-centres", () => {
    const owner = everything.find((n) => n.kind === "owner")!;
    const vp = panIntoView(everything, owner.id, at, free)!;
    expect(vp.zoom).toBe(at.zoom);
    expect(vp.y).toBe(at.y);
    const b = box(owner.id, vp);
    expect(b.right).toBeCloseTo(free.w - FIT_PAD, 5);
    // The tree is wider than the pane: its right edge is at or past the far pad, its left off to the left.
    expect(treeRight * vp.zoom + vp.x).toBeGreaterThanOrEqual(free.w - FIT_PAD);
    expect(treeLeft * vp.zoom + vp.x).toBeLessThanOrEqual(FIT_PAD);
  });

  it("a card below the fold pans down by the least, and keeps the outline's left edge", () => {
    const low = [...everything].filter((n) => n.kind !== "owner").sort((a, b) => b.y - a.y)[0];
    const vp = panIntoView(everything, low.id, at, free)!;
    expect(vp.x).toBe(at.x);
    expect(box(low.id, vp).bottom).toBeCloseTo(free.h - FIT_PAD, 5);
    expect(spineLeft * vp.zoom + vp.x).toBeCloseTo(FIT_PAD, 5);
  });

  it("a tree wider than the pane never has its left edge right of the pad: the pan is clamped", () => {
    // The viewer has dragged the picture far to the right; a focus on the first
    // card (now off the left) lands it at the pad, not in the middle.
    const dragged = { ...at, x: at.x + 400 };
    const first = everything[0];
    const vp = panIntoView(everything, first.id, dragged, free)!;
    expect(treeLeft * vp.zoom + vp.x).toBeLessThanOrEqual(FIT_PAD + 1e-6);
    expect(box(first.id, vp).left).toBeCloseTo(FIT_PAD, 5);
    // Dragged the other way past the tree's end, a focus on the last owner
    // brings the right edge back to the far pad and no further.
    const last = [...everything].filter((n) => n.kind === "owner").sort((a, b) => b.y - a.y)[0];
    const over = { ...at, x: at.x - (treeRight * at.zoom + at.x) - 300 };
    const back = panIntoView(everything, last.id, over, free)!;
    expect(treeRight * back.zoom + back.x).toBeGreaterThanOrEqual(free.w - FIT_PAD - 1e-6);
  });

  it("a tree that fits is never pushed out of the pane to show a card", () => {
    // A wide pane: both columns fit; a drag left took the first cards off screen.
    const wide = { w: 1600, h: 1000 };
    const fitWide = computeOrgViewport(everything, wide.w, wide.h, 0, null)!;
    const dragged = { x: fitWide.x - 600, y: fitWide.y, zoom: fitWide.zoom };
    const first = everything[0];
    const vp = panIntoView(everything, first.id, dragged, wide)!;
    expect(treeLeft * vp.zoom + vp.x).toBeGreaterThanOrEqual(FIT_PAD - 1e-6);
    expect(treeRight * vp.zoom + vp.x).toBeLessThanOrEqual(wide.w - FIT_PAD + 1e-6);
  });

  it("a bottom inset (the phone sheet) counts as covered: the card lands above it", () => {
    const sheet = Math.round(800 * 0.62);
    const low = [...everything].filter((n) => n.kind !== "owner").sort((a, b) => b.y - a.y)[0];
    const vp = panIntoView(everything, low.id, at, { w: 390, h: 800 - sheet })!;
    expect(box(low.id, vp).bottom).toBeLessThanOrEqual(800 - sheet);
  });
});

describe("a shallow, wide org (the This week map's 0.42 floor)", () => {
  // Ten roots in one row and a role under each: far wider than the pane, and short.
  const wide = Array.from({ length: 10 }, (_, i) => [
    { id: `person:${i}`, kind: "person", x: i * 280, y: 0, w: 240, h: 90 },
    { id: `role:${i}`, kind: "role", x: i * 280, y: 140, w: 240, h: 110 },
  ]).flat();

  it("does not shrink to a thumbnail it cannot fit anyway: it reads at full size from the left", () => {
    const fit = fitTarget(wide, 600 - FIT_PAD * 2, 1000 - FIT_PAD * 2, 0.42)!;
    expect(fit.whole).toBe(false);
    expect(fit.zoom).toBe(1);
    const vp = computeOrgViewport(wide, 600, 1000, 0, null, 0, 0.42)!;
    expect(vp.zoom).toBe(1);
    expect(vp.x).toBeCloseTo(FIT_PAD, 5);
    expect(vp.y).toBeCloseTo(FIT_PAD, 5);
    // The rest is reached by the edge pills.
    expect(hiddenRoots(wide as never, vp, 600).right.length).toBeGreaterThan(0);
  });

  it("a tall tree still never fits under the floor", () => {
    const tall = wide.map((n) => ({ ...n, y: n.y * 10, h: n.h * 10 }));
    expect(fitTarget(tall, 552, 952, 0.42)!.zoom).toBe(0.42);
  });

  it("a row that fits by width at the floor still fits by width", () => {
    const three = wide.filter((n) => Number(n.id.split(":")[1]) < 3);
    const fit = fitTarget(three, 552, 80, 0.42)!;
    expect(fit.whole).toBe(false);
    expect(fit.zoom).toBeCloseTo(552 / (2 * 280 + 240), 5);
  });
});

describe("panIntoView in center mode (the card whose sheet is open)", () => {
  const wide = Array.from({ length: 10 }, (_, i) => [
    { id: `person:${i}`, kind: "person", x: i * 280, y: 0, w: 240, h: 90 },
    { id: `role:${i}`, kind: "role", x: i * 280, y: 140, w: 240, h: 110 },
  ]).flat();
  const strip = { w: 450, h: 1100 };
  const centre = (id: string, vp: { x: number; zoom: number }) => { const n = wide.find((b) => b.id === id)!; return (n.x + n.w / 2) * vp.zoom + vp.x; };

  it("puts the card in the middle of the strip the sheet leaves, at a readable zoom", () => {
    const small = { x: FIT_PAD, y: FIT_PAD, zoom: 0.42 };
    const vp = panIntoView(wide, "role:4", small, strip, "center")!;
    expect(vp.zoom).toBe(MIN_READABLE_ZOOM);
    expect(centre("role:4", vp)).toBeCloseTo(strip.w / 2, 5);
    // Down the page it moves only if it must: the role row stays where the zoom put it, inside the strip.
    const n = wide.find((b) => b.id === "role:4")!;
    expect((n.y + n.h) * vp.zoom + vp.y).toBeLessThanOrEqual(strip.h);
  });

  it("keeps the viewer's zoom when it is readable, and is held to the tree at its ends", () => {
    const at = { x: FIT_PAD, y: FIT_PAD, zoom: 1 };
    const first = panIntoView(wide, "person:0", at, strip, "center");
    // The first card cannot reach the middle without a blank strip at the tree's start: nothing moves.
    expect(first).toBeNull();
    const mid = panIntoView(wide, "person:5", at, strip, "center")!;
    expect(mid.zoom).toBe(1);
    expect(centre("person:5", mid)).toBeCloseTo(strip.w / 2, 5);
    // A second ask once centred asks for nothing.
    expect(panIntoView(wide, "person:5", mid, strip, "center")).toBeNull();
  });

  it("least mode is unchanged: a visible card does not move", () => {
    const at = { x: FIT_PAD, y: FIT_PAD, zoom: 1 };
    expect(panIntoView(wide, "person:0", at, strip)).toBeNull();
  });
});

describe("crossing a zoom stop (orgZoom)", () => {
  const box = (id: string, y: number, h: number) => ({ id, x: 0, y, w: 100, h });
  // The layout on screen (tall close cards), and the shorter one that replaces it.
  const prev = [box("a", 0, 100), box("b", 120, 100), box("c", 240, 100)];
  const next = [box("a", 0, 40), box("b", 50, 40), box("c", 100, 40)];

  it("the card under the pointer stays where it is: the new layout takes its origin from it", () => {
    expect(bandOrigin(prev, next, { x: 50, y: 290 })).toEqual({ x: 0, y: 140 });
    expect(bandOrigin(prev, next, { x: 50, y: 10 })).toEqual({ x: 0, y: 0 });
  });

  it("between cards the nearest one anchors, and a card the new layout does not draw never does", () => {
    expect(bandOrigin(prev, next, { x: 50, y: 112 })).toEqual({ x: 0, y: 70 });
    expect(bandOrigin(prev, next.slice(0, 2), { x: 50, y: 290 })).toEqual({ x: 0, y: 70 });
    expect(bandOrigin(prev, [], { x: 50, y: 50 })).toEqual({ x: 0, y: 0 });
  });
});
