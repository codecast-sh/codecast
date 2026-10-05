import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory, performUndo, setUndoNotifier, undoGroup } from "@platform/engine";
import { useInboxStore } from "../inboxStore";

// An undo never overwrites a change someone made after the gesture. Per row
// it is all or nothing: if any field the gesture changed has moved since, the
// whole row is left alone. Across rows a bulk undo is partial: the untouched
// rows go back, and the notice says how many were left.
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

const s = () => useInboxStore.getState() as any;
const task = (id: string, short: string, fields: Record<string, unknown> = {}) => ({
  _id: id, short_id: short, title: "Old title", status: "todo", priority: "medium", updated_at: 1, ...fields,
});
const push = (rows: unknown[]) => s().syncTable("tasks", rows, { isDelta: true });

let calls: Array<[string, unknown[]]> = [];
let notices: string[] = [];
const owner = {};

beforeAll(() => {
  s()._setDispatch(async (action: string, args: unknown[]) => {
    calls.push([action, args]);
    return null;
  }, { owner });
});
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  calls = [];
  notices = [];
  setUndoNotifier({ notify: (m) => notices.push(m) });
});

describe("stale undo guard on the task writer", () => {
  it("a remote change to one field of a two-field edit leaves the row untouched and reports a conflict", () => {
    useInboxStore.setState({ tasks: { [A]: task(A, "ct-1") }, pending: {} } as any);
    s().updateTask("ct-1", { title: "New title", priority: "high" });
    // The server takes the edit; then a teammate changes the priority.
    push([task(A, "ct-1", { title: "New title", priority: "high", updated_at: 2 })]);
    push([task(A, "ct-1", { title: "New title", priority: "low", updated_at: 3 })]);
    expect(s().tasks[A]).toMatchObject({ title: "New title", priority: "low" });

    calls = [];
    performUndo();
    expect(s().tasks[A]).toMatchObject({ title: "New title", priority: "low" });
    expect(calls).toEqual([]);
    expect(notices).toEqual(["Can't undo Edited ct-1: changed since"]);
    expect(getUndoHistory().items[0]!.status).toBe("conflict");
  });

  it("a bulk move with one row changed since undoes the others and says one was left", async () => {
    useInboxStore.setState({
      tasks: { [A]: task(A, "ct-1"), [B]: task(B, "ct-2"), [C]: task(C, "ct-3") },
      pending: {},
    } as any);
    undoGroup("Moved 3 tasks to Done", () => {
      for (const short of ["ct-1", "ct-2", "ct-3"]) s().updateTaskStatus(short, "done");
    });
    expect(getUndoHistory().items).toHaveLength(1);
    push([A, B, C].map((id, i) => task(id, `ct-${i + 1}`, { status: "done", updated_at: 2 })));
    // Someone else moves ct-2 on.
    push([task(B, "ct-2", { status: "in_review", updated_at: 3 })]);

    calls = [];
    performUndo();
    expect([A, B, C].map((id) => s().tasks[id].status)).toEqual(["todo", "in_review", "todo"]);
    // The moves' sends carried the server stamps the capture leaves out, so
    // the undo's writes follow them.
    for (let i = 0; i < 100 && calls.length < 2; i++) await Bun.sleep(2);
    expect(calls.map(([, args]) => (args as any[])[0]).sort()).toEqual(["ct-1", "ct-3"]);
    expect(notices).toEqual(["Undid: Moved 3 tasks to Done (1 changed since, left as they are)"]);
  });
});
