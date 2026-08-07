import { test, expect, describe } from "bun:test";
import { SHORTCUTS, matchShortcut, altChordDirection, type ShortcutAction } from "./registry";

// Ctrl+N opens the compose modal; Ctrl+Alt+N (⌃⌥N) opens a full new session in the
// main window. This guards that swap (a prior commit had Ctrl+N opening the full
// page) AND the macOS Option-key trap: ⌥ composes letters, so ⌥N arrives as the
// tilde dead key (e.key "Dead", never "n") — the chord must still match via e.code.

// Mirror the dispatcher's resolution: first SHORTCUTS def that matches wins. The
// real loop (ShortcutProvider) also filters by context/input, but every binding
// here is global + skipInputCheck, so key matching alone decides the action.
function resolveAction(e: Partial<KeyboardEvent>): ShortcutAction | null {
  const ev = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...e } as KeyboardEvent;
  return SHORTCUTS.find((def) => matchShortcut(ev, def))?.action ?? null;
}

describe("new-session key bindings", () => {
  test("Ctrl+N opens the compose modal, not the full page", () => {
    expect(resolveAction({ key: "n", code: "KeyN", ctrlKey: true })).toBe("session.compose");
  });

  test("Ctrl+Alt+N opens the full session page", () => {
    expect(resolveAction({ key: "n", code: "KeyN", ctrlKey: true, altKey: true })).toBe("session.create");
  });

  test("Ctrl+Alt+N matches on macOS where ⌥N is the tilde dead key", () => {
    // What Chrome on macOS actually delivers for ⌃⌥N: the composed/dead glyph in
    // e.key, the physical key only in e.code.
    expect(resolveAction({ key: "Dead", code: "KeyN", ctrlKey: true, altKey: true })).toBe("session.create");
    expect(resolveAction({ key: "˜", code: "KeyN", ctrlKey: true, altKey: true })).toBe("session.create");
  });

  test("the e.code fallback never fires for a plain (no-Alt) chord", () => {
    // Ctrl+N with a mismatched e.key must NOT borrow the physical key — only Alt
    // chords get the fallback, so a layout that maps KeyN elsewhere still wins.
    expect(resolveAction({ key: "j", code: "KeyN", ctrlKey: true })).not.toBe("session.compose");
  });

  test("Ctrl+N (no Alt) never resolves to the full-page action", () => {
    expect(resolveAction({ key: "n", code: "KeyN", ctrlKey: true })).not.toBe("session.create");
  });
});

// NewSessionView's window-capture ⌥-chord router resolves keydowns through
// altChordDirection. Regression: adding ⌥←/⌥→ to the router (4497dcc59) stole
// macOS word jump from the message textarea — the agent picker cycled instead
// of the caret moving. Horizontal ARROWS from an editable target must resolve
// to null; everything else keeps routing.
describe("new-session ⌥-chord router (altChordDirection)", () => {
  const textarea = { tagName: "TEXTAREA" } as unknown as EventTarget;
  const body = { tagName: "BODY" } as unknown as EventTarget;
  const chord = (code: string, target: EventTarget, mods: Partial<KeyboardEvent> = {}) =>
    altChordDirection({ altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, code, target, ...mods });

  test("⌥←/⌥→ from a text caret is released (word jump), not routed", () => {
    expect(chord("ArrowLeft", textarea)).toBeNull();
    expect(chord("ArrowRight", textarea)).toBeNull();
  });

  test("⌥H/⌥L still cycle the pickers even from the caret", () => {
    expect(chord("KeyH", textarea)).toBe("left");
    expect(chord("KeyL", textarea)).toBe("right");
  });

  test("⌥←/⌥→ route when focus is outside a text field", () => {
    expect(chord("ArrowLeft", body)).toBe("left");
    expect(chord("ArrowRight", body)).toBe("right");
  });

  test("⌥↑/⌥↓ stay intercepted from the caret — they climb out of the textarea", () => {
    expect(chord("ArrowUp", textarea)).toBe("up");
    expect(chord("ArrowDown", textarea)).toBe("down");
    expect(chord("KeyK", textarea)).toBe("up");
    expect(chord("KeyJ", textarea)).toBe("down");
  });

  test("extra modifiers or no Alt never route", () => {
    expect(chord("ArrowLeft", body, { altKey: false })).toBeNull();
    expect(chord("ArrowLeft", body, { shiftKey: true })).toBeNull();
    expect(chord("KeyH", body, { metaKey: true })).toBeNull();
  });
});
