import { describe, expect, test } from "bun:test";
import { isBlockedExecution, releaseBlockFields } from "./tasks";

// Retry from the inbox's Needs Attention section clears a task's block. The
// line (the-line.md L9) starts only open tasks with no workflow_run_id, so the
// retry must let go of a run that has ended, or the task never runs again.

const dbWith = (runs: Record<string, any>) => ({ db: { get: async (id: string) => runs[id] ?? null } });

describe("releaseBlockFields", () => {
  test("detaches a failed run so the line can start a fresh one", async () => {
    const fields = await releaseBlockFields(dbWith({ run_1: { status: "failed" } }), { workflow_run_id: "run_1", execution_concerns: "hand killed" });
    expect(fields).toEqual({ execution_concerns: undefined, retry_count: 0, workflow_run_id: undefined, workflow_node_id: undefined });
    expect("workflow_run_id" in fields).toBe(true);
  });

  test("detaches a completed run and a run that no longer exists", async () => {
    expect("workflow_run_id" in await releaseBlockFields(dbWith({ run_1: { status: "completed" } }), { workflow_run_id: "run_1" })).toBe(true);
    expect("workflow_run_id" in await releaseBlockFields(dbWith({}), { workflow_run_id: "gone" })).toBe(true);
  });

  test("keeps a live run bound", async () => {
    for (const status of ["pending", "running", "paused"]) {
      const fields = await releaseBlockFields(dbWith({ run_1: { status } }), { workflow_run_id: "run_1" });
      expect("workflow_run_id" in fields).toBe(false);
      expect(fields.retry_count).toBe(0);
    }
  });

  test("a task with no run only resets the reason and the retry budget", async () => {
    expect(await releaseBlockFields(dbWith({}), {})).toEqual({ execution_concerns: undefined, retry_count: 0 });
  });
});

test("isBlockedExecution covers both attention states", () => {
  expect(isBlockedExecution("blocked")).toBe(true);
  expect(isBlockedExecution("needs_context")).toBe(true);
  expect(isBlockedExecution("done_with_concerns")).toBe(false);
  expect(isBlockedExecution(undefined)).toBe(false);
});
