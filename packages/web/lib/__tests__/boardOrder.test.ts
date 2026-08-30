// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { boardOrderedStatuses } from "../taskStatuses";
import { DEFAULT_TASK_STATUSES, type TeamTaskStatus } from "@codecast/shared/tasks";

// A team list with custom statuses sprinkled through, deliberately shuffled so
// nothing passes by accident of input order.
const CUSTOM: TeamTaskStatus[] = [
  { id: "qa", name: "QA", category: "in_review" },
  { id: "done", name: "Done", category: "done" },
  { id: "triage", name: "Triage", category: "backlog" },
  { id: "open", name: "Open", category: "open" },
  { id: "blocked", name: "Blocked", category: "in_progress" },
  { id: "backlog", name: "Backlog", category: "backlog" },
  { id: "in_progress", name: "In Progress", category: "in_progress" },
  { id: "dropped", name: "Dropped", category: "dropped" },
];

describe("boardOrderedStatuses", () => {
  it("orders the board as a pipeline: backlog, open, started, finished", () => {
    expect(boardOrderedStatuses(DEFAULT_TASK_STATUSES).map((s) => s.id)).toEqual([
      "backlog", "open", "in_progress", "in_review", "done", "dropped",
    ]);
  });

  it("keeps custom statuses inside their category's section, in team order", () => {
    expect(boardOrderedStatuses(CUSTOM).map((s) => s.id)).toEqual([
      "triage", "backlog", "open", "blocked", "in_progress", "qa", "done", "dropped",
    ]);
  });

  it("applies a saved column order on top", () => {
    const order = ["open", "backlog", "in_progress", "in_review", "done", "dropped"];
    expect(boardOrderedStatuses(DEFAULT_TASK_STATUSES, order).map((s) => s.id)).toEqual(order);
  });

  it("slots a status the saved order predates into its category's section", () => {
    // Saved before the team added Blocked/QA/Triage: each new column lands at
    // the end of its own category run, not at the board's edge.
    const saved = ["open", "backlog", "in_progress", "done", "dropped"];
    expect(boardOrderedStatuses(CUSTOM, saved).map((s) => s.id)).toEqual([
      "open", "backlog", "triage", "in_progress", "blocked", "qa", "done", "dropped",
    ]);
  });

  it("drops saved ids that no longer name a status; unsaved columns take pipeline slots", () => {
    expect(
      boardOrderedStatuses(DEFAULT_TASK_STATUSES, ["gone", "done", "open"]).map((s) => s.id),
    ).toEqual(["backlog", "in_progress", "in_review", "done", "open", "dropped"]);
  });
});
