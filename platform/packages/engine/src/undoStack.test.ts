import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _resetUndoStacks,
  canRedo,
  canUndo,
  configureUndoStack,
  DEFAULT_UNDO_KEYBOARD_WINDOW_MS,
  getUndoHistory,
  newUndoEntryId,
  performRedo,
  performUndo,
  pushUndo,
  recordUndoEntry,
  redoTo,
  setUndoNotifier,
  showUndoToast,
  undoRowCount,
  subscribeUndoHistory,
  undoEntry,
  undoTo,
  suspendUndoRecording,
  isUndoSuppressed,
} from "./undoStack";
import type { UndoEntry, UndoOutcome } from "./types";

// The stack and history mechanics, independent of the middleware: entries are
// closures over a plain value, so each step's effect is visible directly.

let value: string[] = [];
let notices: string[] = [];
let steps: Array<[string, number, string]> = [];

// A generic entry over `value`: undo pops what redo pushed. `conflict` makes
// its undo report a conflict instead.
function generic(label: string, opts: { conflict?: () => boolean } = {}): UndoEntry {
  value.push(label);
  const entry: UndoEntry = {
    id: newUndoEntryId(),
    label,
    ts: Date.now(),
    status: "done",
    mode: "generic",
    undo: (): UndoOutcome => {
      if (opts.conflict?.()) return { ok: false, reason: "conflict" };
      value = value.filter((v) => v !== label);
      return { ok: true, applied: 1, skipped: 0 };
    },
    redo: (): UndoOutcome => {
      value.push(label);
      return { ok: true, applied: 1, skipped: 0 };
    },
  };
  recordUndoEntry(entry);
  return entry;
}

beforeEach(() => {
  _resetUndoStacks();
  configureUndoStack({ keyboardWindowMs: DEFAULT_UNDO_KEYBOARD_WINDOW_MS, stackLimit: 100, historyLimit: 200 });
  value = [];
  notices = [];
  steps = [];
  setUndoNotifier({
    notify: (m) => notices.push(m),
    onHistoryStep: (kind, n, entry) => steps.push([kind, n, entry.label]),
  });
});

afterEach(() => {
  configureUndoStack({ keyboardWindowMs: DEFAULT_UNDO_KEYBOARD_WINDOW_MS });
});

describe("history snapshot", () => {
  it("is the same reference until something changes", () => {
    const a = getUndoHistory();
    expect(getUndoHistory()).toBe(a);
    generic("one");
    const b = getUndoHistory();
    expect(b).not.toBe(a);
    expect(getUndoHistory()).toBe(b);
    expect(b.version).toBeGreaterThan(a.version);
    expect(b.items.map((i) => i.label)).toEqual(["one"]);
    expect(b.head).toBe(b.items[0]!.id);
    expect("undo" in b.items[0]!).toBe(false);
  });

  it("notifies subscribers on every change", () => {
    let calls = 0;
    const off = subscribeUndoHistory(() => { calls++; });
    generic("one");
    performUndo();
    off();
    generic("two");
    expect(calls).toBe(2);
  });

  it("lists newest first and keeps the ring bounded", () => {
    configureUndoStack({ historyLimit: 3, stackLimit: 2 });
    for (const l of ["a", "b", "c", "d"]) generic(l);
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["d", "c", "b"]);
    expect(performUndo()).toBe(true);
    expect(performUndo()).toBe(true);
    expect(performUndo()).toBe(false);
  });
});

describe("stack order in the snapshot", () => {
  it("follows the stacks, not history order, after an out-of-turn undo and a redo", () => {
    const a = generic("a");
    const b = generic("b");
    const c = generic("c");
    expect(getUndoHistory().undoOrder).toEqual([c.id, b.id, a.id]);
    expect(undoEntry(a.id)).toBe(true);
    expect(getUndoHistory().redoOrder).toEqual([a.id]);
    expect(performRedo()).toBe(true);
    const snap = getUndoHistory();
    expect(snap.items.map((i) => i.label)).toEqual(["c", "b", "a"]);
    expect(snap.undoOrder).toEqual([a.id, c.id, b.id]);
    expect(snap.redoOrder).toEqual([]);
    expect(snap.head).toBe(a.id);
  });

  it("omits done entries trimmed past the stack limit", () => {
    configureUndoStack({ stackLimit: 2 });
    for (const l of ["a", "b", "c"]) generic(l);
    const snap = getUndoHistory();
    expect(snap.items).toHaveLength(3);
    expect(snap.undoOrder.map((id) => snap.items.find((i) => i.id === id)!.label)).toEqual(["c", "b"]);
  });
});

