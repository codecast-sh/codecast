import { describe, expect, test } from "bun:test";
import {
  FADE_MS,
  MILESTONE_WINDOW_MS,
  PEEK_DELAY_MS,
  WALK_IDLE,
  createFieldUndoGuard,
  fieldHoldsText,
  fieldOwnsStep,
  walk,
  walkTimer,
  walkView,
  type WalkEvent,
  type WalkState,
} from "../undoWalk";

const T0 = 1_000_000;
const undo = (at = T0, held = true): WalkEvent => ({ type: "step", dir: "undo", held, at });
const redo = (at = T0, held = true): WalkEvent => ({ type: "step", dir: "redo", held, at });
const run = (...events: WalkEvent[]): WalkState => events.reduce(walk, WALK_IDLE);

describe("held-modifier undo walk", () => {
  test("a held undo arms the peek, which opens after the delay", () => {
    const armed = run(undo());
    expect(armed.phase).toBe("armed");
    expect(walkView(armed)).toEqual({ open: false });
    expect(walkTimer(armed)).toEqual({ ms: PEEK_DELAY_MS, event: { type: "peekTimer" } });
    expect(PEEK_DELAY_MS).toBe(350);

    const peek = walk(armed, { type: "peekTimer" });
    expect(peek.phase).toBe("peek");
    expect(walkView(peek)).toEqual({ open: true, mode: "peek" });
    expect(walkTimer(peek)).toBeNull();
  });

  test("releasing before the delay shows nothing, and a late timer is ignored", () => {
    const s = run(undo(), { type: "release", hovered: false });
    expect(s.phase).toBe("idle");
    expect(walk(s, { type: "peekTimer" }).phase).toBe("idle");
  });

  test("an undo without the modifier held never peeks", () => {
    expect(run(undo(T0, false)).phase).toBe("idle");
  });

  test("Z steps back and Shift+Z steps forward while the peek narrates", () => {
    const peek = run(undo(), { type: "peekTimer" });
    expect(walk(peek, undo(T0 + 500)).phase).toBe("peek");
    expect(walk(peek, redo(T0 + 600)).phase).toBe("peek");
    // A redo can arm the walk as well as an undo.
    expect(run(redo()).phase).toBe("armed");
  });

  test("a second step inside the delay opens the peek at once", () => {
    expect(run(undo(), undo(T0 + 100)).phase).toBe("peek");
  });

  test("H pins the card interactive", () => {
    const pinned = run(undo(), { type: "peekTimer" }, { type: "pin" });
    expect(pinned.phase).toBe("pinned");
    expect(walkView(pinned)).toEqual({ open: true, mode: "interactive" });
    // Release and other keys leave a pinned card alone: it owns the keyboard.
    expect(walk(pinned, { type: "release", hovered: false }).phase).toBe("pinned");
    expect(walk(pinned, { type: "otherKey" }).phase).toBe("pinned");
    // H does nothing before the peek shows.
    expect(run(undo(), { type: "pin" }).phase).toBe("armed");
  });

  test("H during the fade still pins", () => {
    expect(run(undo(), { type: "peekTimer" }, { type: "release", hovered: false }, { type: "pin" }).phase).toBe("pinned");
  });

  test("releasing the modifier fades the peek after 600ms", () => {
    const fading = run(undo(), { type: "peekTimer" }, { type: "release", hovered: false });
    expect(fading.phase).toBe("fading");
    expect(walkView(fading)).toEqual({ open: true, mode: "peek" });
    expect(walkTimer(fading)).toEqual({ ms: FADE_MS, event: { type: "fadeTimer" } });
    expect(FADE_MS).toBe(600);
    const closed = walk(fading, { type: "fadeTimer" });
    expect(closed.phase).toBe("idle");
    expect(walkView(closed)).toEqual({ open: false });
  });

  test("pressing the modifier and Z again during the fade resumes the peek", () => {
    const fading = run(undo(), { type: "peekTimer" }, { type: "release", hovered: false });
    expect(walk(fading, undo(T0 + 800)).phase).toBe("peek");
  });

  // A pointer that happens to rest over the card holds it open as a peek; it
  // takes no focus and no keys until the user presses on it.
  test("releasing while the pointer is over the card holds the peek without taking keys", () => {
    const s = run(undo(), { type: "peekTimer" }, { type: "release", hovered: true });
    expect(s.phase).toBe("hovered");
    expect(walkView(s)).toEqual({ open: true, mode: "peek" });
    expect(walkTimer(s)).toBeNull();
    expect(walk(s, { type: "otherKey" }).phase).toBe("idle");
    expect(walk(s, { type: "cardPress" }).phase).toBe("pinned");
  });

  test("the pointer reaching the card during the fade holds it; leaving resumes the fade", () => {
    const s = run(undo(), { type: "peekTimer" }, { type: "release", hovered: false }, { type: "pointerEnter" });
    expect(s.phase).toBe("hovered");
    expect(walk(s, { type: "fadeTimer" }).phase).toBe("hovered");
    expect(walk(s, { type: "pointerLeave" }).phase).toBe("fading");
  });

  test("any other key cancels the walk at every unpinned phase", () => {
    expect(run(undo(), { type: "otherKey" }).phase).toBe("idle");
    expect(run(undo(), { type: "peekTimer" }, { type: "otherKey" }).phase).toBe("idle");
    expect(run(undo(), { type: "peekTimer" }, { type: "release", hovered: false }, { type: "otherKey" }).phase).toBe("idle");
    // A cancelled walk never opens on a late timer.
    expect(run(undo(), { type: "otherKey" }, { type: "peekTimer" }).phase).toBe("idle");
  });

  test("a card closed from elsewhere ends the walk", () => {
    expect(run(undo(), { type: "peekTimer" }, { type: "pin" }, { type: "closed" }).phase).toBe("idle");
  });

  test("an unheld step closes a peek but leaves a pinned card", () => {
    expect(run(undo(), { type: "peekTimer" }, undo(T0 + 100, false)).phase).toBe("idle");
    expect(run(undo(), { type: "peekTimer" }, { type: "pin" }, undo(T0 + 100, false)).phase).toBe("pinned");
  });

  test("the milestone fires on the second undo within 10s, once per pair", () => {
    const first = run(undo(T0));
    expect(first.milestone).toBe(false);
    const second = walk(first, undo(T0 + MILESTONE_WINDOW_MS));
    expect(second.milestone).toBe(true);
    // The flag lives on one state only.
    expect(walk(second, { type: "peekTimer" }).milestone).toBe(false);
    // Too far apart, or a redo: no milestone.
    expect(walk(first, undo(T0 + MILESTONE_WINDOW_MS + 1)).milestone).toBe(false);
    expect(walk(first, redo(T0 + 100)).milestone).toBe(false);
  });
});

