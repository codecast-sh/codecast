import { test, expect, describe } from "bun:test";
import { SHORTCUTS, inputGuardBypass, hasOpenModal, type ShortcutAction, type ShortcutDef } from "./registry";

// Regression guard for the "session died mysteriously" incident: a ctrl+shift+
// backspace kill chord fired while the composer was focused (ctrl+backspace is the
// OS delete-previous-word key), preventDefault swallowed the keystroke so nothing
// looked wrong, and the selected session was SIGKILLed mid-answer. The fix is the
// 'whenEmpty' guard: destructive chords fire from an EMPTY composer (keyboard
// triage flow) but defer to the editor whenever there is text — delete-word
// muscle memory only collides when there is something to delete. These bindings
// must never carry skipInputCheck: true (unconditional bypass).
const DESTRUCTIVE_ACTIONS: ShortcutAction[] = [
  "session.kill",
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

// While a modal dialog is open it owns the keyboard: the dispatcher suppresses
// every shortcut except those flagged worksInModal. The flag is reserved for
// app-chrome actions that cannot touch the surface behind the dialog — zoom,
// and the settings toggle (which closes the modal itself). Anything acting on
// the session/conversation behind the dialog (switch, kill, compose.focus,
// y/n permission answers) must never carry it: typing in a dialog input once
// stole Ctrl+M into the background composer and let bare letters approve
// permissions on the conversation underneath.
describe("worksInModal is restricted to app-chrome shortcuts", () => {
  const ALLOWED: ShortcutAction[] = ["ui.openSettings", "zoom.in", "zoom.out", "zoom.reset"];

  test("only the allowlisted actions fire while a modal is open", () => {
    const flagged = SHORTCUTS.filter((s) => s.worksInModal).map((s) => s.action);
    for (const action of flagged) expect(ALLOWED).toContain(action);
  });

  test("background-acting shortcuts are never flagged", () => {
    const background: ShortcutAction[] = [
      "session.next", "session.kill", "session.stash", "compose.focus",
      "permission.approve", "permission.deny", "msg.sendAdvance",
    ];
    for (const def of SHORTCUTS.filter((s) => background.includes(s.action))) {
      expect(def.worksInModal).toBeUndefined();
    }
  });
});

describe("hasOpenModal", () => {
  test("false without a document (SSR / dispatcher safety)", () => {
    expect(hasOpenModal()).toBe(false);
  });

  test("reflects an aria-modal element that is not mid exit animation", () => {
    const stub = (found: boolean) => ({
      querySelector: (sel: string) => {
        expect(sel).toBe('[aria-modal="true"]:not([data-state="closed"])');
        return found ? {} : null;
      },
    });
    (globalThis as any).document = stub(true);
    try {
      expect(hasOpenModal()).toBe(true);
      (globalThis as any).document = stub(false);
      expect(hasOpenModal()).toBe(false);
    } finally {
      delete (globalThis as any).document;
    }
  });
});
