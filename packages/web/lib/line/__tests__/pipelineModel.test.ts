import { describe, expect, test } from "bun:test";
import { PIPELINE_FIXTURES } from "./pipelines.fixture.generated";
import { changesHere, pipelineModel, spanWords, pipelineStation, runInRepo, stationRuns, whenWords, type PipelineRun } from "../pipelineModel";
import type { Pipeline } from "../pipelineTypes";
import type { DeployTargetRow, TeamDeployRow } from "../../deploys/targets";

const example = PIPELINE_FIXTURES.find((p) => p.repository === "example-org/example-app")!;
const codecast = PIPELINE_FIXTURES.find((p) => p.repository === "codecast-sh/codecast")!;
const labels = (steps: { label: string }[]) => steps.map((s) => s.label);

const run = (over: Partial<PipelineRun>): PipelineRun => ({ _id: "r", status: "running", workflow_slug: "change", project_path: "/Users/x/src/example-app/backend", created_at: 1, ...over });

const targetRow = (over: Partial<DeployTargetRow>): DeployTargetRow => ({
  _id: "t", workspace: "team:t", team_id: "t", name: "production", repository: "example-org/example-app", runs: "here", policy: "press", command: "x", rollback: null, paths: [],
  can_deploy: true, can_redeploy_sha: true, can_rollback: false, device_id: null, publisher_user_id: "u",
  queue: { known: true, truncated: false, commits: 3, untouched: 0, head_sha: "abc", head_ci: "passed", head_ci_url: null, shown: 3, groups: [] },
  ...over,
});
const deploy = (over: Partial<TeamDeployRow>): TeamDeployRow => ({
  _id: "d", workspace: "team:t", target: "production", repository: "example-org/example-app", short_id: "dp-7", status: "live", action: "deploy", rollback_of: null,
  sha: "s", previous_sha: null, version: null, url: null, started_by: null, note: null, commits: 0, sessions: [], created_at: 10, live_at: 11, finished_at: 11, ...over,
});

describe("pipeline model on the real flows", () => {
  test("The example repo's change lane is its own flow's passing path, every station its own", () => {
    const m = pipelineModel(example);
    expect(labels(m.change.diagram.steps)).toEqual(["PR", "CI and review", "Merge", "Deploy"]);
    expect(labels(m.change.diagram.steps[1].inner)).toEqual(["CI", "Review"]);
    expect(m.change.diagram.end).toBe("Live");
    expect(m.change.inherited).toBe(0);
    // All its own: the lane says so once, no step is singled out.
    expect(Object.values(m.change.marks).every((x) => x.own === null)).toBe(true);
  });

  test("codecast runs the shipped change as is: every station inherited, no marks of its own", () => {
    const m = pipelineModel(codecast);
    expect(labels(m.change.diagram.steps)).toEqual(["Check", "Review", "Decide", "Land", "Deploy"]);
    expect(m.change.own).toBe(0);
    expect(Object.values(m.change.marks).every((x) => x.own === null)).toBe(true);
  });

  test("the release lane is line-deploy in its order, and steps without a command say they pass", () => {
    const m = pipelineModel(example);
    expect(labels(m.release.diagram.steps)).toEqual(["CI", "Send", "Gate", "Roll out", "Live", "Finish", "Watch"]);
    expect(m.release.marks.send.passes).toBeUndefined();
    for (const id of ["ci", "gate", "rollout", "live", "finish"]) expect(m.release.marks[id].passes).toBe(true);
    // Every step's failure goes back to the line: said once on the lane, under no step.
    expect(m.release.shared?.outcome).toBe("Back to the line");
    expect(m.release.diagram.steps.every((st) => !st.side.some((r) => r.outcome === "Back to the line"))).toBe(true);
    // Watch is codecast's own step, not a command of the profile.
    expect(m.release.marks.watch.passes).toBeUndefined();
  });

  test("The example repo's Deploy waits for the deploy and sends none; codecast's release steps differ by target", () => {
    expect(pipelineModel(example).change.marks.deploy).toMatchObject({ waits: true });
    const cc = pipelineModel(codecast).release;
    expect(cc.marks.send.varies).toBe(true);
    expect(cc.marks.gate.passes).toBe(true);
    expect(pipelineStation(codecast, "release", "send")?.targets?.map((t) => t.name)).toEqual(["backend", "cli", "mobile", "desktop"]);
  });

  test("main lists each declared target, waiting and live from the store", () => {
    const m = pipelineModel(example, [], [targetRow({})], [deploy({})]);
    expect(m.main.targets.map((t) => t.name)).toEqual(["production", "dashboard"]);
    const prod = m.main.targets[0];
    expect(prod).toMatchObject({ tone: "waiting", waiting: 3, live: { deploy: "dp-7" }, going: null });
    expect(m.main.targets[1]).toMatchObject({ runs: "push", tone: "unknown", waiting: 0 });
    expect(m.main.waiting).toBe(3);
    // A version that is only a commit hash is not shown.
    expect(pipelineModel(example, [], [targetRow({})], [deploy({ version: "ca5afca75" })]).main.targets[0].live?.version).toBeNull();
    expect(pipelineModel(example, [], [targetRow({})], [deploy({ version: "1.1.230" })]).main.targets[0].live?.version).toBe("1.1.230");
  });
});

