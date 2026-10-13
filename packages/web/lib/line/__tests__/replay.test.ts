// Replay's pure layer (lib/line/replay.ts) on the real AgentWatch graph and
// two of Union's real runs: how runs end, what a step could say,
// and where a click on a step lands in a run.
import { describe, expect, test } from "bun:test";
import { buildLineModel, type LineModelRows, type LineRunModel } from "../lineModel";
import type { MapRun } from "../lineMap";
import { runEndWords, stepOutcomes, visitOf, wrongNote } from "../replay";
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

describe("how a run ended", () => {
  const run = (tone: string, end: string | null, live = false) => ({ live, outcome: { tone, end, text: "" } }) as unknown as LineRunModel;
  test("its tag says how it ended in a word, and one a newer run took over is superseded", () => {
    expect(runEndWords(run("closed", "dissolved"))).toBe("dissolved");
    expect(runEndWords(run("failed", "shipped"))).toBe("reopened");
    expect(runEndWords(run("live", null, true))).toBe("running");
    expect(runEndWords(run("waiting", null))).toBe("waiting");
    expect(runEndWords({ ...run("waiting", null), superseded: true })).toBe("superseded");
  });
  test("an older run left waiting under a newer one on its problem is superseded, never live", () => {
    for (const r of m.runs) if (r.superseded) expect(runEndWords(r)).toBe("superseded");
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
});
