import { describe, expect, test } from "bun:test";
import { buildLineMap } from "../lineMap";
import { layoutLineMap, neighbor, pathEdges, edgeWidth, markRect, labelRect } from "../lineMapLayout";
import { lineMapSearch, readLineMapState, settingsOnMap } from "../lineMapUrl";
import * as F from "./lineFixtures";

const map = buildLineMap({ ...F.rows, finders: F.finders, now: F.NOW, windowMs: 7 * F.DAY });
const layout = layoutLineMap(map);
const box = (id: string) => layout.boxes.get(id)!;
const cy = (id: string) => box(id).y + box(id).h / 2;

describe("layoutLineMap", () => {
  test("the main row sits close under the stage names, and the sources rise into the room the arcs leave", () => {
    // The stage names take the canvas's top 22px; the main row starts about 48px under them, a little more when loops arc over it (LX2):
    // rebase back to implement is the widest arc.
    expect(box("causes").y - 22).toBeLessThanOrEqual(72);
    // Many sources: the column starts no lower than the highest arc over the path, so the last pill stays inside the stage.
    const many = buildLineMap({ ...F.rows, finders: [...F.finders, ...["a", "b", "c", "d", "e"].map((x) => ({ id: x, source: x, kind: "any" as const, fingerprint: `${x}:{id}` }))], now: F.NOW, windowMs: 7 * F.DAY });
    const l = layoutLineMap(many);
    const srcs = [...l.boxes.values()].filter((b) => b.id.startsWith("source:"));
    const main = l.boxes.get("causes")!;
    expect(Math.min(...srcs.map((b) => b.y))).toBeLessThan(main.y);
    for (const b of srcs) expect(b.y + b.h).toBeLessThanOrEqual(l.height);
  });

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

  test("the path every cause takes runs along one lane of each row, left to right, the rows by phase", () => {
    const main = ["signals", "causes", "ground", "analyze", "prove", "red", "implement", "verify", "eval", "review", "decide", "rebase", "ship", "watch", "end:held"];
    // The shipped line is wider than a screen, so it folds onto three rows.
    expect(layout.bands).toBe(3);
    expect(["signals", "causes", "ground", "analyze"].map((id) => box(id).band)).toEqual([0, 0, 0, 0]);
    expect(["prove", "implement", "verify", "review"].map((id) => box(id).band)).toEqual([1, 1, 1, 1]);
    expect(["decide", "ship", "watch", "end:held"].map((id) => box(id).band)).toEqual([2, 2, 2, 2]);
    for (let i = 1; i < main.length; i++) {
      const [a, b] = [box(main[i - 1]), box(main[i])];
      if (a.band === b.band) { expect(cy(main[i])).toBe(cy(main[i - 1])); expect(b.x).toBeGreaterThan(a.x); }
      else { expect(b.band).toBe(a.band + 1); expect(b.y).toBeGreaterThan(a.y + a.h); }
    }
    // The path wraps from one row into the next; it never drops a stub.
    expect(layout.paths.get("analyze->prove")?.note).toBeUndefined();
    // No row is wider than a screen and a half, so a reader never pans four screens.
    expect(layout.width).toBeLessThan(1800);
  });

  test("given the width on screen, the line folds onto as many rows as it needs and no node lies past it", () => {
    for (const fitWidth of [700, 1000, 1300]) {
      const l = layoutLineMap(map, { fitWidth });
      expect(l.width).toBeLessThanOrEqual(fitWidth);
      for (const b of l.boxes.values()) expect(b.x + b.w).toBeLessThanOrEqual(fitWidth);
      const all = [...l.boxes.values()];
      for (const a of all) for (const b of all) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap ? `${a.id} overlaps ${b.id} at ${fitWidth}` : "").toBe("");
      }
    }
    // A narrower column folds onto more rows.
    expect(layoutLineMap(map, { fitWidth: 700 }).bands).toBeGreaterThan(layoutLineMap(map, { fitWidth: 1300 }).bands);
  });

  test("an edge between rows that is not the path is a short stub naming where it goes", () => {
    const stubs = [...layout.paths.values()].filter((p) => p.note);
    expect(stubs.length).toBeGreaterThan(0);
    for (const p of stubs) {
      expect(p.note).toMatch(/^(to|back to) /);
      const ys = p.d.match(/-?\d+(\.\d+)?/g)!.map(Number).filter((_, i) => i % 2 === 1);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(30);
    }
  });

  test("the path runs on top; a branch that comes back sits just under it, one that leaves under that", () => {
    const back = ["plan", "plan_gate", "park", "reopen"];
    const out = ["dissolve", "end:dissolved", "drop", "end:dropped", "end:stopped", "end:reopened", "unscored"];
    for (const id of back) expect(cy(id)).toBeGreaterThan(cy("causes"));
    for (const id of out) expect(cy(id)).toBeGreaterThan(Math.min(...back.map(cy)));
    // Nothing but a source (and the expectations feeding them) sits above the path, so it reads right under the phase names.
    for (const b of layout.boxes.values()) if (!["source", "expectations"].includes(map.nodes.find((n) => n.id === b.id)?.kind ?? "")) expect(b.y + b.h / 2).toBeGreaterThanOrEqual(cy("causes"));
    // plan and its gate share a lane.
    expect(cy("plan")).toBe(cy("plan_gate"));
  });

  test("a loop from a lower lane arcs under the nodes between its ends; one along the path arcs just over it", () => {
    const ys = (id: string) => layout.paths.get(id)!.d.match(/-?\d+(\.\d+)?/g)!.map(Number).filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys("reopen->implement"))).toBeGreaterThan(box("reopen").y + box("reopen").h);
    expect(Math.min(...ys("verify->implement"))).toBeLessThan(box("verify").y);
    expect(layout.paths.get("verify->implement")!.kind).toBe("loop");
  });

  test("phases read left to right over the path", () => {
    expect(layout.phases.map((p) => p.key)).toEqual(["sense", "admit", "understand", "prove", "build", "check", "decide", "ship", "end"]);
  });

  test("arrow keys move to the nearest node that way", () => {
    expect(neighbor(layout, "ground", "right")).toBe("analyze");
    expect(neighbor(layout, "analyze", "left")).toBe("ground");
    // A line cause's own prove and build stations sit right under the ones they stand in for.
    expect(neighbor(layout, "prove", "down")).toBe("prove_line");
    expect(box("implement_line").col).toBe(box("implement").col);
    expect(map.edges.find((e) => e.id === "red->prove_line")?.kind).toBe("loop");
    expect(neighbor(layout, "causes", "left")).toBe("signals");
    // Past a row's end the cursor reads on into the next row; the last row's end goes nowhere.
    expect(box(neighbor(layout, "analyze", "right")!).band).toBe(1);
    expect(neighbor(layout, "end:held", "right")).toBeNull();
  });

  test("a path's edges count each crossing; widths grow with crossings", () => {
    expect(pathEdges(["red", "implement", "verify", "implement", "verify"]).get("implement->verify")).toBe(2);
    expect(edgeWidth(0, 8)).toBe(1);
    expect(edgeWidth(8, 8)).toBeGreaterThan(edgeWidth(1, 8));
  });
});

