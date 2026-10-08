import { describe, expect, test } from "bun:test";
import type { TaskWait } from "@codecast/shared/tasks";
import { blockedMark, isUnblockedInStore, openBlockers } from "../taskBlockers";

const row = (id: string, short_id: string, status: string, extra: Record<string, unknown> = {}) => ({ _id: id, short_id, status, ...extra });
const store = {
  a: row("a", "ct-1", "open"),
  b: row("b", "ct-2", "done"),
  c: row("c", "ct-3", "in_progress"),
  d: row("d", "ct-4", "dropped"),
};
const wait = (state: TaskWait["state"], extra: Partial<TaskWait> = {}): TaskWait =>
  ({ id: `w-${state}`, kind: "pr_merged", repository: "o/r", pr_number: 42, state, created_at: 0, ...extra }) as TaskWait;

describe("openBlockers", () => {
  test("an open blocker holds the task, a closed or unknown one does not", () => {
    const task = { status: "open", blocked_by: ["ct-1", "ct-2", "ct-4", "ct-99"] };
    expect(openBlockers(task, store)).toEqual([{ kind: "task", ref: "ct-1", status: "open" }]);
  });

  test("a blocker named by _id resolves and is listed by its short id", () => {
    expect(openBlockers({ status: "open", blocked_by: ["c"] }, store)).toEqual([{ kind: "task", ref: "ct-3", status: "in_progress" }]);
  });

  test("waiting and failed waits hold the task, a met one does not", () => {
    const waits = [wait("waiting"), wait("met"), wait("failed")];
    expect(openBlockers({ status: "open", waits }, store).map((b) => (b as TaskWait).state)).toEqual(["waiting", "failed"]);
  });

  test("an empty store blocks nothing", () => {
    expect(openBlockers({ status: "open", blocked_by: ["ct-1"] }, undefined)).toEqual([]);
  });
});

describe("isUnblockedInStore", () => {
  const viewer = "u1";
  test("open with every blocker closed is unblocked", () => {
    expect(isUnblockedInStore({ status: "open", blocked_by: ["ct-2", "ct-4"] }, store, viewer)).toBe(true);
  });
  test("an open blocker or a waiting wait keeps it out", () => {
    expect(isUnblockedInStore({ status: "open", blocked_by: ["ct-1"] }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", waits: [wait("waiting")] }, store, viewer)).toBe(false);
  });
  test("only open, active work counts", () => {
    expect(isUnblockedInStore({ status: "in_progress" }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", triage_status: "suggested" }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", superseded_by: "ct-1" }, store, viewer)).toBe(false);
  });
  test("a subtask waits while its parent is worked; an orphan is free", () => {
    expect(isUnblockedInStore({ status: "open", parent_id: "c" }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", parent_id: "a" }, store, viewer)).toBe(true);
    expect(isUnblockedInStore({ status: "open", parent_id: "gone" }, store, viewer)).toBe(true);
  });
  test("someone else's ephemeral task is not on the viewer's frontier", () => {
    expect(isUnblockedInStore({ status: "open", ephemeral: true, user_id: "u2" }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", ephemeral: true, user_id: "u1" }, store, viewer)).toBe(true);
  });
});

describe("blockedMark", () => {
  test("nothing holding the task draws nothing", () => {
    expect(blockedMark([])).toBeNull();
  });
  test("names each blocker in the tooltip and counts them", () => {
    const mark = blockedMark(openBlockers({ status: "open", blocked_by: ["ct-1"], waits: [wait("waiting")] }, store));
    expect(mark).toEqual({ count: 2, failed: false, tip: "Blocked by ct-1, PR #42 merges" });
  });
  test("a failed wait is flagged and says why", () => {
    const mark = blockedMark([wait("failed", { note: "closed without merging" })]);
    expect(mark).toEqual({ count: 1, failed: true, tip: "Blocked by PR #42 merges (failed: closed without merging)" });
  });
});
