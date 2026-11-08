import { describe, expect, test } from "bun:test";
import { projectParentIdOf, sessionProjectId, type SessionProjectRow } from "./sessionProject";

type Row = SessionProjectRow & { _id: string };

function lookupOf(rows: Row[], tasks: Record<string, string> = {}, plans: Record<string, string> = {}) {
  const byId = new Map(rows.map((r) => [r._id, r]));
  return {
    session: (id: string) => byId.get(id),
    taskProject: (id: string) => tasks[id] ?? null,
    planProject: (id: string) => plans[id] ?? null,
  };
}

describe("sessionProjectId", () => {
  test("a session's own project wins over its task and its parent", () => {
    const parent: Row = { _id: "p", project_id: "proj-parent" };
    const child: Row = { _id: "c", project_id: "proj-own", active_task_id: "t1", parent_conversation_id: "p" };
    expect(sessionProjectId(child, lookupOf([parent, child], { t1: "proj-task" }))).toBe("proj-own");
  });

  test("a bound task names the project before the parent does", () => {
    const parent: Row = { _id: "p", project_id: "proj-parent" };
    const child: Row = { _id: "c", active_task_id: "t1", parent_conversation_id: "p" };
    expect(sessionProjectId(child, lookupOf([parent, child], { t1: "proj-task" }))).toBe("proj-task");
  });

  test("a bound plan names the project when the task has none", () => {
    const s: Row = { _id: "s", active_task_id: "t-loose", active_plan_id: "pl1" };
    expect(sessionProjectId(s, lookupOf([s], {}, { pl1: "proj-plan" }))).toBe("proj-plan");
  });

  test("workers of workers inherit the project of the session at the top", () => {
    const lead: Row = { _id: "lead", project_id: "proj" };
    const worker: Row = { _id: "w", parent_conversation_id: "lead" };
    const spawned: Row = { _id: "s", spawned_by_conversation_id: "w" };
    expect(sessionProjectId(spawned, lookupOf([lead, worker, spawned]))).toBe("proj");
  });

  test("moving the parent moves its workers, since nothing was copied", () => {
    const lead: Row = { _id: "lead", project_id: "a" };
    const worker: Row = { _id: "w", parent_conversation_id: "lead" };
    expect(sessionProjectId(worker, lookupOf([lead, worker]))).toBe("a");
    lead.project_id = "b";
    expect(sessionProjectId(worker, lookupOf([lead, worker]))).toBe("b");
  });

  test("a parent missing from the lookup gives no answer", () => {
    const worker: Row = { _id: "w", parent_conversation_id: "gone" };
    expect(sessionProjectId(worker, lookupOf([worker]))).toBeNull();
  });

  test("a cycle in the parent links ends with no answer", () => {
    const a: Row = { _id: "a", parent_conversation_id: "b" };
    const b: Row = { _id: "b", spawned_by_conversation_id: "a" };
    expect(sessionProjectId(a, lookupOf([a, b]))).toBeNull();
  });

  test("a session in no project, started by nobody, is in none", () => {
    const s: Row = { _id: "s" };
    expect(sessionProjectId(s, lookupOf([s]))).toBeNull();
  });
});

describe("projectParentIdOf", () => {
  test("the parent link comes before the spawner", () => {
    expect(projectParentIdOf({ _id: "x", parent_conversation_id: "p", spawned_by_conversation_id: "s" })).toBe("p");
    expect(projectParentIdOf({ _id: "x", spawned_by_conversation_id: "s" })).toBe("s");
    expect(projectParentIdOf({ _id: "x" })).toBeNull();
  });
});
