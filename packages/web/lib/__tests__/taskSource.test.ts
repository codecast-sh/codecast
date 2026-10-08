// The project sheet, the project's line and the project's board count the
// same work: projectTaskCounts (sheet and line) and the board's default
// Source (tasksForSource "") run over one fixture and agree row for row.
// Run: bun test lib/__tests__/taskSource.test.ts
import { describe, expect, it } from "bun:test";
import { projectTaskCounts } from "@codecast/shared/tasks";
import { tasksForSource } from "../taskSource";

const P = "proj-1";
const t = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ _id: id, project_id: P, status, source: "human", ...extra });
const FIXTURE = [
  t("1", "done"), t("2", "done"), t("3", "in_progress"), t("4", "in_review"), t("5", "open"), t("6", "backlog"),
  t("7", "dropped"),
  t("8", "open", { source: "agent" }), t("9", "done", { source: "agent" }), // agent bookkeeping
  t("10", "open", { source: "agent", assignee: "role-1" }),               // handed to a role: on the board
  t("11", "open", { source: "agent", promoted: true }),                    // promoted: on the board
  t("12", "done", { source: "insight" }),                                  // a mined suggestion
  t("13", "open", { triage_status: "dismissed" }),
];

describe("one rule for a project's work", () => {
  it("the sheet's counts are the board's default rows, Dropped aside", () => {
    const board = tasksForSource(FIXTURE, "");
    const counted = projectTaskCounts(FIXTURE, [P]);
    const live = board.filter((r) => r.status !== "dropped");
    expect(counted.total).toBe(live.length);
    expect(counted.done).toBe(board.filter((r) => r.status === "done").length);
    expect(counted.in_progress).toBe(board.filter((r) => r.status === "in_progress" || r.status === "in_review").length);
    expect(live.map((r) => r._id).sort()).toEqual(["1", "10", "11", "2", "3", "4", "5", "6"]);
  });

  it("agent rows sit behind their own Source, outside the counts", () => {
    expect(tasksForSource(FIXTURE, "agent").map((r) => r._id)).toEqual(["8", "9"]);
    expect(tasksForSource(FIXTURE, "human").map((r) => r._id)).toEqual(tasksForSource(FIXTURE, "").map((r) => r._id));
  });
});
