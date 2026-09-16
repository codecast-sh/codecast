import { describe, expect, test } from "bun:test";
import { DEFAULT_TASK_STATUSES } from "@codecast/shared/tasks";
import { evidenceCount, lineColumns, lineOptions } from "../lineBoard";

// The Line tab's own rules (docs/architecture/the-line.md L3, L10), tested
// without React: stations are the team's statuses in order, a task sits in
// the column of its status, and the card's evidence count. The hold, the
// task's run and its live node are lib/taskLine.ts rules, covered by
// lib/__tests__/taskLine.test.ts.

const t = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ _id: id, status, updated_at: 1, ...extra });

describe("lineColumns", () => {
  test("one column per status in pipeline order, tasks in the column of their status", () => {
    const cols = lineColumns([t("a", "in_review"), t("b", "open"), t("c", "open", { updated_at: 5 })], DEFAULT_TASK_STATUSES);
    expect(cols.map((c) => c.status.id)).toEqual(["backlog", "open", "in_progress", "in_review", "done", "dropped"]);
    expect(cols.find((c) => c.status.id === "open")!.tasks.map((x) => x._id)).toEqual(["c", "b"]);
    expect(cols.find((c) => c.status.id === "in_review")!.tasks.map((x) => x._id)).toEqual(["a"]);
    expect(cols.find((c) => c.status.id === "done")!.tasks).toEqual([]);
  });

  test("a custom status id lands in its own column; a stray status_id falls back to the category", () => {
    const statuses = [...DEFAULT_TASK_STATUSES, { id: "qa", name: "QA", category: "in_review" as const }];
    const cols = lineColumns([t("a", "in_review", { status_id: "qa" }), t("b", "in_review", { status_id: "gone" })], statuses);
    expect(cols.find((c) => c.status.id === "qa")!.tasks.map((x) => x._id)).toEqual(["a"]);
    expect(cols.find((c) => c.status.id === "in_review")!.tasks.map((x) => x._id)).toEqual(["b"]);
  });
});

describe("evidenceCount", () => {
  test("counts the task's pages in the store and its handoff files", () => {
    const task = t("a", "in_review", { files_changed: ["x.ts", "y.ts"] });
    expect(evidenceCount(task, [{ task_id: "a" }, { task_id: "a" }, { task_id: "b" }, {}])).toEqual({ pages: 2, files: 2 });
    expect(evidenceCount(t("q", "open"), [])).toEqual({ pages: 0, files: 0 });
  });
});

describe("lineOptions", () => {
  test("shipped templates first, own workflows after, an own row with a shipped slug wins", () => {
    const rows = lineOptions([{ slug: "feature", name: "Feature (ours)" }, { slug: "release", name: "Release train" }, { slug: "release" }], "line");
    expect(rows.map((r) => r.slug)).toEqual(["line", "feature", "plan-autopilot", "release"]);
    expect(rows[0]).toEqual({ slug: "line", label: "line (shipped)", shipped: true });
    expect(rows[1]).toEqual({ slug: "feature", label: "Feature (ours) (yours)", shipped: false });
    expect(rows[3].label).toBe("Release train (release)");
  });
  test("a current slug nothing lists stays selectable", () => {
    const rows = lineOptions([], "custom-line");
    expect(rows.at(-1)).toEqual({ slug: "custom-line", label: "custom-line (not pushed)", shipped: false });
  });
});