describe("what is on the pipeline now", () => {
  test("a live run counts on the station it stands at; a segment's step counts on the segment", () => {
    const m = pipelineModel(codecast, [
      run({ _id: "a", current_node_id: "review__review", project_path: "/w/codecast" }),
      run({ _id: "b", current_node_id: "review", project_path: "/w/codecast/.codecast/worktrees/x" }),
      run({ _id: "c", current_node_id: "check", status: "completed", project_path: "/w/codecast" }),
      run({ _id: "d", current_node_id: "check", project_path: "/w/example-app" }),
    ]);
    expect(m.change.marks.review.here).toBe(2);
    expect(m.change.marks.review.hereNames).toHaveLength(2);
    expect(m.change.marks.check.here).toBeUndefined();
    expect(m.change.inFlight).toBe(2);
  });

  test("a folded frame counts the changes on the steps inside it", () => {
    const m = pipelineModel(example, [run({ _id: "a", current_node_id: "ci" }), run({ _id: "b", current_node_id: "review" })]);
    expect(m.change.marks.ci.here).toBe(1);
    expect(m.change.marks.checks.here).toBe(2);
  });

  test("a change at a station off the passing path counts on the step whose route leads there", () => {
    const m = pipelineModel(example, [run({ _id: "a", current_node_id: "brief" })]);
    const counted = Object.entries(m.change.marks).filter(([, x]) => x.here).map(([id, x]) => [id, x.here]);
    expect(counted.length).toBeGreaterThan(0);
    expect(counted.every(([id]) => m.change.diagram.steps.some((st) => st.id === id || st.inner.some((i) => i.id === id)))).toBe(true);
    expect(m.change.inFlight).toBe(1);
  });

  test("runs of other flows or other repos never count", () => {
    expect(runInRepo({ project_path: "/Users/x/src/example-app/backend" }, "example-org/example-app")).toBe(true);
    expect(runInRepo({ project_path: "/Users/x/src/codecast" }, "example-org/example-app")).toBe(false);
    const here = changesHere(example.change, [run({ current_node_id: "pr", workflow_slug: "onefix" })].filter((r) => r.workflow_slug === "change"));
    expect(here.size).toBe(0);
  });

  test("a deploy codecast sends draws on the release lane at its running step", () => {
    const going = deploy({ _id: "g", short_id: "dp-8", status: "running", live_at: null, created_at: 20, steps: [{ id: "ci", status: "completed" }, { id: "send", status: "running" }, { id: "gate", status: "pending" }] });
    const m = pipelineModel(example, [], [targetRow({})], [deploy({}), going]);
    expect(m.release.run?.current_node_id).toBe("send");
    expect(m.release.marks.send.here).toBe(1);
    expect(m.release.outside).toBeNull();
    expect(m.main.targets[0]).toMatchObject({ tone: "going", going: { deploy: "dp-8", step: "Send", outside: false } });
  });

  test("a deploy open for hours without going live is stuck, not going out", () => {
    const H = 3600_000;
    const silent = deploy({ _id: "s", short_id: "dp-9", status: "running", live_at: null, created_at: 0 });
    const m = pipelineModel(example, [], [targetRow({})], [silent], 40 * H);
    expect(m.main.targets[0]).toMatchObject({ tone: "stuck", going: { deploy: "dp-9", stuck: 40 * H } });
    expect(m.release.stuck).toEqual({ deploy: "dp-9", for: 40 * H, outside: true });
    // Silent for an hour is still going out; a deploy reporting its steps gets a slow gate's hours.
    expect(pipelineModel(example, [], [targetRow({})], [silent], 1 * H).main.targets[0].tone).toBe("going");
    const reporting = deploy({ ...silent, steps: [{ id: "gate", status: "running" }] });
    expect(pipelineModel(example, [], [targetRow({})], [reporting], 4 * H).main.targets[0].tone).toBe("going");
    expect(spanWords(40 * H)).toBe("1d 16h");
    expect(spanWords(45 * 60_000)).toBe("45m");
  });

  test("an open deploy older than the live one is superseded: neither going out nor stuck", () => {
    const H = 3600_000;
    const old = deploy({ _id: "o", short_id: "dp-1969", status: "requested", live_at: null, created_at: 0 });
    const newer = deploy({ _id: "n", short_id: "dp-2299", status: "live", created_at: 30 * H, live_at: 30 * H });
    const m = pipelineModel(example, [], [targetRow({})], [old, newer], 44 * H);
    expect(m.main.targets[0].going).toBeNull();
    expect(m.main.targets[0].tone).not.toBe("stuck");
    expect(m.main.targets[0].live?.deploy).toBe("dp-2299");
    expect(m.release.stuck).toBeNull();
    expect(m.release.outside).toBeNull();
  });

  test("a deploy sent outside codecast says so instead of drawing passed steps", () => {
    const gh = deploy({ _id: "g", short_id: "dp-9", status: "running", live_at: null, created_at: 20, source: "github:deploy.yml" });
    const m = pipelineModel(example, [], [targetRow({})], [gh]);
    expect(m.release.run).toBeNull();
    expect(m.release.outside).toBe("by GitHub");
    expect(m.main.targets[0].going).toMatchObject({ deploy: "dp-9", outside: true });
  });
});

describe("own stations", () => {
  test("an added or changed station carries its mark and the paths it runs for", () => {
    const edited: Pipeline = {
      ...codecast,
      change: { ...codecast.change, stations: codecast.change.stations.map((s) => (s.id === "review" ? { ...s, own: "changed" as const, changed: ["guidance added"], when: ["packages/web/**", "packages/shared/**"] } : s)) },
    };
    const m = pipelineModel(edited);
    expect(m.change.marks.review).toEqual({ own: "changed", changed: ["guidance added"], when: "packages/web/** +1" });
    expect(m.change.own).toBe(1);
    expect(whenWords(undefined)).toBeNull();
  });

  test("a station and its recent runs by id", () => {
    expect(pipelineStation(example, "change", "review")?.prompt).toBeTruthy();
    expect(pipelineStation(example, "release", "send")?.runs).toContain("./deploy.sh");
    const runs = [run({ _id: "a", current_node_id: "merge", updated_at: 5 }), run({ _id: "b", node_statuses: [{ node_id: "merge", status: "completed" }], updated_at: 9 }), run({ _id: "c", current_node_id: "pr" })];
    expect(stationRuns(runs, "merge").map((r) => r._id)).toEqual(["b", "a"]);
  });
});
