// The Notebook's outline (line-workspace.md LW1) on the real AgentWatch graph:
// the steps a person reads down the spine, the scripts folded between them,
// flows walked through scripts, loops in lanes, and each step's prompt texts.
import { describe, expect, test } from "bun:test";
import { buildLineModel, type LineModelRows } from "../lineModel";
import type { MapRun } from "../lineMap";
import { notebookOutline, outlineLayout, OUTLINE_IN } from "../notebookOutline";
import { agentwatchGraph } from "./agentwatchGraph.fixture";
import { union57382Run, union57467Run } from "./unionLineRuns.fixture";

const aw = (run: typeof union57382Run, task: string, h: string): MapRun =>
  ({ ...run, task_id: task, workflow_slug: "agentwatch", updated_at: run.updated_at ?? run.created_at, graph_nodes: [{ id: "dissolve", h }, { id: "investigate", h: "i1" }] } as unknown as MapRun);
const rows: LineModelRows = {
  runs: [aw(union57382Run, "t1", "h2"), aw(union57467Run, "t2", "h1")],
  tasks: [] as LineModelRows["tasks"],
  graph: agentwatchGraph,
  now: 1_791_500_000_000,
};
const model = buildLineModel(rows, "agentwatch");
const o = notebookOutline(model);

describe("notebookOutline", () => {
  test("the spine holds agents and people only, in reading order", () => {
    expect(o.main.length).toBeGreaterThan(3);
    for (const id of o.main) expect(["agent", "person"]).toContain(model.steps[id].kind);
    expect(o.main.indexOf("dissolve")).toBeLessThan(o.main.indexOf("investigate"));
    expect(o.main).toContain("proposal_gate");
  });

  test("every script sits in exactly one segment, the claim before the first look", () => {
    const scripts = model.order.filter((id) => model.steps[id].kind === "script");
    const held = Object.values(o.segs).flat();
    expect(held.sort()).toEqual([...scripts].sort());
    expect(o.scripts).toBe(scripts.length);
    expect(o.segs[OUTLINE_IN]).toContain("bind");
    expect(o.ownerOf.bind).toBe(OUTLINE_IN);
  });

  test("flows walk through scripts to the next step a person reads, an end, or back", () => {
    for (const m of o.main) {
      for (const f of o.flows[m]) {
        expect(model.steps[f.to].kind === "script").toBe(false);
        if (f.kind === "loop") expect(o.main.indexOf(f.to)).toBeLessThanOrEqual(o.main.indexOf(m));
        if (f.kind === "next") expect(o.main.indexOf(f.to)).toBeGreaterThan(o.main.indexOf(m));
      }
    }
    expect(o.flows.dissolve.some((f) => f.kind === "next" && f.to === "investigate")).toBe(true);
    expect(Object.values(o.flows).flat().some((f) => f.kind === "loop")).toBe(true);
  });

  test("the layout places rows down the page and opens a segment in place", () => {
    const ends = { start: "In", end: "Out" };
    const folded = outlineLayout(model, o, new Set(), false, ends);
    const ys = folded.rows.map((r) => r.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(folded.rows.filter((r) => r.t === "node")).toHaveLength(o.main.length);
    expect(folded.rows.filter((r) => r.t === "half").map((r) => (r as { label: string }).label)).toEqual(["Diagnose", "Fix"]);
    expect(folded.rows.some((r) => r.t === "script")).toBe(false);
    const opened = outlineLayout(model, o, new Set([OUTLINE_IN]), false, ends);
    expect(opened.rows.filter((r) => r.t === "script").map((r) => (r as { id: string }).id)).toEqual(o.segs[OUTLINE_IN]);
    const all = outlineLayout(model, o, new Set(), true, ends);
    expect(all.rows.filter((r) => r.t === "script")).toHaveLength(o.scripts);
    // Loops that overlap take separate lanes.
    for (const a of all.loops) for (const b of all.loops) {
      if (a === b || a.lane !== b.lane) continue;
      const [alo, ahi] = [Math.min(a.fromY, a.toY), Math.max(a.fromY, a.toY)];
      const [blo, bhi] = [Math.min(b.fromY, b.toY), Math.max(b.fromY, b.toY)];
      expect(ahi < blo - 4 || alo > bhi + 4).toBe(true);
    }
  });

  test("a step keeps every prompt text its runs read, newest first", () => {
    const p = model.steps.dissolve.prompt!;
    expect(p.versions.map((v) => v.hash)).toHaveLength(2);
    expect(p.version?.hash).toBe(p.versions[0].hash);
    expect(p.version?.earlier).toBe(true);
    expect(model.steps.investigate.prompt!.versions).toEqual([expect.objectContaining({ hash: "i1", runs: 2 })]);
  });
});
