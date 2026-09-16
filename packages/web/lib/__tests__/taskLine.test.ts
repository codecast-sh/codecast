// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { DEFAULT_TASK_STATUSES, type TeamTaskStatus } from "@codecast/shared/tasks";
import {
  currentStationIndex,
  formatElapsed,
  handWorkState,
  heldDecisionFor,
  lineChipText,
  runForTask,
  runLiveNode,
  stationLabel,
  stationOf,
  stationOrder,
} from "../taskLine";

// The line (docs/architecture/the-line.md L3, L5, L10) as pure derivations:
// the team's statuses are the stations, a pending blocking decision at the
// task's station holds it, and a run's live node is what the strip names.

// Shuffled on purpose, with a custom status inside the started run.
const TEAM: TeamTaskStatus[] = [
  { id: "done", name: "Done", category: "done" },
  { id: "qa", name: "QA", category: "in_review" },
  { id: "open", name: "Open", category: "open" },
  { id: "in_progress", name: "In Progress", category: "in_progress" },
  { id: "backlog", name: "Backlog", category: "backlog" },
];

describe("stations are statuses (L3)", () => {
  it("orders the team's statuses as the pipeline", () => {
    expect(stationOrder(TEAM).map((s) => s.id)).toEqual(["backlog", "open", "in_progress", "qa", "done"]);
  });

  it("finds the current station by status_id first, then by category", () => {
    const stations = stationOrder(TEAM);
    expect(currentStationIndex({ status: "in_review", status_id: "qa" }, stations)).toBe(3);
    expect(currentStationIndex({ status: "in_review" }, stations)).toBe(3);
    expect(currentStationIndex({ status: "open" }, stations)).toBe(1);
    expect(currentStationIndex({ status: "open" }, [])).toBe(-1);
  });

  it("a station's key is the status id, and its label the team's name", () => {
    expect(stationOf({ status: "in_review", status_id: "qa" })).toBe("qa");
    expect(stationOf({ status: "open" })).toBe("open");
    expect(stationLabel("qa", TEAM)).toBe("QA");
    expect(stationLabel("in_review", DEFAULT_TASK_STATUSES)).toBe("In Review");
    expect(stationLabel(null, TEAM)).toBe("unfiled");
    expect(stationLabel("mystery", TEAM)).toBe("mystery");
  });
});

const TASK = { _id: "t1", status: "in_review", status_id: "qa" };
const ask = (over: Record<string, unknown>) => ({ _id: "d", status: "pending", blocking: true, task_id: "t1", station: "qa", created_at: 10, ...over });

describe("a blocking decision holds its task (L5)", () => {
  it("holds only when pending, blocking, bound to the task and at its station", () => {
    expect(heldDecisionFor(TASK, [ask({})])?._id).toBe("d");
    expect(heldDecisionFor(TASK, [ask({ status: "answered" })])).toBeUndefined();
    expect(heldDecisionFor(TASK, [ask({ blocking: false })])).toBeUndefined();
    expect(heldDecisionFor(TASK, [ask({ task_id: "t2" })])).toBeUndefined();
    expect(heldDecisionFor(TASK, [ask({ station: "in_progress" })])).toBeUndefined();
  });

  it("a decision with no station holds nothing, the same as the server rule", () => {
    expect(heldDecisionFor(TASK, [ask({ station: undefined })])).toBeUndefined();
  });

  it("the oldest hold wins when several hold", () => {
    const rows = [ask({ _id: "late", created_at: 30 }), ask({ _id: "early", created_at: 5 }), ask({ _id: "mid", created_at: 20 })];
    expect(heldDecisionFor(TASK, rows)?._id).toBe("early");
  });
});

describe("the run's live node (L10)", () => {
  const run = {
    _id: "r1", status: "running", task_id: "t1", current_node_id: "implement", started_at: 100, updated_at: 500,
    node_statuses: [
      { node_id: "analyze", status: "completed", started_at: 100, completed_at: 200 },
      { node_id: "implement", status: "running", started_at: 200, session_id: "sess-2", session: { _id: "c2", title: "Implement", is_active: true } },
    ],
  };

  it("names the current node, its session and its start", () => {
    const node = runLiveNode(run, [{ id: "implement", label: "Implement it" }]);
    expect(node).toMatchObject({ id: "implement", label: "Implement it", status: "running", session_id: "sess-2", started_at: 200 });
    expect(node?.session?._id).toBe("c2");
  });

  it("prefers the server resolved label, then the node's own, then the id", () => {
    expect(runLiveNode({ ...run, current_node_label: "Build" })?.label).toBe("Build");
    expect(runLiveNode({ ...run, node_statuses: [{ node_id: "implement", status: "running", label: "Own" }] })?.label).toBe("Own");
    expect(runLiveNode(run)?.label).toBe("implement");
    expect(runLiveNode({ ...run, current_node_id: undefined })).toBeNull();
    expect(runLiveNode(null)).toBeNull();
  });

  it("picks the task's run: the named one, else the newest live one bound to it", () => {
    const older = { _id: "r0", status: "running", task_id: "t1", updated_at: 1 };
    const done = { _id: "r9", status: "completed", task_id: "t1", updated_at: 900 };
    expect(runForTask({ _id: "t1", workflow_run_id: "r0" }, [run, older, done])?._id).toBe("r0");
    expect(runForTask({ _id: "t1" }, [older, done, run])?._id).toBe("r1");
    expect(runForTask({ _id: "t1" }, [done])).toBeUndefined();
    expect(runForTask({ _id: "t2" }, [run])).toBeUndefined();
  });

  it("the list chip says held first, then the run's station and node, else nothing", () => {
    expect(lineChipText({ station: "QA", held: ask({}), run })).toBe("held at QA");
    expect(lineChipText({ station: "QA", run, node: runLiveNode(run, [{ id: "implement", label: "Implement" }]) })).toBe("at QA · Implement");
    expect(lineChipText({ station: "QA", run: { ...run, status: "completed" } })).toBeNull();
    expect(lineChipText({ station: "QA" })).toBeNull();
  });

  it("elapsed reads in coarse words", () => {
    expect(formatElapsed(undefined, 1000)).toBeNull();
    expect(formatElapsed(1000, 46_000)).toBe("45s");
    expect(formatElapsed(0, 5 * 60_000)).toBe("5m");
    expect(formatElapsed(0, 90 * 60_000)).toBe("1h 30m");
    expect(formatElapsed(0, 26 * 3_600_000)).toBe("1d 2h");
  });

  it("the hand's stripe follows the store row when held, else the run's own flag", () => {
    expect(handWorkState({ idle: false, waiting: false, rest: "needs_input" }, null)).toBe("working");
    expect(handWorkState({ idle: true, waiting: true, rest: "needs_input" }, null)).toBe("needs_input");
    expect(handWorkState({ idle: true, waiting: false, rest: "needs_input" }, { is_active: true })).toBe("idle");
    expect(handWorkState(null, { is_active: true })).toBe("working");
    expect(handWorkState(null, null)).toBe("idle");
  });
});
