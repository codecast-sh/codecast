import { describe, expect, test } from "bun:test";
import { buildLineMap } from "../lineMap";
import { layoutLineMap, neighbor, pathEdges, edgeWidth } from "../lineMapLayout";
import { lineMapSearch, readLineMapState, settingsOnMap } from "../lineMapUrl";
import * as F from "./lineFixtures";

const map = buildLineMap({ ...F.rows, finders: F.finders, now: F.NOW, windowMs: 7 * F.DAY });
const layout = layoutLineMap(map);
const box = (id: string) => layout.boxes.get(id)!;
const cy = (id: string) => box(id).y + box(id).h / 2;

describe("layoutLineMap", () => {
  test("every node has a box inside the canvas, and no two overlap", () => {
    expect(layout.boxes.size).toBe(map.nodes.length);
    const all = [...layout.boxes.values()];
    for (const b of all) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(layout.width);
      expect(b.y + b.h).toBeLessThanOrEqual(layout.height);
    }
    for (const a of all) for (const b of all) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap ? `${a.id} overlaps ${b.id}` : "").toBe("");
    }
  });

  test("the path every cause takes runs along one lane, left to right", () => {
    const main = ["signals", "causes", "ground", "analyze", "prove", "red", "implement", "verify", "eval", "review", "decide", "ship", "merge", "watch", "end:held"];
    for (const id of main) expect(cy(id)).toBe(cy("causes"));
    for (let i = 1; i < main.length; i++) expect(box(main[i]).x).toBeGreaterThan(box(main[i - 1]).x);
  });

  test("a branch that comes back sits above the path, one that leaves sits below", () => {
    for (const id of ["plan", "plan_gate", "park", "reopen"]) expect(cy(id)).toBeLessThan(cy("causes"));
    for (const id of ["dissolve", "end:dissolved", "drop", "end:dropped", "end:stopped", "end:reopened", "unscored"]) expect(cy(id)).toBeGreaterThan(cy("causes"));
    // plan and its gate share a lane.
    expect(cy("plan")).toBe(cy("plan_gate"));
  });

  test("a loop arcs over the nodes between its ends", () => {
    const p = layout.paths.get("reopen->implement")!;
    const ys = p.d.match(/-?\d+(\.\d+)?/g)!.map(Number).filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeLessThan(box("reopen").y);
    expect(layout.paths.get("verify->implement")!.kind).toBe("loop");
  });

  test("phases read left to right over the path", () => {
    expect(layout.phases.map((p) => p.key)).toEqual(["sense", "admit", "understand", "prove", "build", "check", "decide", "ship", "end"]);
  });

  test("arrow keys move to the nearest node that way", () => {
    expect(neighbor(layout, "ground", "right")).toBe("analyze");
    expect(neighbor(layout, "analyze", "left")).toBe("ground");
    expect(neighbor(layout, "prove", "down")).toBe("dissolve");
    expect(neighbor(layout, "causes", "left")).toBe("signals");
    expect(neighbor(layout, "end:held", "right")).toBeNull();
  });

  test("a path's edges count each crossing; widths grow with crossings", () => {
    expect(pathEdges(["red", "implement", "verify", "implement", "verify"]).get("implement->verify")).toBe(2);
    expect(edgeWidth(0, 8)).toBe(1);
    expect(edgeWidth(8, 8)).toBeGreaterThan(edgeWidth(1, 8));
  });
});

describe("the map's URL", () => {
  const q = (s: string) => new URLSearchParams(s);
  test("reads a panel, a window and a trace; an edge wins over a node; an unknown window is the default", () => {
    expect(readLineMapState(q("node=prove&window=30d&trace=ct-1"))).toEqual({ node: "prove", edge: null, window: "30d", trace: "ct-1", section: null });
    expect(readLineMapState(q("node=prove&edge=a->b&window=1y"))).toMatchObject({ node: null, edge: "a->b", window: "7d" });
  });
  test("writes in place: opening a node drops the edge and a stale section, the default window is left out", () => {
    expect(lineMapSearch(q("project=pr-1&edge=a->b&section=limits"), { node: "prove" })).toBe("?project=pr-1&node=prove");
    expect(lineMapSearch(q("project=pr-1&window=30d"), { window: "7d" })).toBe("?project=pr-1");
    expect(lineMapSearch(q("node=prove"), { node: null })).toBe("");
  });
  test("a /line/settings link lands on the map with its panel open", () => {
    expect(settingsOnMap(q("project=pr-1&section=limits"))).toBe("/line?project=pr-1&node=line&section=limits");
    expect(settingsOnMap(q("project=pr-1&section=stations&station=prove"))).toBe("/line?project=pr-1&node=prove");
    expect(settingsOnMap(q(""))).toBe("/line?node=line");
  });
});