describe("undoTo and redoTo", () => {
  it("walk several steps with one notification each way", () => {
    const a = generic("a");
    generic("b");
    generic("c");
    expect(undoTo(a.id)).toBe(3);
    expect(value).toEqual([]);
    expect(steps).toEqual([["undo", 3, "a"]]);
    expect(getUndoHistory().head).toBeNull();

    const items = getUndoHistory().items;
    const b = items.find((i) => i.label === "b")!;
    expect(redoTo(b.id)).toBe(2);
    expect(value).toEqual(["a", "b"]);
    expect(steps.at(-1)).toEqual(["redo", 2, "b"]);
    expect(getUndoHistory().head).toBe(b.id);
  });

  it("stop at the first conflict and say so", () => {
    const a = generic("a");
    generic("b", { conflict: () => true });
    generic("c");
    expect(undoTo(a.id)).toBe(1);
    expect(value).toEqual(["a", "b"]);
    expect(steps).toEqual([["undo", 1, "c"]]);
    expect(notices).toEqual(["Can't undo b: changed since"]);
    // The conflicted entry is off the stack; the next walk reaches "a".
    expect(undoTo(a.id)).toBe(1);
    expect(value).toEqual(["b"]);
  });

  it("an unknown id does nothing", () => {
    generic("a");
    expect(undoTo("nope")).toBe(0);
    expect(redoTo("nope")).toBe(0);
    expect(value).toEqual(["a"]);
  });
});

describe("dropped redo branch", () => {
  it("a push marks the undone entries dropped by it; they stay visible and inert", () => {
    generic("a");
    const b = generic("b");
    performUndo();
    const c = generic("c");
    const dropped = getUndoHistory().items.find((i) => i.id === b.id)!;
    expect(dropped.status).toBe("dropped");
    expect(dropped.droppedBy).toBe(c.id);
    expect(canRedo()).toBe(false);
    expect(redoTo(b.id)).toBe(0);
    expect(performRedo()).toBe(false);
  });
});

