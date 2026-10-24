import { describe, expect, test } from "bun:test";
import { pipelineFigures, pipelineHome, pipelineStageForGoKey, pipelineStageOf, routeWords, signalCounts } from "../pipeline";
import { readLineSelection } from "../lineWorkspaceUrl";
import { emptyOutcomes, type FlowMap, type FlowMapSource } from "@codecast/shared/contracts/flowMap";

const src = (key: string, o: Partial<FlowMapSource> = {}): FlowMapSource => ({
  key, label: key, what: "", group: "people", state: "flowing", lastAt: 0, today: 0, normal: 0, days: [], route: "spine", escapes: 0, outcomes: emptyOutcomes(), unfiled: 0, opens: {}, ...o,
});
const step = (id: string, running: number, stalled = 0) => ({ id, label: id, running, stalled, waiting: 0 });
const MAP: FlowMap = {
  workspace: "team:t", rolledAt: 0,
  liveFlow: { id: "l", workflowId: "w", label: "Union fix flow", on: true, hold: null, cap: null, handsToday: 0, running: 43, stalled: 0, queued: 0, finishedToday: 0 },
  lanes: [{ key: "spine", label: "Union fix flow", workflowId: "w", kind: "spine", sources: [], steps: [step("build", 43)] }],
  off: { running: 20, stalled: 13, steps: [step("rebase", 13, 13)] },
  sources: [
    src("a"), src("b", { state: "quiet" }), src("c", { route: "off" }), src("d", { route: "off", state: "quiet" }),
    src("e", { route: "unfiled" }), src("f", { route: "unfiled", state: "stopped" }), src("g", { state: "stopped" }),
  ],
  shipped: [],
  header: { problemsOpen: 5_013, problemsScored: 4_824, decisionsForYou: 28, decisionsForTeam: 25, watching: 6, regressed: 0 },
};

const at = (search: string) => pipelineStageOf(readLineSelection(new URLSearchParams(search)));

describe("the pipeline header", () => {
  test("every view sits under one stage", () => {
    expect(["view=signals", "view=timeline", "view=line&source=judge:x", "stage=judges", "view=signals&sig=issues"].map(at)).toEqual(Array(5).fill("signals"));
    expect(["view=problems", "view=problems&case=ct-1"].map(at)).toEqual(["problems", "problems"]);
    expect(["", "view=line", "view=flows", "view=flows&item=x"].map(at)).toEqual(Array(4).fill("flows"));
    expect(["view=foryou", "need=sd-1"].map(at)).toEqual(["decisions", "decisions"]);
    expect(["view=shipped", "view=deploys"].map(at)).toEqual(["shipped", "shipped"]);
  });

  test("a stage's home is its view with nothing open; Flows opens the live flow's map", () => {
    expect(pipelineHome("flows")).toMatchObject({ view: "line", mode: "map", step: null, source: null });
    expect(pipelineHome("decisions")).toMatchObject({ view: "foryou", need: null });
  });

  test("G then a letter opens a stage; no digit does", () => {
    expect(["s", "p", "f", "d", "h", "F"].map(pipelineStageForGoKey)).toEqual(["signals", "problems", "flows", "decisions", "shipped", "flows"]);
    expect(["1", "2", "x"].map(pipelineStageForGoKey)).toEqual([null, null, null]);
  });

  test("the figures read the map, and Decisions the viewer's own count", () => {
    const f = pipelineFigures(MAP, 28);
    expect(f.signals.n).toBe(7);
    expect(f.signals.state.map((s) => s.words)).toEqual(["1 stopped", "2 not filed", "2 off the flow"]);
    expect(f.problems).toMatchObject({ n: 5_013, unit: "open" });
    expect(f.flows.n).toBe(63);
    expect(f.flows.state).toEqual([{ words: "Union fix flow on", tone: "live" }, { words: "13 stalled", tone: "bad" }]);
    expect(f.decisions).toMatchObject({ n: 28, state: [{ words: "25 for the team", tone: "ask" }] });
    expect(f.shipped.state).toEqual([{ words: "none regressed", tone: "ok" }]);
  });

  test("before the map answers, a stage reads no number rather than zero", () => {
    const f = pipelineFigures(null, 3);
    expect([f.signals.n, f.problems.n, f.flows.n, f.shipped.n]).toEqual([null, null, null, null]);
    expect(f.decisions.n).toBe(3);
  });
});

describe("Signals", () => {
  test("counts by state, and a source that files nothing counts as not filed whatever its pace", () => {
    expect(signalCounts(MAP.sources)).toEqual({ flowing: 2, quiet: 2, stopped: 1, off: 2, unfiled: 2 });
  });

  test("where a source goes, in its row's words", () => {
    const lanes = [{ key: "union-fix-flow", label: "Union fix flow" }];
    expect(routeWords("union-fix-flow", lanes)).toEqual({ label: "Union fix flow", tone: "lane" });
    expect(routeWords("off", lanes).tone).toBe("off");
    expect(routeWords("unfiled", lanes)).toEqual({ label: "Not filed", tone: "unfiled" });
  });
});
