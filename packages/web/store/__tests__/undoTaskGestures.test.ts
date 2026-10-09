import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory, performUndo } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { undoAsOne } from "../undoActions";
import { closeTaskWithGuard } from "../../lib/taskActions";

// One task gesture is one undo. Marking a duplicate links and closes in one
// press, rapid edits of the same field merge, and description saves belong to
// the editor's own undo.
const A = "a".repeat(32);
const B = "b".repeat(32);

const s = () => useInboxStore.getState() as any;
const task = (id: string, short: string, fields: Record<string, unknown> = {}) => ({
  _id: id, short_id: short, title: "Old title", status: "open", priority: "medium", updated_at: 1, ...fields,
});
const labels = () => getUndoHistory().items.map((i) => i.label);
const owner = {};

beforeAll(() => s()._setDispatch(async () => null, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  useInboxStore.setState({ tasks: { [A]: task(A, "ct-1"), [B]: task(B, "ct-2") }, pending: {} } as any);
});

describe("task gestures record one entry each", () => {
  it("marking a duplicate (as the Combine dialog does) is one entry that one undo takes back whole", () => {
    undoAsOne("Marked ct-1 as a duplicate of ct-2", () => {
      s().updateTask("ct-1", { duplicate_of: "ct-2" });
      closeTaskWithGuard("ct-1", "dropped");
    });
    expect(labels()).toEqual(["Marked ct-1 as a duplicate of ct-2"]);
    performUndo();
    expect(s().tasks[A].status).toBe("open");
    expect(s().tasks[A].duplicate_of ?? null).toBe(null);
  });

  it("a lone duplicate_of edit names what changed", () => {
    s().updateTask("ct-1", { duplicate_of: "ct-2" });
    expect(labels()).toEqual(["Marked ct-1 as a duplicate of ct-2"]);
  });

  it("cycling priority quickly is one entry", () => {
    for (const p of ["high", "urgent", "low"]) s().updateTask("ct-1", { priority: p });
    expect(labels()).toEqual(["Set ct-1 to low priority"]);
    performUndo();
    expect(s().tasks[A].priority).toBe("medium");
  });

  it("setting and clearing where a task was found names the link, and the undo reaches the server", async () => {
    // The task page's Found during row: the server GUESSES the link from the
    // filing session's bound task (TG5), so both the repoint and the clear are
    // ordinary edits with an undo that webUpdate can carry ("" is its clear).
    s().updateTask("ct-1", { found_during: "ct-2" });
    expect(labels()).toEqual(["Marked ct-1 as found during ct-2"]);
    expect(s().tasks[A].found_during).toBe("ct-2");
    performUndo();
    expect(s().tasks[A].found_during ?? null).toBe(null);

    _resetUndoStacks();
    s().updateTask("ct-1", { found_during: "ct-2" });
    _resetUndoStacks();
    s().updateTask("ct-1", { found_during: "" });
    expect(labels()).toEqual(["Cleared where ct-1 was found"]);
    performUndo();
    expect(s().tasks[A].found_during).toBe("ct-2");
  });

  it("debounced description saves record nothing: the editor owns text undo", () => {
    for (const d of ["a", "ab", "abc"]) s().updateTask("ct-1", { description: d });
    expect(labels()).toEqual([]);
    expect(s().tasks[A].description).toBe("abc");
  });
});

// A drop into another group's gap edits the grouped field AND sets a rank.
// Live tasks have no rank yet, and a rank cannot be cleared on the server, so
// the rank write records nothing; the field edit must still be one undo.
describe("a board drop into another group's gap", () => {
  it("is one undo for the field change, even when the task had no rank", async () => {
    const { applyTaskDrop } = await import("../../lib/taskActions");
    applyTaskDrop("ct-1", { priority: "high", sort_order: 12345 });
    expect(s().tasks[A].priority).toBe("high");
    expect(s().tasks[A].sort_order).toBe(12345);
    expect(labels()).toEqual(["Set ct-1 to high priority"]);
    performUndo();
    expect(s().tasks[A].priority).toBe("medium");
  });

  it("a status change with a rank is undoable too", async () => {
    const { applyTaskDrop } = await import("../../lib/taskActions");
    applyTaskDrop("ct-1", { status: "in_progress", sort_order: 12345 });
    expect(labels()).toHaveLength(1);
    performUndo();
    expect(s().tasks[A].status).toBe("open");
  });

  it("a close with a field change and a rank takes both edits back in one undo", async () => {
    const { applyTaskDrop } = await import("../../lib/taskActions");
    applyTaskDrop("ct-1", { status: "done", priority: "high", sort_order: 12345 });
    expect(labels()).toHaveLength(1);
    performUndo();
    expect([s().tasks[A].status, s().tasks[A].priority]).toEqual(["open", "medium"]);
  });

  it("a pure reorder of an unranked task records nothing", async () => {
    const { applyTaskDrop } = await import("../../lib/taskActions");
    applyTaskDrop("ct-1", { sort_order: 12345 });
    expect(labels()).toEqual([]);
  });
});

// A team's own statuses refine a category; the label names the one picked.
describe("status labels name the team's status", () => {
  const TEAM = "t".repeat(32);
  const statuses = [
    { id: "open", name: "Open", category: "open" },
    { id: "in_progress", name: "In Progress", category: "in_progress" },
    { id: "s_today", name: "Today", category: "in_progress" },
    { id: "s_wait", name: "Pending Approval", category: "in_review" },
  ];
  beforeEach(() => {
    useInboxStore.setState({
      teams: [{ _id: TEAM, task_statuses: statuses }],
      tasks: { [A]: task(A, "ct-1", { team_id: TEAM }) },
    } as any);
  });

  it("a move to a custom status names it", () => {
    s().updateTask("ct-1", { status: "in_progress", status_id: "s_today" });
    expect(labels()).toEqual(["Moved ct-1 to Today"]);
  });

  it("a move to a category default names the default", () => {
    s().updateTask("ct-1", { status: "in_progress", status_id: "" });
    expect(labels()).toEqual(["Moved ct-1 to In Progress"]);
  });

  it("an unknown status id falls back to the category", () => {
    s().updateTask("ct-1", { status: "in_review", status_id: "gone" });
    expect(labels()).toEqual(["Moved ct-1 to In Review"]);
  });
});

// A bulk edit from the context menu or the palette is named for what it
// changed, the way a single task's edit is, so two bulk gestures on the same
// tasks read differently in the timeline and the Undid toast.
describe("bulk task edits name the change", () => {
  it("status, priority, assignee and a terminal status each read as themselves", async () => {
    const { updateTasksAsOne } = await import("../../lib/taskActions");
    const SAM = "s".repeat(32);
    useInboxStore.setState({ teamMembers: [{ _id: SAM, name: "Sam" }] } as any);
    updateTasksAsOne(["ct-1", "ct-2"], { status: "in_progress" });
    updateTasksAsOne(["ct-1", "ct-2"], { priority: "high" });
    updateTasksAsOne(["ct-1", "ct-2"], { assignee: SAM });
    updateTasksAsOne(["ct-1", "ct-2"], { assignee: null });
    updateTasksAsOne(["ct-1", "ct-2"], { status: "done" });
    expect(labels()).toEqual([
      "Moved 2 tasks to Done",
      "Unassigned 2 tasks",
      "Assigned 2 tasks to Sam",
      "Set 2 tasks to high priority",
      "Moved 2 tasks to In Progress",
    ]);
    expect(s().tasks[A].status).toBe("done");
  });
});
