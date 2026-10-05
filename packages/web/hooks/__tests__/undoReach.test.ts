// A window records undo history only while something mounted there can reach
// it (hooks/useUndoUnreachable): the app's boot turns the gate on, and each
// mounted reach (useUndoWalk) opens it for as long as it is mounted.
import { afterEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory, pushUndo } from "@platform/engine";

/** Whether a manual entry pushed now lands in the history. */
function records(): boolean {
  const before = getUndoHistory().undoOrder.length;
  pushUndo({ label: "x", undo: () => {}, redo: () => {} });
  return getUndoHistory().undoOrder.length > before;
}
const isUndoSuppressed = () => !records();
import { _resetUndoReachGate, holdUndoReach, recordUndoOnlyWhereReachable } from "../useUndoUnreachable";

afterEach(() => { _resetUndoReachGate(); _resetUndoStacks(); });

describe("the undo reach gate", () => {
  it("records nothing once armed until a reach mounts, and stops when the last one goes", () => {
    expect(isUndoSuppressed()).toBe(false);
    recordUndoOnlyWhereReachable();
    expect(isUndoSuppressed()).toBe(true);
    const a = holdUndoReach();
    const b = holdUndoReach();
    expect(isUndoSuppressed()).toBe(false);
    a();
    a();
    expect(isUndoSuppressed()).toBe(false);
    b();
    expect(isUndoSuppressed()).toBe(true);
  });

  it("a reach mounted before the gate is armed keeps recording on", () => {
    const a = holdUndoReach();
    recordUndoOnlyWhereReachable();
    expect(isUndoSuppressed()).toBe(false);
    a();
    expect(isUndoSuppressed()).toBe(true);
  });

  it("unarmed (tests, other hosts), a reach changes nothing", () => {
    const a = holdUndoReach();
    a();
    expect(isUndoSuppressed()).toBe(false);
  });
});
