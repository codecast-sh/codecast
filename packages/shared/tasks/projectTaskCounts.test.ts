// A project's progress as the board shows it (initiatives-projects-role-page.md I1).
// Run: bun test packages/shared/tasks/projectTaskCounts.test.ts
import { expect, test } from "bun:test";
import { isOnProjectBoard, projectTaskCounts } from "./index";

const t = (project_id: string | null, status: string, extra: Record<string, unknown> = {}) => ({ project_id, status, source: "human", ...extra });

test("counts the rows the project's board lists, and nothing else", () => {
  const tasks = [
    t("p1", "done"), t("p1", "open"), t("p1", "in_progress"), t("p1", "in_review"),
    t("p1", "dropped"),                                   // hidden by default on the board
    t("p1", "done", { source: "agent" }),                 // agent bookkeeping, not on the human's board
    t("p1", "done", { source: "agent", assignee: "u1" }), // handed to a person: on the board
    t("p1", "open", { source: "agent", promoted: true }), // promoted: on the board
    t("p1", "done", { source: "insight" }),               // a mined suggestion, not real work
    t("p1", "done", { triage_status: "dismissed" }),
    t(null, "done", { plan_id: "plan-of-p1" }),            // a plan's task naming no project is not on the project's board
    t("p2", "done"), t("p9", "done"),
  ];
  expect(projectTaskCounts(tasks, ["p1", "p2"])).toEqual({ total: 7, done: 3, in_progress: 2, open: 2 });
  expect(projectTaskCounts(tasks, [])).toEqual({ total: 0, done: 0, in_progress: 0, open: 0 });
});

test("ids compare as strings, so a Convex id and its string form agree", () => {
  const id = { toString: () => "p1" };
  expect(projectTaskCounts([t("p1", "done")], [id]).done).toBe(1);
});

test("isOnProjectBoard is the board's own rule", () => {
  expect(isOnProjectBoard({ status: "open", source: "human" })).toBe(true);
  expect(isOnProjectBoard({ status: "dropped", source: "human" })).toBe(false);
  expect(isOnProjectBoard({ status: "open", source: "agent" })).toBe(false);
  expect(isOnProjectBoard({ status: "open", source: "agent", assignee: "role-1" })).toBe(true);
});
