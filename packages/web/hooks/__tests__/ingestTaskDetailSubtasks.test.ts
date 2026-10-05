import { afterEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { ingestTaskDetail } from "../useSyncTasks";

// The task detail ships the task's direct children so a surface without the
// task list feeder (a session's task chip) draws the same subtask checklist.
// They join the one tasks collection; a richer row the list already holds
// keeps its enriched fields.

const id = (c: string) => c.repeat(32);
const task = (c: string, extra: Record<string, unknown> = {}) => ({
  _id: id(c), short_id: `ct-${c}`, title: `task ${c}`, status: "open", priority: "medium", task_type: "task",
  user_id: id("u"), created_at: 1, updated_at: 1, ...extra,
});

afterEach(() => useInboxStore.setState({ tasks: {} } as any));

describe("ingestTaskDetail with subtasks", () => {
  it("files the parent and each child into tasks, without a subtasks field on the parent", () => {
    ingestTaskDetail({ ...task("p"), subtasks: [task("a", { parent_id: id("p") }), task("b", { parent_id: id("p"), status: "done" })] });
    const tasks = useInboxStore.getState().tasks as any;
    expect(tasks[id("p")].subtasks).toBeUndefined();
    expect(tasks[id("a")].parent_id).toBe(id("p"));
    expect(tasks[id("b")].status).toBe("done");
  });

  it("merges a child over the list's richer row, keeping its enrichment", () => {
    useInboxStore.getState().syncRecord("tasks", id("a"), task("a", { parent_id: id("p"), assignee_info: { name: "Ada" } }) as any);
    ingestTaskDetail({ ...task("p"), subtasks: [task("a", { parent_id: id("p"), status: "in_progress" })] });
    const a = (useInboxStore.getState().tasks as any)[id("a")];
    expect(a.status).toBe("in_progress");
    expect(a.assignee_info).toEqual({ name: "Ada" });
  });
});