/** Points along a path the layout draws (M, L, Q and C segments), every few pixels. */
function samplePath(d: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const tokens = d.match(/[MLQC]|-?\d+(\.\d+)?/g) ?? [];
  let i = 0;
  let at = { x: 0, y: 0 };
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") { at = { x: num(), y: num() }; out.push(at); continue; }
    const pts = [at];
    const n = cmd === "L" ? 1 : cmd === "Q" ? 2 : 3;
    for (let k = 0; k < n; k++) pts.push({ x: num(), y: num() });
    for (let s = 1; s <= 40; s++) {
      const t = s / 40;
      // de Casteljau over the segment's points.
      let p = pts.map((q) => ({ ...q }));
      while (p.length > 1) p = p.slice(1).map((q, j) => ({ x: p[j].x + (q.x - p[j].x) * t, y: p[j].y + (q.y - p[j].y) * t }));
      out.push(p[0]);
    }
    at = pts[pts.length - 1];
  }
  return out;
}

const inside = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }, pad = 0) =>
  p.x > r.x + pad && p.x < r.x + r.w - pad && p.y > r.y + pad && p.y < r.y + r.h - pad;

describe("a long line on screen", () => {
  const fits = [
    { name: "unbounded", opts: {} },
    { name: "a wide frame", opts: { fitWidth: 1400, fitHeight: 520 } },
    { name: "a narrow frame with a panel open", opts: { fitWidth: 960, fitHeight: 480 } },
    { name: "a tall frame", opts: { fitWidth: 1000, fitHeight: 4000 } },
  ];

  test("a line whose rows would stack taller than the frame lays out as one row, so no step hides below it", () => {
    const short = layoutLineMap(map, { fitWidth: 1000, fitHeight: 480 });
    expect(short.bands).toBe(1);
    expect(short.width).toBeGreaterThan(1000);
    // One row: no edge is cut into a stub naming where it goes.
    expect([...short.paths.values()].filter((p) => p.note)).toEqual([]);
    // A frame tall enough for the rows still folds the line onto them.
    const tall = layoutLineMap(map, { fitWidth: 1000, fitHeight: 4000 });
    expect(tall.bands).toBeGreaterThan(1);
    expect(tall.height).toBeLessThanOrEqual(4000);
  });

  for (const { name, opts } of fits) {
    test(`in ${name}, no edge runs through a node or the words under one`, () => {
      const l = layoutLineMap(map, opts);
      const marks = [...l.boxes.values()].map((b) => markRect(map.nodes.find((n) => n.id === b.id)!, b)).filter((r): r is NonNullable<typeof r> => !!r);
      const hits: string[] = [];
      for (const e of map.edges) {
        const p = l.paths.get(e.id);
        if (!p) continue;
        const pts = samplePath(p.d);
        for (const b of l.boxes.values()) {
          if (b.id === e.from || b.id === e.to) continue;
          if (pts.some((q) => inside(q, b, 2))) hits.push(`${e.id} crosses ${b.id}`);
        }
        for (const m of marks) if (pts.some((q) => inside(q, m, 1))) hits.push(`${e.id} strikes the words under ${m.id}`);
      }
      expect(hits).toEqual([]);
    });

    test(`in ${name}, every edge label shows whole, on no node, words or other label`, () => {
      const l = layoutLineMap(map, opts);
      const rects: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
      for (const b of l.boxes.values()) {
        rects.push(b);
        const m = markRect(map.nodes.find((n) => n.id === b.id)!, b);
        if (m) rects.push(m);
      }
      const bad: string[] = [];
      for (const e of map.edges) {
        const r = labelRect(e, l.paths.get(e.id));
        if (!r) continue;
        if (r.x < 0 || r.x + r.w > l.width || r.y < 0 || r.y + r.h > l.height) bad.push(`${e.id} label leaves the canvas`);
        for (const o of rects) if (r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h) bad.push(`${e.id} label on ${o.id}`);
        rects.push({ ...r, id: `label ${e.id}` });
      }
      expect(bad).toEqual([]);
    });

    test(`in ${name}, the canvas is as tall as what it draws and no taller`, () => {
      const l = layoutLineMap(map, opts);
      let bottom = 0;
      for (const b of l.boxes.values()) {
        const m = markRect(map.nodes.find((n) => n.id === b.id)!, b);
        bottom = Math.max(bottom, m ? m.y + m.h : 0, b.y + b.h);
      }
      for (const p of l.paths.values()) bottom = Math.max(bottom, ...samplePath(p.d).map((q) => q.y));
      expect(bottom).toBeLessThanOrEqual(l.height);
      expect(l.height - bottom).toBeLessThanOrEqual(28);
    });
  }
});

describe("the map's URL", () => {
  const q = (s: string) => new URLSearchParams(s);
  test("reads a panel, a window and a trace; an edge wins over a node; an unknown window is the default", () => {
    expect(readLineMapState(q("node=prove&window=30d&trace=ct-1"))).toEqual({ node: "prove", edge: null, window: "30d", trace: "ct-1", section: null, graph: null });
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
