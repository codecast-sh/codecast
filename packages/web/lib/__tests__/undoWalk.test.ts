import { describe, expect, test } from "bun:test";
import {
  FADE_MS,
  MILESTONE_WINDOW_MS,
  PEEK_DELAY_MS,
  WALK_IDLE,
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

  test("releasing while the pointer is over the card pins it", () => {
    const s = run(undo(), { type: "peekTimer" }, { type: "release", hovered: true });
    expect(s.phase).toBe("pinned");
    expect(walkView(s)).toEqual({ open: true, mode: "interactive" });
  });

  test("the pointer reaching the card during the fade pins it", () => {
    const s = run(undo(), { type: "peekTimer" }, { type: "release", hovered: false }, { type: "pointerEnter" });
    expect(s.phase).toBe("pinned");
    expect(walk(s, { type: "fadeTimer" }).phase).toBe("pinned");
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
