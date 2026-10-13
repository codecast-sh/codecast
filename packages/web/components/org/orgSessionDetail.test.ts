import { describe, expect, it } from "bun:test";
import { sessionDetailOf, sessionDetailsOf, sessionDetailsSig } from "./orgSessionDetail";

describe("orgSessionDetail", () => {
  it("says where a session stands from its pinned state first, its idle summary second, and names its task", () => {
    expect(sessionDetailOf({ thread_state: "Goal: ship the chart\nStatus: waiting on review", idle_summary: "older summary", active_task: { _id: "t", short_id: "ct-9", title: "Chart", status: "in_progress" } }))
      .toEqual({ line: "waiting on review", task: { short_id: "ct-9", title: "Chart" } });
    expect(sessionDetailOf({ thread_state: "  ", idle_summary: " Fixed the bug " })).toEqual({ line: "Fixed the bug", task: null });
    expect(sessionDetailOf(undefined)).toEqual({ line: null, task: null });
  });

  it("keeps only sessions with something to say, and its signature moves on a line or a task, never on a heartbeat", () => {
    const rows: Record<string, any> = { a: { idle_summary: "done", last_heartbeat: 1 }, b: { last_heartbeat: 1 } };
    expect(Object.keys(sessionDetailsOf(["a", "b", "c"], rows))).toEqual(["a"]);
    const before = sessionDetailsSig(["a", "b"], rows);
    rows.a = { ...rows.a, last_heartbeat: 2 };
    expect(sessionDetailsSig(["a", "b"], rows)).toBe(before);
    rows.b = { ...rows.b, active_task: { short_id: "ct-1", title: "x" } };
    expect(sessionDetailsSig(["a", "b"], rows)).not.toBe(before);
  });
});
