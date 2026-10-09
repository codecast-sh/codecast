import { describe, expect, test } from "bun:test";
import { blockersHoldingBack, type TaskWait } from "@codecast/shared/tasks";
import { blockedMark, blockerStatusSig, isReadyInStore, readySig, storeBlockedMark, storeStatusOf, type BoardTask } from "../taskBlockers";

/** What holds `task` back, read from the store as the board reads it. */
const openBlockers = (task: BoardTask, tasks: Record<string, any> | undefined) => blockersHoldingBack(task, storeStatusOf(tasks, task));

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

  test("a live row in another workspace is no answer: the ref stays unknown, as on the server", () => {
    const home = { a: row("a", "ct-1", "done", { workspace: "team:t1" }), x: row("x", "ct-9", "done", { workspace: "team:t2" }) };
    const task = { status: "open", workspace: "team:t1", blocked_by: ["ct-1", "ct-9"] };
    expect(openBlockers(task, home)).toEqual([{ kind: "task", ref: "ct-9", status: "unknown" }]);
    expect(isReadyInStore(task, home, "u1")).toBe(false);
  });

  test("an empty store reads every blocker as unknown, which blocks", () => {
    expect(openBlockers({ status: "open", blocked_by: ["ct-1"] }, undefined)).toEqual([{ kind: "task", ref: "ct-1", status: "unknown" }]);
  });
});

describe("isReadyInStore", () => {
  const viewer = "u1";
  test("open with every blocker closed is unblocked", () => {
    expect(isReadyInStore({ status: "open", blocked_by: ["ct-2", "ct-4"] }, store, viewer)).toBe(true);
  });
  test("an open blocker, one the store lacks, or a waiting wait keeps it out", () => {
    expect(isReadyInStore({ status: "open", blocked_by: ["ct-1"] }, store, viewer)).toBe(false);
    expect(isReadyInStore({ status: "open", blocked_by: ["ct-77"] }, store, viewer)).toBe(false);
    expect(isReadyInStore({ status: "open", blocked_by: ["ct-77"], graph_status: [{ ref: "ct-77", status: "done" }] }, store, viewer)).toBe(true);
    expect(isReadyInStore({ status: "open", waits: [wait("waiting")] }, store, viewer)).toBe(false);
  });
  test("only open, active work counts", () => {
    expect(isReadyInStore({ status: "in_progress" }, store, viewer)).toBe(false);
    expect(isReadyInStore({ status: "open", triage_status: "suggested" }, store, viewer)).toBe(false);
    expect(isReadyInStore({ status: "open", superseded_by: "ct-1" }, store, viewer)).toBe(false);
  });
  test("a subtask waits while its parent is worked or unknown; an orphan is free", () => {
    expect(isReadyInStore({ status: "open", parent_id: "c" }, store, viewer)).toBe(false);
    expect(isReadyInStore({ status: "open", parent_id: "a" }, store, viewer)).toBe(true);
    expect(isReadyInStore({ status: "open", parent_id: "gone", graph_status: [{ ref: "gone", status: null }] }, store, viewer)).toBe(true);
    expect(isReadyInStore({ status: "open", parent_id: "far" }, store, viewer)).toBe(false);
    expect(isReadyInStore({ status: "open", parent_id: "far", graph_status: [{ ref: "far", short_id: "ct-80", status: "in_review" }] }, store, viewer)).toBe(false);
    expect(isReadyInStore({ status: "open", parent_id: "far", graph_status: [{ ref: "far", short_id: "ct-80", status: "open" }] }, store, viewer)).toBe(true);
  });
  test("someone else's ephemeral task is not on the viewer's frontier", () => {
    expect(isReadyInStore({ status: "open", ephemeral: true, user_id: "u2" }, store, viewer)).toBe(false);
    expect(isReadyInStore({ status: "open", ephemeral: true, user_id: "u1" }, store, viewer)).toBe(true);
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
  test("each task blocker is its own phrase, titled when the store holds it", () => {
    const titled = { ...store, a: row("a", "ct-1", "open", { title: "Shared graph core" }) };
    expect(storeBlockedMark({ status: "open", blocked_by: ["ct-1", "ct-3"] }, titled)?.tip).toBe("Waiting on ct-1 Shared graph core · Waiting on ct-3");
  });
  test("a done blocker the store lacks draws nothing when the row's snapshot says so (plan lists, TG1)", () => {
    const task = { status: "open", blocked_by: ["ct-50"], graph_status: [{ ref: "ct-50", short_id: "ct-50", status: "done" }] };
    expect(storeBlockedMark(task, store)).toBeNull();
    expect(storeBlockedMark({ ...task, graph_status: [] }, store)?.tip).toBe("Waiting on ct-50 (status unknown)");
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
  test("a blocker's rename changes it, so the tooltip's title follows", () => {
    const task = { status: "open", blocked_by: ["ct-1"] };
    const titled = { ...store, a: row("a", "ct-1", "open", { title: "Old" }) };
    expect(blockerStatusSig(task, titled)).toBe("open|Old");
    expect(blockerStatusSig(task, { ...titled, a: { ...titled.a, title: "New" } })).toBe("open|New");
  });
});

describe("readySig", () => {
  const rows: BoardTask[] = [
    { _id: "r1", status: "open", blocked_by: ["ct-1"] },
    { _id: "r2", status: "open", parent_id: "c" },
    { _id: "r3", status: "done", blocked_by: ["ct-4"] },
    { _id: "r4", status: "open" },
  ] as BoardTask[];
  test("a blocker's or a parent's status change moves it", () => {
    const before = readySig(rows, store);
    expect(readySig(rows, { ...store, a: { ...store.a, status: "done" } })).not.toBe(before);
    expect(readySig(rows, { ...store, c: { ...store.c, status: "open" } })).not.toBe(before);
  });
  test("a write to a task no open row names leaves it equal", () => {
    const before = readySig(rows, store);
    expect(readySig(rows, { ...store, b: { ...store.b, status: "open" } })).toBe(before);
    // ct-4 is named only by a closed row, which no blocker holds.
    expect(readySig(rows, { ...store, d: { ...store.d, status: "open" } })).toBe(before);
    expect(readySig(rows, { ...store, z: row("z", "ct-9", "open") })).toBe(before);
  });
  test("every ref isReadyInStore reads is in it: the board's verdict never changes while it holds", () => {
    const variants = [store, { ...store, a: { ...store.a, status: "done" } }, { ...store, c: { ...store.c, status: "open" } }];
    for (const v of variants) {
      const same = variants.filter((w) => readySig(rows, w) === readySig(rows, v));
      for (const w of same) for (const r of rows) expect(isReadyInStore(r, w, "u1")).toBe(isReadyInStore(r, v, "u1"));
    }
  });
});

describe("mergeLiveTasks and the task graph", () => {
  test("a plan snapshot shows the store's blockers and waits, and keeps its row when they match", async () => {
    const { mergeLiveTasks } = await import("../liveEntities");
    const snap = { _id: "a", short_id: "ct-1", status: "open", blocked_by: ["ct-2"], waits: [] as TaskWait[] };
    expect(mergeLiveTasks([snap], { a: { ...snap, blocked_by: ["ct-2"], waits: [] } })[0]).toBe(snap);
    const merged = mergeLiveTasks([snap], { a: { ...snap, blocked_by: ["ct-2", "ct-3"], waits: [wait("waiting")] } })[0];
    expect(merged.blocked_by).toEqual(["ct-2", "ct-3"]);
    expect(merged.waits.map((w: TaskWait) => w.state)).toEqual(["waiting"]);
  });
});
