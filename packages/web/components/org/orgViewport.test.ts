import { describe, expect, it } from "bun:test";
import { computeOrgViewport, hiddenRoots } from "./OrgGraph";
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