// ⌘Z from an empty field reaches app undo only when the field has no newer
// history of its own: a triage chord from the empty composer is taken back,
// a draft the user just cleared comes back in the field.
describe("fieldOwnsStep", () => {
  const history = {
    items: [{ id: "b", ts: 200, undoneAt: 500 }, { id: "a", ts: 100 }],
    undoOrder: ["a"],
    redoOrder: ["b"],
  };
  test("a field never edited hands the press to the app", () => {
    expect(fieldOwnsStep("undo", undefined, history)).toBe(false);
  });
  test("a field edited before the entry was recorded hands the press to the app", () => {
    expect(fieldOwnsStep("undo", 50, history)).toBe(false);
  });
  test("a field edited after the entry keeps the press", () => {
    expect(fieldOwnsStep("undo", 150, history)).toBe(true);
  });
  test("redo compares with when the entry was taken back", () => {
    expect(fieldOwnsStep("redo", 300, history)).toBe(false);
    expect(fieldOwnsStep("redo", 600, history)).toBe(true);
  });
  test("an edited field keeps the press when the app has nothing to step", () => {
    expect(fieldOwnsStep("undo", 1, { items: [], undoOrder: [], redoOrder: [] })).toBe(true);
  });
});

// A press the field declined goes to the browser. When the browser had
// nothing left to take back in that field, the press reaches the app instead.
describe("createFieldUndoGuard", () => {
  const history = { items: [{ id: "a", ts: 100 }], undoOrder: ["a"], redoOrder: [] as string[] };
  const setup = () => {
    let now = 0;
    const deferred: Array<() => void> = [];
    const guard = createFieldUndoGuard({ now: () => now, defer: (fn) => deferred.push(fn) });
    const flush = () => deferred.splice(0).forEach((fn) => fn());
    return { guard, flush, at: (t: number) => (now = t) };
  };
  const field = {};

  test("edit after the entry, undo the edits back to empty, then ⌘Z reaches the app", () => {
    const { guard, flush, at } = setup();
    let appSteps = 0;
    const app = () => { appSteps += 1; };
    at(150);
    guard.edited(field); // typed "h"
    guard.edited(field); // typed "hm"
    // Each native undo produces an input in the field: the field keeps the press.
    for (let i = 0; i < 2; i++) {
      expect(guard.declines("undo", field, history, app)).toBe(true);
      guard.edited(field);
      flush();
    }
    expect(appSteps).toBe(0);
    // The field's history is spent: the browser does nothing, so the app steps.
    expect(guard.declines("undo", field, history, app)).toBe(true);
    flush();
    expect(appSteps).toBe(1);
    // And from then on the press goes straight to the app.
    expect(guard.declines("undo", field, history, app)).toBe(false);
  });

  test("one press reaching the guard twice falls back once", () => {
    const { guard, flush, at } = setup();
    let appSteps = 0;
    at(150);
    guard.edited(field);
    expect(guard.declines("undo", field, history, () => { appSteps += 1; })).toBe(true);
    expect(guard.declines("undo", field, history, () => { appSteps += 1; })).toBe(true);
    flush();
    expect(appSteps).toBe(1);
  });

  test("a browser that says it has nothing left hands the press to the app at once", () => {
    const { guard, flush, at } = setup();
    let appSteps = 0;
    const app = () => { appSteps += 1; };
    at(150);
    guard.edited(field);
    expect(guard.declines("undo", field, history, app, true)).toBe(true);
    flush();
    expect(appSteps).toBe(0);
    expect(guard.declines("undo", field, history, app, false)).toBe(false);
    // The field is spent: no later press defers to it, whatever the browser says.
    expect(guard.declines("undo", field, history, app, true)).toBe(false);
    flush();
    expect(appSteps).toBe(0);
  });

  test("a field never edited after the entry never declines", () => {
    const { guard, at } = setup();
    at(50);
    guard.edited(field);
    expect(guard.declines("undo", field, history, () => {})).toBe(false);
  });

  test("a press after an entry redone later than the edit reaches the app", () => {
    const { guard, at } = setup();
    at(150);
    guard.edited(field);
    expect(guard.declines("undo", field, { ...history, items: [{ id: "a", ts: 100, redoneAt: 200 }] }, () => {})).toBe(false);
  });
  // A field holding text keeps its own undo while it has one. A draft the
  // app seeded (a triage step that lands on a session with one) has none:
  // nobody edited it, and the browser's undo would do nothing.
  describe("a field holding text", () => {
    test("seeded and never edited, the press is the app's", () => {
      const { guard } = setup();
      expect(guard.keepsWithText(field, () => {})).toBe(false);
    });

    // Chromium's queryCommandEnabled answers for the frame: typing in any
    // mounted field makes it true for every other one. Only an edit record
    // of this field keeps the press; the browser's "nothing" drops it.
    test("a frame-wide yes never keeps the press for a field nobody edited", () => {
      const { guard, at } = setup();
      const other = {};
      at(5);
      guard.edited(other);
      expect(guard.keepsWithText(field, () => {}, true)).toBe(false);
      expect(guard.declines("undo", field, history, () => {}, true)).toBe(false);
      at(10);
      guard.edited(field);
      expect(guard.keepsWithText(field, () => {}, true)).toBe(true);
      expect(guard.keepsWithText(field, () => {}, false)).toBe(false);
    });

    test("a kept press whose browser step lands in another field gives the field's later presses to the app", () => {
      const { guard, at } = setup();
      const other = {};
      at(5);
      guard.edited(field);
      guard.edited(other);
      expect(guard.keepsWithText(field, () => {}, true)).toBe(true);
      // The browser's undo edited the other field: this one had nothing left.
      guard.edited(other);
      expect(guard.keepsWithText(field, () => {}, true)).toBe(false);
    });

    test("edited, however long ago, it keeps the press until it has nothing left", () => {
      const { guard, flush, at } = setup();
      let appSteps = 0;
      at(10);
      guard.edited(field);
      expect(guard.keepsWithText(field, () => { appSteps += 1; })).toBe(true);
      // No input came of the browser's undo: the field had nothing, the app steps.
      flush();
      expect(appSteps).toBe(1);
      expect(guard.keepsWithText(field, () => {})).toBe(false);
    });
  });
});

describe("fieldHoldsText", () => {
  test("reads inputs by value, editables by text, and nothing else", () => {
    expect(fieldHoldsText({ tagName: "TEXTAREA", value: "draft" } as any)).toBe(true);
    expect(fieldHoldsText({ tagName: "INPUT", value: "" } as any)).toBe(false);
    expect(fieldHoldsText({ tagName: "DIV", isContentEditable: true, textContent: " \n" } as any)).toBe(false);
    expect(fieldHoldsText({ tagName: "DIV", isContentEditable: true, textContent: "note" } as any)).toBe(true);
    expect(fieldHoldsText({ tagName: "DIV" } as any)).toBeNull();
  });
});
