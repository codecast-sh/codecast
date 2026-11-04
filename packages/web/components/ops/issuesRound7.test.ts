import { describe, expect, test } from "bun:test";
import type { OpsGroup } from "./opsTypes";
import { DEFAULT_QUERY, filterIssues, fixActionLabel, issueOnIt, issueQueryParams, parseIssueQuery, someoneOnIt, type FixTask, type IssueCtx } from "./issuesModel";
import { handled } from "./opsHomeModel";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 4, 15, 37);
const g = (over: Partial<OpsGroup> = {}): OpsGroup =>
  ({ _id: over.short_id ?? "g1", short_id: "eg-1", source_id: "s1", kind: "error", title: "TypeError: x", status: "open", count: 3, first_seen: NOW - 2 * HOUR, last_seen: NOW - HOUR, buckets: [{ hour: Math.floor((NOW - HOUR) / HOUR) * HOUR, count: 3 }], ...over }) as OpsGroup;

describe("who is on an issue", () => {
  test("a fix session, a worked task or an assignee on an open task is someone; a filed task alone is nobody", () => {
    expect(someoneOnIt(null, undefined)).toBe(false);
    expect(someoneOnIt(null, { status: "open" })).toBe(false);
    expect(someoneOnIt("conv1", { status: "open" })).toBe(true);
    expect(someoneOnIt(null, { status: "in_progress" })).toBe(true);
    expect(someoneOnIt(null, "in_review")).toBe(true);
    expect(someoneOnIt(null, { status: "open", assignee: "u1" })).toBe(true);
    // A dropped task's assignee is not on it any more.
    expect(someoneOnIt(null, { status: "dropped", assignee: "u1" })).toBe(false);
  });

  test("the Ops home's Nobody on it and the list read the same rule", () => {
    const cases: [string | null, FixTask | null][] = [[null, null], [null, { status: "open" }], ["c", null], [null, { status: "in_progress" }], [null, { status: "done", assignee: "u" }]];
    for (const [sessionId, task] of cases) expect(handled({ sessionId, task: task as any })).toBe(someoneOnIt(sessionId, task));
  });

  test("Nobody on it narrows the list to the issues no one covers, and rides the address", () => {
    const tasks: Record<string, FixTask> = { t1: { status: "open" }, t2: { status: "in_progress" } };
    const ctx: IssueCtx = { taskStatus: (id) => tasks[id] };
    const rows = [g({ _id: "a", short_id: "eg-a" }), g({ _id: "b", short_id: "eg-b", signal_task_id: "t1" }), g({ _id: "c", short_id: "eg-c", signal_task_id: "t2" }), g({ _id: "d", short_id: "eg-d", fix_conversation_id: "conv" })];
    const q = { ...DEFAULT_QUERY, lane: "all" as const, nobody: true };
    expect(filterIssues(rows, q, ctx, NOW).map((r) => r._id).sort()).toEqual(["a", "b"]);
    expect(rows.map((r) => issueOnIt(r, ctx))).toEqual([false, false, true, true]);
    const params = issueQueryParams(q);
    expect(params.show).toBe("nobody:1");
    expect(parseIssueQuery((k) => (params as Record<string, string | null>)[k] ?? null).nobody).toBe(true);
  });
});

describe("a dropped task's press", () => {
  test("says it reopens the task and fixes it in one press", () => {
    expect(fixActionLabel("refile", "ct-57171", false)).toBe("Reopen ct-57171 and fix");
  });
});
