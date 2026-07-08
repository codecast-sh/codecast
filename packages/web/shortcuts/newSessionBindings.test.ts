import { test, expect, describe } from "bun:test";
import { SHORTCUTS, matchShortcut, type ShortcutAction } from "./registry";

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
