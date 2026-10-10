// The Graph view's layout (line-workspace.md LW1) over real graphs: Union's
// AgentWatch and codecast's own line. Steps never overlap, the spine reads
// left to right along each row, rows fold at stage boundaries without a stub
// row, ends are chips under the step that ends a run (All steps) or words
// under it (Essence), a script's loops stay out of sight in Essence, and a
// model rebuilt for new runs reuses the layout it already has.
import { describe, expect, test } from "bun:test";
import { buildLineModel, type LineModel } from "../../../../../../lib/line/lineModel";
import type { MapRun } from "../../../../../../lib/line/lineMap";
import { agentwatchGraph } from "../../../../../../lib/line/__tests__/agentwatchGraph.fixture";
import { computeLayout, graphLayout, overlaps, type GraphLayout } from "../graphLayout";

const run = (slug: string, i = 0) => ({ _id: `r${i}`, task_id: "t1", workflow_slug: slug, created_at: 1 + i, updated_at: 1 + i, graph_nodes: [{ id: "dissolve" }] }) as unknown as MapRun;
const agentwatch = (runs: MapRun[] = [run("agentwatch")]): LineModel => buildLineModel({ runs, tasks: [], graph: agentwatchGraph }, "agentwatch");
const line = (): LineModel => buildLineModel({ runs: [run("line")], tasks: [] }, "line");

function noOverlaps(L: GraphLayout) {
  const clashes: string[] = [];
  for (let i = 0; i < L.list.length; i++) {
    for (let j = i + 1; j < L.list.length; j++) if (overlaps(L.list[i], L.list[j], 4)) clashes.push(`${L.list[i].id}/${L.list[j].id}`);
  }
  expect(clashes).toEqual([]);
}

describe("graphLayout", () => {
  for (const [name, build] of [["AgentWatch", agentwatch], ["codecast's line", line]] as const) {
    for (const mode of ["essence", "all"] as const) {
      test(`${name}, ${mode}: every step placed, none overlapping, all inside the bounds`, () => {
        const m = build();
        const L = computeLayout(m.graph, { mode });
        const expected = m.graph.nodes.filter((n) => mode === "all" || n.kind !== "end").map((n) => n.id).sort();
        expect([...L.nodes.keys()].sort()).toEqual(expected);
        noOverlaps(L);
        for (const n of L.list) {
          expect(n.x - n.w / 2).toBeGreaterThan(L.bounds.x);
          expect(n.x + n.w / 2).toBeLessThan(L.bounds.x + L.bounds.w);
          expect(n.y + n.h / 2).toBeLessThan(L.bounds.y + L.bounds.h);
        }
        for (const e of L.edges) expect(e.d).toMatch(/^M-?[\d.]+,-?[\d.]+ [LCQ]/);
      });
    }
  }

  test("AgentWatch Essence: Studio's three rows, Diagnose then Fix folded at a stage", () => {
    const L = computeLayout(agentwatch().graph, { mode: "essence" });
    const rowOf = (id: string) => L.nodes.get(id)!.row;
    expect(L.lanes.map((l) => l.half)).toEqual(["diagnose", "fix"]);
    expect(["dissolve", "investigate", "refine", "prove"].map(rowOf)).toEqual([0, 0, 0, 0]);
    expect(rowOf("propose")).toBe(1);
    expect(rowOf("build")).toBe(1);
    expect(rowOf("review")).toBe(2);
    expect(rowOf("watch")).toBe(2);
    // The spine runs left to right within a row.
    const spine = L.list.filter((n) => n.spine);
    for (let i = 1; i < spine.length; i++) if (spine[i].row === spine[i - 1].row) expect(spine[i].x).toBeGreaterThan(spine[i - 1].x);
    // A person's other answer sits under the spine, not on it.
    expect(L.nodes.get("revise_proposal")!.lane).toBeGreaterThan(0);
    expect(L.nodes.get("revise_proposal")!.x).toBe(L.nodes.get("approve")!.x);
  });

  test("Essence draws scripts as dots, ends as words, and hides only the long ways round", () => {
    const L = computeLayout(agentwatch().graph, { mode: "essence" });
    expect(L.nodes.get("stamp")!.dot).toBe(true);
    expect(L.nodes.get("investigate")!.dot).toBe(false);
    expect(L.exits.get("investigate")!.map((x) => x.label).sort()).toEqual(["dissolved", "failed"]);
    const quiet = (id: string) => L.edges.find((e) => e.id === id)!.quiet;
    expect(quiet("verify->build")).toBe(true);
    expect(quiet("review->build")).toBe(true);
    expect(quiet("proposal_gate->revise_proposal")).toBe(false);
    for (const e of L.edges.filter((x) => x.shape === "next" || x.shape === "wrap")) expect(e.quiet).toBe(false);
    expect(L.edges.find((e) => e.id === "proposal_gate->approve")!.label?.text).toBe("Approve");
  });

  test("All steps: ends are chips just under the step that ends the run", () => {
    const L = computeLayout(agentwatch().graph, { mode: "all" });
    const end = L.nodes.get("failed_at_build")!;
    const build = L.nodes.get("build")!;
    expect(end.y).toBeGreaterThan(build.y);
    expect(Math.abs(end.x - build.x)).toBeLessThan(build.w);
    expect(L.edges.find((e) => e.id === "build->failed_at_build")!.shape).toBe("end");
  });

  test("the words on a spine edge always fit between its steps", () => {
    for (const mode of ["essence", "all"] as const) {
      const L = computeLayout(agentwatch().graph, { mode });
      for (const e of L.edges.filter((x) => x.shape === "next" && x.label)) {
        const a = L.nodes.get(e.from)!;
        const b = L.nodes.get(e.to)!;
        expect(b.x - b.w / 2 - (a.x + a.w / 2)).toBeGreaterThanOrEqual(e.label!.w);
      }
    }
  });

  test("a model rebuilt for new runs reuses the layout; another shape gets its own", () => {
    const a = graphLayout(agentwatch([run("agentwatch", 0)]).graph, { mode: "essence" });
    const b = graphLayout(agentwatch([run("agentwatch", 0), run("agentwatch", 1)]).graph, { mode: "essence" });
    expect(b).toBe(a);
    expect(graphLayout(line().graph, { mode: "essence" })).not.toBe(a);
    expect(graphLayout(agentwatch().graph, { mode: "all" })).not.toBe(a);
  });

  test("a narrower wrap folds onto more rows, each within it", () => {
    const wide = computeLayout(agentwatch().graph, { mode: "essence" });
    const narrow = computeLayout(agentwatch().graph, { mode: "essence", wrap: 1000 });
    const rows = (L: GraphLayout) => new Set(L.list.map((n) => n.row)).size;
    expect(rows(narrow)).toBeGreaterThan(rows(wide));
    noOverlaps(narrow);
  });

  test("a graph of one step lays out without a spine edge or a finish", () => {
    const m = agentwatch();
    const one = { ...m.graph, nodes: m.graph.nodes.filter((n) => n.id === "dissolve"), edges: [] };
    const L = computeLayout(one, { mode: "essence" });
    expect(L.list).toHaveLength(1);
    expect(L.finish).toBeNull();
    expect(L.entry).not.toBeNull();
  });
});
