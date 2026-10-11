// Replay's pure layer (lib/line/replay.ts) on the real AgentWatch graph and
// two of Union's real runs: the rail, how runs end, what a step could say,
// and where a click on a step lands in a run.
import { describe, expect, test } from "bun:test";
import { buildLineModel, type LineModelRows, type LineRunModel } from "../lineModel";
import type { MapRun } from "../lineMap";
import { RAIL, openingVisit, railEdge, railLayout, runEndKind, runEndWords, stepOutcomes, visitOf, wrongNote } from "../replay";
import { agentwatchGraph } from "./agentwatchGraph.fixture";
import { union57382Run, union57467Run } from "./unionLineRuns.fixture";

const aw = (run: typeof union57382Run, task: string): MapRun => ({ ...run, task_id: task, workflow_slug: "agentwatch", updated_at: run.updated_at ?? run.created_at } as unknown as MapRun);
const rows: LineModelRows = {
  runs: [aw(union57382Run, "t1"), aw(union57467Run, "t2")],
  tasks: [
    { _id: "t1", short_id: "ct-57382", title: "Sender identity re-derived per send", status: "open", created_at: 1 },
    { _id: "t2", short_id: "ct-57467", title: "A message leads with the result", status: "open", created_at: 1 },
  ] as LineModelRows["tasks"],
  graph: agentwatchGraph,
  now: 1_791_500_000_000,
};
const m = buildLineModel(rows, "agentwatch");

describe("railLayout", () => {
  const L = railLayout(m);
  test("lays every step out once: the spine in reading order, each end beside it", () => {
    expect(L.spine.length + L.ends.length).toBe(m.order.length);
    expect(L.spine).toEqual(m.order.filter((id) => m.steps[id].kind !== "end"));
    for (let i = 1; i < L.spine.length; i++) expect(L.at[L.spine[i]].y).toBeGreaterThan(L.at[L.spine[i - 1]].y);
    for (const id of L.ends) expect(L.at[id].x).toBeGreaterThanOrEqual(RAIL.endX[0]);
  });
  test("an end sits level with a step that sends work to it", () => {
    for (const id of L.ends) {
      const from = L.spine.find((s) => m.steps[s].outcomes.some((o) => o.to === id));
      if (from && L.at[id].col < RAIL.endX.length) expect(L.at[id].y).toBe(L.at[from].y);
    }
  });
  test("bands the Diagnose and Fix halves, and is kept per graph", () => {
    expect(L.bands.map((b) => b.label)).toEqual(["Diagnose", "Fix"]);
    expect(railLayout({ ...m })).toBe(L);
  });
  test("a step that only hands on is a tick; one that decides is not", () => {
    for (const id of L.ticks) expect(m.steps[id].kind).toBe("script");
    for (const id of L.spine.filter((s) => m.steps[s].kind === "agent")) expect(L.ticks.has(id)).toBe(false);
  });
  test("edges: down the spine straight, back as a bow, out to an end from the stub", () => {
    const a = { x: 46, y: 100, h: 54, end: false, col: 0 };
    const b = { x: 46, y: 200, h: 54, end: false, col: 0 };
    expect(railEdge(a, b)).toBe("M46,100 L46,200");
    expect(railEdge(b, a)).toStartWith("M46,200 C");
    expect(railEdge(a, { x: 226, y: 100, h: 14, end: true, col: 0 })).toBe(`M${RAIL.stubX},100 L226,100`);
    expect(railEdge(a, undefined)).toBeNull();
  });
});

describe("how a run ended", () => {
  const run = (tone: string, end: string | null, live = false) => ({ live, outcome: { tone, end, text: "" } }) as unknown as LineRunModel;
  test("each run falls under one filter, and its tag says it in a word", () => {
    expect(runEndKind(run("shipped", "shipped"))).toBe("shipped");
    expect(runEndKind(run("closed", "dissolved"))).toBe("closed");
    expect(runEndKind(run("failed", null))).toBe("stopped");
    expect(runEndKind(run("failed", "shipped"))).toBe("stopped");
    expect(runEndKind(run("waiting", null))).toBe("running");
    expect(runEndWords(run("closed", "dissolved"))).toBe("dissolved");
    expect(runEndWords(run("failed", "shipped"))).toBe("reopened");
    expect(runEndWords(run("live", null, true))).toBe("running");
  });
  test("the real runs read", () => {
    for (const r of m.runs) expect(["shipped", "closed", "stopped", "running"]).toContain(runEndKind(r));
  });
});

describe("a step's decisions", () => {
  test("what a step could have said: the outcomes its branches test, then what it reported", () => {
    const step = { id: "x", decisions: [{ decided: { outcome: "red" } }, { decided: { outcome: "red" } }, { decided: { outcome: "odd" } }] } as never;
    const graph = { edges: [{ from: "x", to: "a", condition: "outcome = not_reproduced" }, { from: "x", to: "b", condition: "outcome=red or outcome == success" }] };
    expect(stepOutcomes({ graph } as never, step)).toEqual(["red", "odd", "not_reproduced"]);
  });
  test("on the real graph, investigate can say more than one thing", () => {
    expect(stepOutcomes(m, m.steps.investigate).length).toBeGreaterThan(1);
  });
  test("a wrong label's note says what it should have been, then why", () => {
    expect(wrongNote("not_reproduced", "the quote predates the fix")).toBe("Should be not reproduced. the quote predates the fix");
    expect(wrongNote(null, " no evidence ")).toBe("no evidence");
    expect(wrongNote("red", "")).toBe("Should be red.");
  });
});

describe("visits", () => {
  const v = ["a", "b", "c", "b", "d"].map((node, i) => ({ node, kind: i === 1 ? "agent" : "script" })) as never[];
  test("a click on a step lands on its next visit after the playhead, else its last before", () => {
    expect(visitOf(v, "b", 0)).toBe(1);
    expect(visitOf(v, "b", 1)).toBe(3);
    expect(visitOf(v, "b", 4)).toBe(3);
    expect(visitOf(v, "z", 2)).toBe(-1);
  });
  test("a run opens on the selected step, else its first agent", () => {
    expect(openingVisit(v, "c")).toBe(2);
    expect(openingVisit(v, null)).toBe(1);
    expect(openingVisit(v, "z")).toBe(1);
  });
});
