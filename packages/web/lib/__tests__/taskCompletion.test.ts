import { describe, expect, it } from "bun:test";
import { completionWindow, filterTasksByCompletion, pendingTaskCompletionsSig } from "../taskCompletion";
import { isViewDirty, prefsForSaving } from "../savedViews";
import type { PendingEntry } from "../../store/syncProtocol";
import { useInboxStore } from "../../store/inboxStore";
import { closeTaskWithGuard } from "../taskActions";

const NOW = Date.UTC(2026, 8, 4, 16);
const DAY = 86_400_000;
const task = (_id: string, closed_at?: number, status = "done") => ({ _id, status, closed_at });

describe("task completion windows", () => {
  it("accepts supported relative windows and ignores invalid saved or URL values", () => {
    for (const value of ["1d", "7d", "30d"]) expect(completionWindow(value)).toBe(value);
    for (const value of ["", "all", "-1", "365d", "constructor", null, undefined]) {
      expect(completionWindow(value)).toBe("");
    }
  });

  it("keeps the original list when the filter is unset", () => {
    const tasks = [task("open", undefined, "open"), task("old", NOW - 100 * DAY)];
    expect(filterTasksByCompletion(tasks, "", NOW)).toBe(tasks);
    expect(filterTasksByCompletion(tasks, "invalid", NOW)).toBe(tasks);
  });

  it("includes the exact rolling-day boundary and excludes older or future completions", () => {
    const tasks = [task("now", NOW), task("boundary", NOW - DAY), task("older", NOW - DAY - 1), task("future", NOW + 1)];
    expect(filterTasksByCompletion(tasks, "1d", NOW).map((t) => t._id)).toEqual(["now", "boundary"]);
  });

  it("supports rolling week and month windows independently of weekdays", () => {
    const tasks = [task("week", NOW - 7 * DAY), task("month", NOW - 30 * DAY), task("older", NOW - 31 * DAY)];
    expect(filterTasksByCompletion(tasks, "7d", NOW).map((t) => t._id)).toEqual(["week"]);
    expect(filterTasksByCompletion(tasks, "30d", NOW).map((t) => t._id)).toEqual(["week", "month"]);
  });

  it("uses completion time rather than creation or later edits", () => {
    const tasks = [
      { ...task("old", NOW - 14 * DAY), updated_at: NOW },
      { ...task("recent", NOW - 1000), created_at: NOW - 100 * DAY },
      { ...task("unknown"), updated_at: NOW },
    ];
    expect(filterTasksByCompletion(tasks, "1d", NOW).map((t) => t._id)).toEqual(["recent"]);
  });

  it("excludes dropped and reopened tasks even when they carry a recent close timestamp", () => {
    const tasks = [task("done", NOW), task("dropped", NOW, "dropped"), task("reopened", NOW, "open")];
    expect(filterTasksByCompletion(tasks, "1d", NOW).map((t) => t._id)).toEqual(["done"]);
  });

  it("combines with assignee filtering and preserves task identities", () => {
    const recent = { ...task("recent", NOW - 1000), assignee: "ada" };
    const tasks = [recent, { ...task("old", NOW - 2 * DAY), assignee: "ada" }, { ...task("other", NOW), assignee: "ben" }];
    const filtered = filterTasksByCompletion(tasks, "1d", NOW).filter((t) => t.assignee === "ada");
    expect(filtered).toEqual([recent]);
    expect(filtered[0]).toBe(recent);
  });

  it("ages tasks out as the clock advances without a server update", () => {
    const tasks = [task("boundary", NOW - DAY)];
    expect(filterTasksByCompletion(tasks, "1d", NOW)).toHaveLength(1);
    expect(filterTasksByCompletion(tasks, "1d", NOW + 60_000)).toHaveLength(0);
  });

  it("shows optimistic completions and re-completions immediately, then uses the server timestamp", () => {
    const tasks = [task("new"), task("recompleted", NOW - 30 * DAY)];
    const pending: Record<string, PendingEntry> = {
      "tasks:new:status": { type: "field", value: "done", ts: NOW - 1000 },
      "tasks:recompleted:status": { type: "field", value: "done", ts: NOW - 500 },
    };
    expect(filterTasksByCompletion(tasks, "1d", NOW, pending)).toEqual(tasks);
    expect(filterTasksByCompletion([task("new", NOW - 900)], "1d", NOW)).toHaveLength(1);
    expect(filterTasksByCompletion([task("new", NOW - DAY - 1)], "1d", NOW)).toHaveLength(0);
  });

  it("does not treat unrelated pending edits as a completion", () => {
    const tasks = [task("old", NOW - 30 * DAY)];
    const pending: Record<string, PendingEntry> = {
      "tasks:old:title": { type: "field", value: "new title", ts: NOW },
      "tasks:old:status": { type: "field", value: "open", ts: NOW },
    };
    expect(filterTasksByCompletion(tasks, "1d", NOW, pending)).toHaveLength(0);
  });

  it("saves a rolling window with the assignee and detects changed date limits", () => {
    const prefs = prefsForSaving({ view_id: "view-1", status: "done", completed: "1d", assignee: "ada", group: "assignee" });
    expect(prefs).toEqual({ status: "done", completed: "1d", assignee: "ada", group: "assignee" });
    expect(isViewDirty({ prefs }, { ...prefs, completed: "7d" })).toBe(true);
    expect(isViewDirty({ prefs }, { ...prefs })).toBe(false);
  });
});

describe("pending completion reactivity", () => {
  it("includes a parent and its subtasks immediately after the real close action", () => {
    const parentId = "a".repeat(32);
    const childId = "b".repeat(32);
    const initialTasks = useInboxStore.getState().tasks;
    const initialPending = useInboxStore.getState().pending;
    useInboxStore.setState({ tasks: {
      [parentId]: { ...task(parentId, NOW - 100 * DAY, "open"), short_id: "ct-1", title: "Parent" },
      [childId]: { ...task(childId, undefined, "open"), short_id: "ct-2", title: "Child", parent_id: parentId },
    } as any, pending: {} });
    closeTaskWithGuard("ct-1", "done", "cascade");
    const state = useInboxStore.getState();
    const visible = filterTasksByCompletion(Object.values(state.tasks), "1d", Date.now(), state.pending);
    useInboxStore.setState({ tasks: initialTasks, pending: initialPending });
    expect(visible.map((t) => t._id).sort()).toEqual([parentId, childId]);
  });

  it("ignores unrelated edits but wakes for a close and its reconciliation", () => {
    const empty = pendingTaskCompletionsSig({});
    expect(pendingTaskCompletionsSig({ "tasks:a:title": { type: "field", value: "title", ts: NOW } })).toBe(empty);
    const first = pendingTaskCompletionsSig({ "tasks:a:status": { type: "field", value: "done", ts: NOW } });
    expect(first).not.toBe(empty);
    expect(pendingTaskCompletionsSig({ "tasks:b:status": { type: "field", value: "done", ts: NOW } })).not.toBe(first);
    expect(pendingTaskCompletionsSig({})).toBe(empty);
  });
});
