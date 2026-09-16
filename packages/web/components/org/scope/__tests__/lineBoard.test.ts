import { describe, expect, test } from "bun:test";
import { DEFAULT_TASK_STATUSES } from "@codecast/shared/tasks";
import { evidenceCount, heldAt, lineColumns, lineOptions, liveNodeOf, runForTask, workStateOfVerdict } from "../lineBoard";

// The Line tab's rules (docs/architecture/the-line.md L3, L5, L10), tested
// without React: stations are the team's statuses in order, a task sits in
// the column of its status, a pending blocking decision at that station holds
// it, and the run named on the task is the one the card reads its node from.

const t = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ _id: id, status, updated_at: 1, ...extra });

describe("lineColumns", () => {
  test("one column per status in pipeline order, tasks in the column of their status", () => {
    const cols = lineColumns([t("a", "in_review"), t("b", "open"), t("c", "open", { updated_at: 5 })], DEFAULT_TASK_STATUSES);
    expect(cols.map((c) => c.status.id)).toEqual(["backlog", "open", "in_progress", "in_review", "done", "dropped"]);
    expect(cols.find((c) => c.status.id === "open")!.tasks.map((x) => x._id)).toEqual(["c", "b"]);
    expect(cols.find((c) => c.status.id === "in_review")!.tasks.map((x) => x._id)).toEqual(["a"]);
    expect(cols.find((c) => c.status.id === "done")!.tasks).toEqual([]);
  });

  test("a custom status id lands in its own column; a stray status_id falls back to the category", () => {
    const statuses = [...DEFAULT_TASK_STATUSES, { id: "qa", name: "QA", category: "in_review" as const }];
    const cols = lineColumns([t("a", "in_review", { status_id: "qa" }), t("b", "in_review", { status_id: "gone" })], statuses);
    expect(cols.find((c) => c.status.id === "qa")!.tasks.map((x) => x._id)).toEqual(["a"]);
    expect(cols.find((c) => c.status.id === "in_review")!.tasks.map((x) => x._id)).toEqual(["b"]);
  });
});

describe("heldAt", () => {
  const d = (id: string, extra: Record<string, unknown>) => ({ _id: id, status: "pending", blocking: true, ...extra });
  test("a pending blocking decision at the task's station holds it", () => {
    const task = t("a", "in_review");
    expect(heldAt(task, [d("d1", { task_id: "a", station: "in_review" })])?._id).toBe("d1");
  });
  test("another station, another task, an advisory ask or an answered one does not", () => {
    const task = t("a", "in_review");
    expect(heldAt(task, [d("d1", { task_id: "a", station: "open" })])).toBeNull();
    expect(heldAt(task, [d("d1", { task_id: "b", station: "in_review" })])).toBeNull();
    expect(heldAt(task, [d("d1", { task_id: "a", station: "in_review", blocking: false })])).toBeNull();
    expect(heldAt(task, [d("d1", { task_id: "a", station: "in_review", status: "answered" })])).toBeNull();
  });
  test("a team status id counts as the station too", () => {
    const task = t("a", "in_review", { status_id: "qa" });
    expect(heldAt(task, [d("d1", { task_id: "a", station: "qa" })])?._id).toBe("d1");
  });
});

describe("runForTask and liveNodeOf", () => {
  const runs = [
    { _id: "r1", task_id: "a", status: "completed", current_node_id: "exit", updated_at: 9 },
    { _id: "r2", task_id: "a", status: "running", current_node_id: "implement", current_node_label: "Implement", updated_at: 5 },
    { _id: "r3", task_id: "b", status: "paused", current_node_id: "review", updated_at: 7 },
  ];
  test("the run the task names wins over a newer one by task id", () => {
    expect(runForTask(t("a", "in_progress", { workflow_run_id: "r2" }), runs)?._id).toBe("r2");
  });
  test("without a named run, the newest run bound to the task", () => {
    expect(runForTask(t("a", "in_progress"), runs)?._id).toBe("r1");
    expect(runForTask(t("z", "open"), runs)).toBeNull();
  });
  test("the live node is the label, else the id, and nothing once the run is over", () => {
    expect(liveNodeOf(runs[1])).toBe("Implement");
    expect(liveNodeOf(runs[2])).toBe("review");
    expect(liveNodeOf(runs[0])).toBeNull();
    expect(liveNodeOf(null)).toBeNull();
  });
});

describe("workStateOfVerdict and evidenceCount", () => {
  test("folds a session verdict back to a work state", () => {
    expect(workStateOfVerdict({ idle: false, waiting: false, rest: "needs_input" })).toBe("working");
    expect(workStateOfVerdict({ idle: true, waiting: true, rest: "dormant" })).toBe("dormant");
    expect(workStateOfVerdict({ idle: true, waiting: false, rest: "needs_input" })).toBe("idle");
    expect(workStateOfVerdict(null)).toBeNull();
  });
  test("counts the task's pages in the store and its handoff files", () => {
    const task = t("a", "in_review", { files_changed: ["x.ts", "y.ts"] });
    expect(evidenceCount(task, [{ task_id: "a" }, { task_id: "a" }, { task_id: "b" }, {}])).toEqual({ pages: 2, files: 2 });
    expect(evidenceCount(t("q", "open"), [])).toEqual({ pages: 0, files: 0 });
  });
});

describe("lineOptions", () => {
  test("shipped templates first, own workflows after, an own row with a shipped slug wins", () => {
    const rows = lineOptions([{ slug: "feature", name: "Feature (ours)" }, { slug: "release", name: "Release train" }, { slug: "release" }], "line");
    expect(rows.map((r) => r.slug)).toEqual(["line", "feature", "plan-autopilot", "release"]);
    expect(rows[0]).toEqual({ slug: "line", label: "line (shipped)", shipped: true });
    expect(rows[1]).toEqual({ slug: "feature", label: "Feature (ours) (yours)", shipped: false });
    expect(rows[3].label).toBe("Release train (release)");
  });
  test("a current slug nothing lists stays selectable", () => {
    const rows = lineOptions([], "custom-line");
    expect(rows.at(-1)).toEqual({ slug: "custom-line", label: "custom-line (not pushed)", shipped: false });
  });
});
