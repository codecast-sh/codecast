import { describe, expect, test } from "bun:test";
import { isEndedRunLog } from "../RunLogEndedBar";

describe("isEndedRunLog", () => {
  const ended = { _id: "run1", status: "completed" };
  test("the log a run created gives its composer way once the run ends", () => {
    expect(isEndedRunLog({ is_workflow_primary: true, session_id: "wf-run1" }, ended)).toBe(true);
    expect(isEndedRunLog({ is_workflow_primary: true, session_id: "wf-run1" }, { _id: "run1", status: "running" })).toBe(false);
  });
  test("a real session that hosted the run keeps its composer: its agent still reads it", () => {
    expect(isEndedRunLog({ is_workflow_primary: true, session_id: "3f2a9c1e-claude-session" }, ended)).toBe(false);
    expect(isEndedRunLog({ is_workflow_primary: true, session_id: "wf-other" }, ended)).toBe(false);
  });
});
