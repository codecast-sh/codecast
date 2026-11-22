import { describe, expect, test } from "bun:test";
import { PIPELINE_FIXTURES } from "./pipelines.fixture.generated";
import { pipelineModel, type PipelineRun } from "../pipelineModel";
import { STALL_MS, statTiles, subOf, trackOf } from "../pipelineView";
import type { TeamDeployRow } from "../../deploys/targets";

const example = PIPELINE_FIXTURES.find((p) => p.repository === "example-org/example-app")!;
const H = 3600_000;
const NOW = 100 * H;
const run = (id: string, at: string, status = "running", since = NOW): PipelineRun => ({ _id: id, status, workflow_slug: "change", project_path: "/w/example-app", current_node_id: at, created_at: since, updated_at: since });
const failedDeploy = { _id: "d1", target: "production", repository: "example-org/example-app", short_id: "dp-7", status: "failed", created_at: NOW - 3 * H, finished_at: NOW - 2 * H, live_at: null } as unknown as TeamDeployRow;
const pill = (t: ReturnType<typeof trackOf>, label: string) => t.find((x) => x.type === "pill" && x.label === label);

describe("the overview's tracks", () => {
  test("the change lane opens on the session, a side-by-side group is a fork, and it ends waiting for the release", () => {
    const m = pipelineModel(example, [run("a", "ci"), run("b", "merge")]);
    const t = trackOf(m, "change", NOW);
    expect(t.map((x) => (x.type === "fork" ? `[${x.branches.map((b) => b.label).join("|")}]` : x.label))).toEqual(["Session", "PR", "[CI|Review]", "Merge", "Wait for release"]);
    const fork = t[2];
    expect(fork.type === "fork" && fork.branches.map((b) => b.count)).toEqual([1, 0]);
    expect(pill(t, "Merge")).toMatchObject({ count: 1, stalled: 0, kind: "command", sub: "line.sh" });
    // The change lane deploys nothing: its last station waits, and its edge runs into main.
    expect(pill(t, "Wait for release")).toMatchObject({ kind: "wait", sub: "until it is live", intoMain: true });
  });

  test("a change standing at a station a day or more has stalled: counted apart", () => {
    const m = pipelineModel(example, [run("a", "merge", "running", NOW - STALL_MS - H), run("b", "merge")]);
    expect(pill(trackOf(m, "change", NOW), "Merge")).toMatchObject({ count: 2, stalled: 1 });
  });

  test("a release step with no command says it passes; the station the last release failed at says so", () => {
    const m = pipelineModel(example, [], [], [failedDeploy], NOW);
    const t = trackOf(m, "release", NOW);
    expect(pill(t, "Gate")).toMatchObject({ kind: "none", sub: "passes", failed: null });
    // It reported no steps, so the failure sits on the station that sends production.
    expect(pill(t, "Send")).toMatchObject({ kind: "command", failed: "failed 2h ago · production", sub: null });
  });

  test("the figures open what they count; a failed target opens its deploy; no edit, no edit figure", () => {
    const m = pipelineModel(example, [run("a", "ci"), run("p", "merge", "paused")], [], [failedDeploy], NOW);
    const tiles = statTiles(m, NOW);
    expect(tiles.map((x) => [x.key, x.value, x.label, x.open])).toEqual([
      ["flight", "2", "changes in flight · 1 paused", { kind: "flight" }],
      ["main", "0", "commits on main waiting to ship", { kind: "main" }],
      ["target", "Failed", "production · dashboard builds on push", { kind: "deploy", deploy: "dp-7" }],
    ]);
    expect(tiles[2]).toMatchObject({ tone: "bad", small: "2h ago" });
    expect(subOf(undefined, undefined)).toBeNull();
  });
});
