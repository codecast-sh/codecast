import { describe, expect, test } from "bun:test";
import type { TaskWait } from "@codecast/shared/tasks";
import { blockedMark, blockerStatusSig, isUnblockedInStore, openBlockers } from "../taskBlockers";

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
  test("an open blocker holds the task, a closed or looked-up-and-gone one does not", () => {
    const task = { status: "open", blocked_by: ["ct-1", "ct-2", "ct-4", "ct-99"], graph_status: [{ ref: "ct-99", status: null }] };
    expect(openBlockers(task, store)).toEqual([{ kind: "task", ref: "ct-1", status: "open" }]);
  });

  test("a blocker the store lacks is read from the row's snapshot, else stays unknown and holds", () => {
    const task = {
      status: "open",
      blocked_by: ["ct-50", "ct-51", "ct-52"],
      graph_status: [{ ref: "ct-50", short_id: "ct-50", status: "done" }, { ref: "ct-51", short_id: "ct-51", status: "open" }],
    };
    expect(openBlockers(task, store)).toEqual([
      { kind: "task", ref: "ct-51", status: "open" },
      { kind: "task", ref: "ct-52", status: "unknown" },
    ]);
  });

  test("the store's live row wins over the snapshot", () => {
    const task = { status: "open", blocked_by: ["ct-2"], graph_status: [{ ref: "ct-2", short_id: "ct-2", status: "open" }] };
    expect(openBlockers(task, store)).toEqual([]);
  });

  test("a blocker named by _id resolves and is listed by its short id", () => {
    expect(openBlockers({ status: "open", blocked_by: ["c"] }, store)).toEqual([{ kind: "task", ref: "ct-3", status: "in_progress" }]);
  });

  test("waiting and failed waits hold the task, a met one does not", () => {
    const waits = [wait("waiting"), wait("met"), wait("failed")];
    expect(openBlockers({ status: "open", waits }, store).map((b) => (b as TaskWait).state)).toEqual(["waiting", "failed"]);
  });

  test("an empty store reads every blocker as unknown, which blocks", () => {
    expect(openBlockers({ status: "open", blocked_by: ["ct-1"] }, undefined)).toEqual([{ kind: "task", ref: "ct-1", status: "unknown" }]);
  });
});

describe("isUnblockedInStore", () => {
  const viewer = "u1";
  test("open with every blocker closed is unblocked", () => {
    expect(isUnblockedInStore({ status: "open", blocked_by: ["ct-2", "ct-4"] }, store, viewer)).toBe(true);
  });
  test("an open blocker, one the store lacks, or a waiting wait keeps it out", () => {
    expect(isUnblockedInStore({ status: "open", blocked_by: ["ct-1"] }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", blocked_by: ["ct-77"] }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", blocked_by: ["ct-77"], graph_status: [{ ref: "ct-77", status: "done" }] }, store, viewer)).toBe(true);
    expect(isUnblockedInStore({ status: "open", waits: [wait("waiting")] }, store, viewer)).toBe(false);
  });
  test("only open, active work counts", () => {
    expect(isUnblockedInStore({ status: "in_progress" }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", triage_status: "suggested" }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", superseded_by: "ct-1" }, store, viewer)).toBe(false);
  });
  test("a subtask waits while its parent is worked or unknown; an orphan is free", () => {
    expect(isUnblockedInStore({ status: "open", parent_id: "c" }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", parent_id: "a" }, store, viewer)).toBe(true);
    expect(isUnblockedInStore({ status: "open", parent_id: "gone", graph_status: [{ ref: "gone", status: null }] }, store, viewer)).toBe(true);
    expect(isUnblockedInStore({ status: "open", parent_id: "far" }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", parent_id: "far", graph_status: [{ ref: "far", short_id: "ct-80", status: "in_review" }] }, store, viewer)).toBe(false);
    expect(isUnblockedInStore({ status: "open", parent_id: "far", graph_status: [{ ref: "far", short_id: "ct-80", status: "open" }] }, store, viewer)).toBe(true);
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
    expect(mark).toEqual({ count: 2, failed: false, tip: "Waiting on ct-1 · Waiting on PR #42" });
  });
  test("a failed wait is flagged and says why", () => {
    const mark = blockedMark([wait("failed", { note: "closed without merging" })]);
    expect(mark).toEqual({ count: 1, failed: true, tip: "Waiting on PR #42 (failed: closed without merging)" });
  });
});

describe("blockerStatusSig", () => {
  test("names what the store says of each task blocker, and nothing for a closed task", () => {
    const task = { status: "open", blocked_by: ["ct-1", "ct-2", "ct-60", "ct-61"], graph_status: [{ ref: "ct-60", status: null }] };
    expect(blockerStatusSig(task, store)).toBe("open,done,-,?");
    expect(blockerStatusSig({ ...task, status: "done" }, store)).toBe("");
    expect(blockerStatusSig({ status: "open" }, store)).toBe("");
  });
});
