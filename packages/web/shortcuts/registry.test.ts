import { test, expect, describe } from "bun:test";
import { SHORTCUTS, type ShortcutAction } from "./registry";

// Regression guard for the "session died mysteriously" incident: a ctrl+shift+
// backspace kill chord fired while the composer was focused (ctrl+backspace is the
// OS delete-previous-word key), preventDefault swallowed the keystroke so nothing
// looked wrong, and the selected session was SIGKILLed mid-answer. The dispatcher
// only suppresses an in-input keystroke when the binding lacks skipInputCheck
// (ShortcutProvider line: `if (inInput && !def.skipInputCheck) continue`), so these
// destructive actions must NOT carry that flag.
const DESTRUCTIVE_ACTIONS: ShortcutAction[] = [
  "session.kill",
  "session.stash",
  "session.deferAdvance",
];

describe("destructive shortcuts honor the in-input guard", () => {
  for (const action of DESTRUCTIVE_ACTIONS) {
    test(`${action} does not bypass the input guard`, () => {
      const defs = SHORTCUTS.filter((s) => s.action === action);
      expect(defs.length).toBeGreaterThan(0);
      for (const def of defs) {
        expect(def.skipInputCheck ?? false).toBe(false);
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
