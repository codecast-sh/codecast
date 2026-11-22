import { describe, expect, test } from "bun:test";
import { PIPELINE_FIXTURES } from "./pipelines.fixture.generated";
import { pipelineModel, type PipelineRun } from "../pipelineModel";
import { runningOf, statTiles, subOf, trackOf } from "../pipelineView";

const example = PIPELINE_FIXTURES.find((p) => p.repository === "example-org/example-app")!;
const run = (id: string, at: string, status = "running"): PipelineRun => ({ _id: id, status, workflow_slug: "change", project_path: "/w/example-app", current_node_id: at, created_at: 1 });

describe("the overview's tracks", () => {
  test("the change lane opens on the session, a side-by-side group is a fork, and only the passing path shows", () => {
    const m = pipelineModel(example, [run("a", "ci"), run("b", "merge")]);
    const t = trackOf(m.change, true);
    expect(t.map((x) => (x.type === "fork" ? `[${x.branches.map((b) => b.label).join("|")}]` : x.label))).toEqual(["Session", "PR", "[CI|Review]", "Merge", "Deploy"]);
    const fork = t[2];
    expect(fork.type === "fork" && fork.branches.map((b) => b.count)).toEqual([1, 0]);
    expect(t.find((x) => x.type === "pill" && x.label === "Merge")).toMatchObject({ count: 1, kind: "command", sub: "line.sh" });
    expect(t.find((x) => x.type === "pill" && x.label === "Deploy")).toMatchObject({ kind: "wait", sub: "waits for the deploy" });
  });

  test("a release step with no command is hollow with no sub-label, and the lane says how many run something", () => {
    const m = pipelineModel(example);
    const t = trackOf(m.release, false);
    expect(t.find((x) => x.type === "pill" && x.label === "Gate")).toMatchObject({ kind: "none", sub: null });
    expect(t.find((x) => x.type === "pill" && x.label === "Send")).toMatchObject({ kind: "command", sub: "deploy.sh" });
    expect(runningOf(m.release)).toEqual({ running: 2, steps: 7 });
  });

  test("the figures: in flight with paused, what waits on main, the first target, proposed edits only when there are some", () => {
    const m = pipelineModel(example, [run("a", "ci"), run("p", "merge", "paused")]);
    const tiles = statTiles(m, 10);
    expect(tiles.map((x) => [x.key, x.value, x.label])).toEqual([
      ["flight", "2", "changes in flight · 1 paused"],
      ["main", "0", "commits on main waiting to ship"],
      ["target", "Not read", "production · dashboard builds on push"],
    ]);
    expect(subOf(undefined, undefined)).toBeNull();
  });
});
