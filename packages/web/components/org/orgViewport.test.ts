import { describe, expect, it } from "bun:test";
import { computeOrgViewport, hiddenRoots } from "./orgViewport";
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
    const vp = computeOrgViewport(nodes, 700, 500, 0, null)!;
    const before = hiddenRoots(nodes, { x: vp.x, y: vp.y, zoom: vp.zoom }, 700);
    expect(before.left.length).toBe(0);
    expect(before.right.length).toBeGreaterThan(0);
    expect(before.right[0].kind).toBe("person");
    // Panned far right: the viewer's card falls off the left edge.
    const after = hiddenRoots(nodes, { x: vp.x - 2000, y: vp.y, zoom: vp.zoom }, 700);
    expect(after.left.some((n) => n.id === personNodeId("fixture-user-me"))).toBe(true);
  });
});

describe("computeOrgViewport focus target", () => {
  it("centres the target card in the free area at the current zoom, panning only", () => {
    const me = nodes.find((n) => n.id === personNodeId("fixture-user-me"))!;
    const vp = computeOrgViewport(nodes, 1600, 1000, 380, null, { id: me.id, zoom: 1.2 })!;
    expect(vp.zoom).toBe(1.2);
    expect(vp.whole).toBe(false);
    const freeW = 1600 - 380 - 48;
    const freeH = 1000 - 48;
    expect(me.x * 1.2 + vp.x).toBeCloseTo(24 + (freeW - me.w * 1.2) / 2, 5);
    expect(me.y * 1.2 + vp.y).toBeCloseTo(24 + (freeH - me.h * 1.2) / 2, 5);
  });

  it("falls back to the fit when the target is not on the chart", () => {
    const plain = computeOrgViewport(nodes, 1600, 1000, 0, null)!;
    const missing = computeOrgViewport(nodes, 1600, 1000, 0, null, { id: "role:nope" })!;
    expect(missing).toEqual(plain);
  });

  it("a bottom inset (the phone sheet) keeps the focused card above it, centred in what is free", () => {
    // A phone: 390 x 800 with the sheet covering the bottom 62%.
    const me = nodes.find((n) => n.id === personNodeId("fixture-user-me"))!;
    const sheet = Math.round(800 * 0.62);
    const vp = computeOrgViewport(nodes, 390, 800, 0, null, { id: me.id, zoom: 0.92 }, sheet)!;
    const top = me.y * 0.92 + vp.y;
    const bottom = top + me.h * 0.92;
    expect(bottom).toBeLessThanOrEqual(800 - sheet);
    const freeH = 800 - sheet - 48;
    expect(top).toBeCloseTo(24 + (freeH - me.h * 0.92) / 2, 5);
    // Without the inset the same card lands under the sheet.
    const under = computeOrgViewport(nodes, 390, 800, 0, null, { id: me.id, zoom: 0.92 })!;
    expect(me.y * 0.92 + under.y + me.h * 0.92).toBeGreaterThan(800 - sheet);
  });
});
