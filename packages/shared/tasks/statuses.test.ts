import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TASK_STATUSES,
  defaultStatusForCategory,
  normalizeTeamTaskStatuses,
  resolveTaskStatus,
  teamTaskStatuses,
} from "./statuses";

const custom = [
  { id: "backlog", name: "Backlog", category: "backlog" as const },
  { id: "open", name: "Todo", category: "open" as const },
  { id: "in_progress", name: "In Progress", category: "in_progress" as const },
  { id: "st_wip", name: "Working on", category: "in_progress" as const, color: "orange" as const },
  { id: "in_review", name: "Verify", category: "in_review" as const },
  { id: "done", name: "Done", category: "done" as const },
  { id: "dropped", name: "Dropped", category: "dropped" as const },
];

describe("teamTaskStatuses", () => {
  test("empty/absent config falls back to the defaults", () => {
    expect(teamTaskStatuses(undefined)).toBe(DEFAULT_TASK_STATUSES);
    expect(teamTaskStatuses([])).toBe(DEFAULT_TASK_STATUSES);
  });
});

describe("normalizeTeamTaskStatuses", () => {
  test("accepts a valid list and trims names", () => {
    const out = normalizeTeamTaskStatuses([
      ...custom.slice(0, 3),
      { id: "st_x", name: "  Polishing  ", category: "in_progress" },
      ...custom.slice(4),
    ]);
    expect(out.find((s) => s.id === "st_x")?.name).toBe("Polishing");
  });

  test("rejects an emptied category", () => {
    expect(() =>
      normalizeTeamTaskStatuses(custom.filter((s) => s.category !== "in_review")),
    ).toThrow(/in_review/);
  });

  test("rejects duplicate ids, duplicate names, unknown categories and colors", () => {
    expect(() => normalizeTeamTaskStatuses([...custom, { id: "st_wip", name: "Again", category: "open" }])).toThrow(/Duplicate status id/);
    expect(() => normalizeTeamTaskStatuses([...custom, { id: "st_2", name: "working ON", category: "open" }])).toThrow(/Duplicate status name/);
    expect(() => normalizeTeamTaskStatuses([{ id: "a", name: "A", category: "nope" }])).toThrow(/Unknown category/);
    expect(() => normalizeTeamTaskStatuses([...custom.slice(0, 6), { id: "x", name: "X", category: "dropped", color: "chartreuse" }])).toThrow(/Unknown color/);
  });

  test("strips unknown fields", () => {
    const out = normalizeTeamTaskStatuses(custom.map((s) => ({ ...s, extra: 1 })));
    expect(Object.keys(out[0]).sort()).toEqual(["category", "id", "name"]);
  });
});

describe("resolveTaskStatus", () => {
  test("resolves a custom status by id", () => {
    const s = resolveTaskStatus({ status: "in_progress", status_id: "st_wip" }, custom);
    expect(s.name).toBe("Working on");
  });

  test("falls back to the category default when status_id is absent or unknown", () => {
    expect(resolveTaskStatus({ status: "in_progress" }, custom).name).toBe("In Progress");
    expect(resolveTaskStatus({ status: "in_progress", status_id: "st_gone" }, custom).name).toBe("In Progress");
  });

  test("a status_id whose category no longer matches never lies about the column", () => {
    // st_wip is in_progress; the task's category moved on to done.
    const s = resolveTaskStatus({ status: "done", status_id: "st_wip" }, custom);
    expect(s.category).toBe("done");
    expect(s.name).toBe("Done");
  });

  test("renamed defaults re-label tasks with no status_id", () => {
    expect(resolveTaskStatus({ status: "open" }, custom).name).toBe("Todo");
    expect(resolveTaskStatus({ status: "in_review" }, custom).name).toBe("Verify");
  });

  test("synthesizes a built-in default when a category was emptied by old data", () => {
    const noReview = custom.filter((s) => s.category !== "in_review");
    const s = defaultStatusForCategory("in_review", noReview);
    expect(s.name).toBe("In Review");
    expect(s.category).toBe("in_review");
  });
});
