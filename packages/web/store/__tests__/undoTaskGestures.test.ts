import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory, performUndo } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { undoAsOne } from "../undoActions";
import { closeTaskWithGuard } from "../../lib/taskActions";

// One task gesture is one undo. Marking a duplicate links and closes in one
// press, rapid edits of the same field merge, and description saves belong to
// the editor's own undo.
const A = "a".repeat(32);
const B = "b".repeat(32);

const s = () => useInboxStore.getState() as any;
const task = (id: string, short: string, fields: Record<string, unknown> = {}) => ({
  _id: id, short_id: short, title: "Old title", status: "open", priority: "medium", updated_at: 1, ...fields,
});
const labels = () => getUndoHistory().items.map((i) => i.label);
const owner = {};

beforeAll(() => s()._setDispatch(async () => null, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  useInboxStore.setState({ tasks: { [A]: task(A, "ct-1"), [B]: task(B, "ct-2") }, pending: {} } as any);
});

describe("task gestures record one entry each", () => {
  it("marking a duplicate (as the Combine dialog does) is one entry that one undo takes back whole", () => {
    undoAsOne("Marked ct-1 as a duplicate of ct-2", () => {
      s().updateTask("ct-1", { duplicate_of: "ct-2" });
      closeTaskWithGuard("ct-1", "dropped");
    });
    expect(labels()).toEqual(["Marked ct-1 as a duplicate of ct-2"]);
    performUndo();
    expect(s().tasks[A].status).toBe("open");
    expect(s().tasks[A].duplicate_of ?? null).toBe(null);
  });

  it("a lone duplicate_of edit names what changed", () => {
    s().updateTask("ct-1", { duplicate_of: "ct-2" });
    expect(labels()).toEqual(["Marked ct-1 as a duplicate of ct-2"]);
  });

  it("cycling priority quickly is one entry", () => {
    for (const p of ["high", "urgent", "low"]) s().updateTask("ct-1", { priority: p });
    expect(labels()).toEqual(["Set ct-1 to low priority"]);
    performUndo();
    expect(s().tasks[A].priority).toBe("medium");
  });

  it("debounced description saves record nothing: the editor owns text undo", () => {
    for (const d of ["a", "ab", "abc"]) s().updateTask("ct-1", { description: d });
    expect(labels()).toEqual([]);
    expect(s().tasks[A].description).toBe("abc");
  });
});