describe("keyboard window", () => {
  it("blind undo and redo reach only recent entries; the timeline reaches older generic ones", () => {
    configureUndoStack({ keyboardWindowMs: 50 });
    const old = generic("old");
    old.ts = Date.now() - 1000;
    expect(canUndo()).toBe(false);
    expect(performUndo()).toBe(false);
    expect(value).toEqual(["old"]);
    expect(undoTo(old.id)).toBe(1);
    expect(value).toEqual([]);
  });

  it("a redone entry is reachable by the next blind undo, however old its record", () => {
    const realNow = Date.now;
    const t0 = realNow();
    try {
      const entry = generic("old");
      Date.now = () => t0 + 4 * 60_000;
      expect(performUndo()).toBe(true);
      Date.now = () => t0 + 6 * 60_000;
      expect(performRedo()).toBe(true);
      expect(value).toEqual(["old"]);
      expect(canUndo()).toBe(true);
      expect(performUndo()).toBe(true);
      expect(value).toEqual([]);
      // The history still shows when the change was first made.
      expect(getUndoHistory().items.find((i) => i.id === entry.id)!.ts).toBe(t0);
    } finally {
      Date.now = realNow;
    }
  });

  it("an expired manual entry is gone everywhere", () => {
    configureUndoStack({ keyboardWindowMs: 50 });
    let undone = false;
    const id = pushUndo({ label: "manual", undo: () => { undone = true; }, redo: () => {} });
    const entry = getUndoHistory().items.find((i) => i.id === id)!;
    expect(entry.mode).toBe("manual");
    expect(getUndoHistory().head).toBe(id);
    // Move the clock past the window.
    const realNow = Date.now;
    Date.now = () => realNow() + 1000;
    try {
      expect(performUndo()).toBe(false);
      expect(undoTo(id)).toBe(0);
      expect(undone).toBe(false);
      expect(getUndoHistory().head).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("undoEntry", () => {
  it("undoes its own entry even when it is not on top", () => {
    const a = generic("a");
    generic("b");
    expect(undoEntry(a.id)).toBe(true);
    expect(value).toEqual(["b"]);
    expect(steps).toEqual([["undo", 1, "a"]]);
    // The top is untouched and still undoes next.
    performUndo();
    expect(value).toEqual([]);
  });

  it("refuses a manual entry below the top", () => {
    let undone = false;
    const id = pushUndo({ label: "manual", undo: () => { undone = true; }, redo: () => {} });
    generic("b");
    expect(undoEntry(id)).toBe(false);
    expect(undone).toBe(false);
    expect(notices).toEqual(["Can't undo manual: newer changes came after it"]);
  });

  it("the toast for a hand-written entry names that entry", () => {
    const toasts: Array<[string, string]> = [];
    setUndoNotifier({ notify: () => {}, notifyWithUndo: (l, id) => toasts.push([l, id]) });
    const id = pushUndo({ label: "manual", undo: () => {}, redo: () => {} });
    showUndoToast("Did it");
    expect(toasts).toEqual([["Did it", id]]);
  });
});

describe("manual entries keep the old contract", () => {
  it("push, undo, redo through closures with the default notices", () => {
    setUndoNotifier({ notify: (m) => notices.push(m) });
    let n = 0;
    pushUndo({ label: "inc", undo: () => { n--; }, redo: () => { n++; } });
    n++;
    expect(performUndo()).toBe(true);
    expect(n).toBe(0);
    expect(performRedo()).toBe(true);
    expect(n).toBe(1);
    expect(notices).toEqual(["Undid: inc", "Redid: inc"]);
  });
});

describe("confirm", () => {
  it("blind undo skips a confirm entry with a notice; its toast may undo it", () => {
    const e = generic("Made public");
    e.confirm = true;
    expect(performUndo()).toBe(true);
    expect(value).toEqual(["Made public"]);
    expect(notices).toEqual(["Undo Made public from its toast or the history"]);
    expect(undoEntry(e.id)).toBe(true);
    expect(value).toEqual([]);
  });

  it("blind undo stops at a confirm entry and leaves the ones below it", () => {
    generic("Older");
    generic("Old");
    const e = generic("Made public");
    e.confirm = true;
    expect(performUndo()).toBe(true);
    expect(performUndo()).toBe(true);
    expect(value).toEqual(["Older", "Old", "Made public"]);
    expect(notices).toEqual([
      "Undo Made public from its toast or the history",
      "Undo Made public from its toast or the history",
    ]);
    expect(getUndoHistory().head).toBe(e.id);
  });

  it("an onConfirmStop notifier hears the stop instead of notify", () => {
    const stops: Array<[string, string]> = [];
    setUndoNotifier({ notify: (m) => notices.push(m), onConfirmStop: (entry, message) => stops.push([entry.id, message]) });
    const e = generic("Made public");
    e.confirm = true;
    expect(performUndo()).toBe(true);
    expect(stops).toEqual([[e.id, "Undo Made public from its toast or the history"]]);
    expect(notices).toEqual([]);
    expect(value).toEqual(["Made public"]);
  });

  it("once the confirm entry is undone from its toast, blind undo reaches the next one", () => {
    generic("Old");
    const e = generic("Made public");
    e.confirm = true;
    expect(undoEntry(e.id)).toBe(true);
    expect(performUndo()).toBe(true);
    expect(value).toEqual([]);
  });

  it("a manual entry below a confirm entry is left alone", () => {
    let n = 1;
    pushUndo({ label: "inc", undo: () => { n--; }, redo: () => { n++; } });
    const e = generic("Made public");
    e.confirm = true;
    expect(performUndo()).toBe(true);
    expect(n).toBe(1);
    expect(notices).toEqual(["Undo Made public from its toast or the history"]);
  });
});

describe("_resetUndoStacks", () => {
  it("clears stacks and history", () => {
    generic("a");
    performUndo();
    generic("b");
    _resetUndoStacks();
    expect(getUndoHistory().items).toEqual([]);
    expect(getUndoHistory().head).toBeNull();
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });
});

describe("undoRowCount", () => {
  it("counts a row held by two stores once", () => {
    const objects = ["a", "b"].flatMap((id) => [{ store: "sessions", id }, { store: "conversations", id }]);
    expect([undoRowCount(objects), undoRowCount([{ store: "conversations", id: "b" }]), undoRowCount(undefined)]).toEqual([2, 1, 0]);
  });
});

describe("suspendUndoRecording", () => {
  it("a window holding it records nothing until every hold is released", () => {
    _resetUndoStacks();
    const entry = () => ({ label: "x", undo: () => ({ ok: true as const, applied: 1, skipped: 0 }), redo: () => ({ ok: true as const, applied: 1, skipped: 0 }) });
    const a = suspendUndoRecording();
    const b = suspendUndoRecording();
    expect(isUndoSuppressed()).toBe(true);
    pushUndo(entry());
    expect(getUndoHistory().items).toHaveLength(0);
    a();
    a();
    pushUndo(entry());
    expect(getUndoHistory().items).toHaveLength(0);
    b();
    expect(isUndoSuppressed()).toBe(false);
    pushUndo(entry());
    expect(getUndoHistory().items).toHaveLength(1);
  });
});
