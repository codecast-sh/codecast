import { describe, expect, test } from "bun:test";
import { linkedWorkspace } from "../useLineSpace";

const TEAM = "team:t1";
const state = (extra: Record<string, unknown> = {}) => ({
  tasks: { task1: { _id: "task1", short_id: "ct-1", workspace: TEAM } },
  sessionDecisions: {},
  projects: {},
  workflowRuns: { run1: { task_id: "task1" }, run2: { workspace: "team:t2", task_id: "task1" } },
  ...extra,
}) as never;
const sel = (s: Record<string, string>) => ({ need: null, case: null, run: null, decision: null, project: null, ...s }) as never;

describe("linkedWorkspace", () => {
  test("a run link with no problem reads the workspace of the run's problem", () => {
    expect(linkedWorkspace(state(), sel({ run: "run1" }))).toBe(TEAM);
  });
  test("a run's own workspace wins over its problem's", () => {
    expect(linkedWorkspace(state(), sel({ run: "run2" }))).toBe("team:t2");
  });
  test("a run the store does not hold names no workspace", () => {
    expect(linkedWorkspace(state(), sel({ run: "nope" }))).toBe(null);
  });
  test("the problem in the address is read before its run", () => {
    expect(linkedWorkspace(state(), sel({ case: "ct-1", run: "run2" }))).toBe(TEAM);
  });
});
