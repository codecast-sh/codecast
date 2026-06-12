import { test, expect, describe } from "bun:test";
import { SHORTCUTS, inputGuardBypass, type ShortcutAction, type ShortcutDef } from "./registry";

// Regression guard for the "session died mysteriously" incident: a ctrl+shift+
// backspace kill chord fired while the composer was focused (ctrl+backspace is the
// OS delete-previous-word key), preventDefault swallowed the keystroke so nothing
// looked wrong, and the selected session was SIGKILLed mid-answer. The fix is the
// 'whenEmpty' guard: destructive chords fire from an EMPTY composer (keyboard
// triage flow) but defer to the editor whenever there is text — delete-word
// muscle memory only collides when there is something to delete. These bindings
// must never carry skipInputCheck: true (unconditional bypass).
const DESTRUCTIVE_ACTIONS: ShortcutAction[] = [
  "session.dismiss",
  "session.stash",
  "session.deferAdvance",
];

describe("destructive shortcuts use the empty-input guard", () => {
  for (const action of DESTRUCTIVE_ACTIONS) {
    test(`${action} never bypasses the input guard unconditionally`, () => {
      const defs = SHORTCUTS.filter((s) => s.action === action);
      expect(defs.length).toBeGreaterThan(0);
      for (const def of defs) {
        expect(def.skipInputCheck).toBe("whenEmpty");
      }
    });
  }

  test("navigation chords still fire while typing (skipInputCheck preserved)", () => {
    // The distinction the incident turned on: navigating while composing is a
    // feature; mutating/killing the session while composing is the footgun.
    const next = SHORTCUTS.find((s) => s.action === "session.next");
    expect(next?.skipInputCheck).toBe(true);
  });
});

describe("inputGuardBypass", () => {
  const def = (skipInputCheck?: boolean | "whenEmpty"): ShortcutDef => ({
    key: "ctrl+backspace",
    action: "session.stash",
    skipInputCheck,
    description: "test",
  });

  test("true bypasses regardless of content", () => {
    expect(inputGuardBypass(def(true), { tagName: "TEXTAREA", value: "draft" })).toBe(true);
  });

  test("absent never bypasses", () => {
    expect(inputGuardBypass(def(undefined), { tagName: "TEXTAREA", value: "" })).toBe(false);
  });

  test("whenEmpty fires in an empty textarea, defers when text is present", () => {
    expect(inputGuardBypass(def("whenEmpty"), { tagName: "TEXTAREA", value: "" })).toBe(true);
    expect(inputGuardBypass(def("whenEmpty"), { tagName: "TEXTAREA", value: "half-typed message" })).toBe(false);
  });

  test("whenEmpty handles contentEditable via textContent", () => {
    expect(inputGuardBypass(def("whenEmpty"), { isContentEditable: true, textContent: "  \n" })).toBe(true);
    expect(inputGuardBypass(def("whenEmpty"), { isContentEditable: true, textContent: "doc text" })).toBe(false);
  });

  test("whenEmpty stays suppressed for pseudo-inputs and null targets", () => {
    // e.g. the review region: treated as an input by the dispatcher but has no
    // value/content notion, so the chord must not fire there.
    expect(inputGuardBypass(def("whenEmpty"), { tagName: "DIV" })).toBe(false);
    expect(inputGuardBypass(def("whenEmpty"), null)).toBe(false);
  });
});
