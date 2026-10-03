import { test, expect, describe } from "bun:test";
import { createShortcutCatalog } from "@platform/keys";
import { SHORTCUTS, inputGuardBypass, hasOpenModal, type ShortcutAction, type ShortcutDef } from "./registry";
import { HELP_SECTIONS } from "./sections";

// The "?" panel renders one section per context in HELP_SECTIONS; a def whose
// `when` has no section row is silently invisible in the help. Coverage of the
// catalog is total or the panel lies about what the keyboard can do.
describe("shortcuts help covers the whole catalog", () => {
  test("every binding context has a help panel section", () => {
    const sectionWhens = new Set(HELP_SECTIONS.map((s) => s.when));
    const missing = [...new Set(SHORTCUTS.map((d) => d.when))].filter(
      (w) => !sectionWhens.has(w),
    );
    expect(missing).toEqual([]);
  });

  test("help sections carry no dead contexts", () => {
    const defWhens = new Set(SHORTCUTS.map((d) => d.when));
    const dead = HELP_SECTIONS.map((s) => s.when).filter((w) => !defWhens.has(w));
    expect(dead).toEqual([]);
  });
});

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
  // Not destructive, but it rides the same backspace family and advances the
  // view — an unconditional bypass would fire it from a full composer.
  "session.dormantAdvance",
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
// app-chrome actions that cannot touch the surface behind the dialog, like
// the settings toggle (which closes the modal itself). Anything acting on
// the session/conversation behind the dialog (switch, kill, compose.focus,
// y/n permission answers) must never carry it: typing in a dialog input once
// stole Ctrl+M into the background composer and let bare letters approve
// permissions on the conversation underneath.
describe("worksInModal is restricted to app-chrome shortcuts", () => {
  const ALLOWED: ShortcutAction[] = ["ui.openSettings", "palette.toggle", "session.composeDock"];

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

  const stub = (modals: { contains: (el: unknown) => boolean }[]) => ({
    querySelectorAll: (sel: string) => {
      expect(sel).toBe('[aria-modal="true"]:not([data-state="closed"])');
      return modals;
    },
  });

  test("reflects an aria-modal element that is not mid exit animation", () => {
    (globalThis as any).document = stub([{ contains: () => false }]);
    try {
      expect(hasOpenModal()).toBe(true);
      (globalThis as any).document = stub([]);
      expect(hasOpenModal()).toBe(false);
    } finally {
      delete (globalThis as any).document;
    }
  });

  // Regression: the compose dialog hosts NewSessionView inside its own
  // aria-modal container — the pickers' ⌥-chords must keep working there. A
  // modal that CONTAINS the handler's root doesn't block it; any modal stacked
  // elsewhere (draft confirm, settings) still does.
  test("a modal containing the host does not block it", () => {
    const host = {};
    (globalThis as any).document = stub([{ contains: (el: unknown) => el === host }]);
    try {
      expect(hasOpenModal(host as Element)).toBe(false);
      expect(hasOpenModal()).toBe(true);
    } finally {
      delete (globalThis as any).document;
    }
  });

  test("a modal elsewhere blocks a hosted handler", () => {
    const host = {};
    (globalThis as any).document = stub([
      { contains: (el: unknown) => el === host },
      { contains: () => false },
    ]);
    try {
      expect(hasOpenModal(host as Element)).toBe(true);
    } finally {
      delete (globalThis as any).document;
    }
  });

  test("null host falls back to any-open-modal", () => {
    (globalThis as any).document = stub([{ contains: () => true }]);
    try {
      // rootRef.current can be null for a beat before the surface mounts —
      // fail safe: stand down as if unhosted.
      expect(hasOpenModal(null)).toBe(true);
    } finally {
      delete (globalThis as any).document;
    }
  });
});

// THE TEAM, FROM ANYWHERE. The wall answers a question people have in the
// middle of something else, so the chord has to be reachable from wherever they
// are — including out of a composer, which is where they usually are when they
// wonder whether to just ask somebody instead.
//
// Its one real hazard is the neighbour: Ctrl+Shift+P is Pin/unpin session, on
// every platform, and a second definition on that combo would sit behind it
// forever and look like a chord that simply does not work. So the wall takes
// the ⌘ chord and takes it on both platforms — the same call the palette makes
// with ⌘K — and this is the test that says so out loud.
describe("the people wall chord", () => {
  const defs = SHORTCUTS.filter((s) => s.action === "people.wall");

  test("exactly one binding, described, and global", () => {
    expect(defs.length).toBe(1);
    expect(defs[0].when).toBeUndefined();
    expect(defs[0].description).toBeTruthy();
    // Reachable from a composer: this one opens a surface, it does not mutate
    // or destroy anything behind the dialog.
    expect(defs[0].skipInputCheck).toBe(true);
  });

  test("one chord on every platform, and it is never the pin chord", () => {
    // No mac variant on purpose: a `ctrl` variant off mac would resolve onto
    // session.pin, sit behind it in catalog order and never fire.
    expect(defs[0].key).toBe("meta+shift+p");
    expect(defs[0].mac).toBeUndefined();
    for (const isMac of [true, false]) {
      const collides = createShortcutCatalog(SHORTCUTS, { isMac })
        .conflicts()
        .filter((c) => c.defs.some((d) => d.action === "people.wall"));
      expect(collides).toEqual([]);
    }
  });

  test("the help panel and the palette can both render it", () => {
    // Both derive their keycaps from the registry by action, so a binding that
    // resolves is the whole of "it is discoverable".
    const catalog = createShortcutCatalog(SHORTCUTS, { isMac: true });
    expect(catalog.getShortcutsForAction("people.wall")).toHaveLength(1);
    expect(catalog.formatShortcutLabel("people.wall")).toBe("⌘⇧P");
    // Listed with the other unscoped chords, which is the panel's Global block.
    expect(catalog.getShortcutsByContext(undefined).map((d) => d.action)).toContain("people.wall");
  });
});

// The recents search chord opens the Ctrl+Tab overlay with its field live.
// Ctrl+R on mac, Alt+R elsewhere (Ctrl+R is reload there, in the desktop View
// menu and the browser). The walk's own R handoff does not depend on it.
describe("the recents search chord", () => {
  const defs = SHORTCUTS.filter((s) => s.action === "recents.open");

  test("one global binding, reachable from a composer", () => {
    expect(defs.length).toBe(1);
    expect(defs[0].when).toBeUndefined();
    expect(defs[0].description).toBeTruthy();
    expect(defs[0].skipInputCheck).toBe(true);
  });

  test("Ctrl+R on mac, Alt+R elsewhere, colliding with nothing", () => {
    expect(defs[0].mac).toBe("ctrl+r");
    expect(defs[0].key).toBe("alt+r");
    for (const isMac of [true, false]) {
      const collides = createShortcutCatalog(SHORTCUTS, { isMac })
        .conflicts()
        .filter((c) => c.defs.some((d) => d.action === "recents.open"));
      expect(collides).toEqual([]);
    }
  });
});

// App undo: ⌘Z on mac (⌃Z kept as a second binding), Ctrl+Z elsewhere. It
// must never fire inside a text field, which keeps its own undo, and a held
// chord is one undo, not the whole stack at key-repeat speed.
describe("the undo chords", () => {
  const keyEvent = (over: Partial<KeyboardEvent>) =>
    ({ key: "z", code: "KeyZ", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over }) as KeyboardEvent;
  const resolve = (isMac: boolean, e: KeyboardEvent) => {
    const catalog = createShortcutCatalog(SHORTCUTS, { isMac });
    return catalog.shortcuts.find((d) => catalog.matchShortcut(e, d))?.action;
  };
  const UNDO_ACTIONS: ShortcutAction[] = ["ui.undo", "ui.redo", "ui.undoHistory"];

  test("meta+z is undo on mac, and ctrl+z still is", () => {
    expect(resolve(true, keyEvent({ metaKey: true }))).toBe("ui.undo");
    expect(resolve(true, keyEvent({ ctrlKey: true }))).toBe("ui.undo");
    expect(resolve(true, keyEvent({ metaKey: true, shiftKey: true }))).toBe("ui.redo");
    expect(resolve(true, keyEvent({ metaKey: true, altKey: true }))).toBe("ui.undoHistory");
  });

  test("ctrl+z, ctrl+shift+z and ctrl+y off mac", () => {
    expect(resolve(false, keyEvent({ ctrlKey: true }))).toBe("ui.undo");
    expect(resolve(false, keyEvent({ ctrlKey: true, shiftKey: true }))).toBe("ui.redo");
    expect(resolve(false, keyEvent({ key: "y", code: "KeyY", ctrlKey: true }))).toBe("ui.redo");
    expect(resolve(false, keyEvent({ ctrlKey: true, altKey: true }))).toBe("ui.undoHistory");
  });

  // The triage chords fire from an empty composer and leave focus there, so
  // undo and redo reach app undo from an empty field; a field with text keeps
  // its own.
  test("undo and redo bypass the input guard only from an empty field", () => {
    for (const def of SHORTCUTS.filter((d) => d.action === "ui.undo" || d.action === "ui.redo")) {
      expect(def.skipInputCheck).toBe("whenEmpty");
      expect(inputGuardBypass(def, { tagName: "TEXTAREA", value: "" })).toBe(true);
      expect(inputGuardBypass(def, { tagName: "TEXTAREA", value: "draft" })).toBe(false);
    }
  });

  // ⌘⌥Z is no text on mac, so the history chord opens from the autofocused
  // composer. Off mac Ctrl+Alt is AltGr, which types letters (Polish ż), so
  // the chord stays out of fields there.
  test("the history chord fires from a text field on mac only", () => {
    const fromField = (isMac: boolean, e: KeyboardEvent, value: string) => {
      const catalog = createShortcutCatalog(SHORTCUTS, { isMac });
      return catalog.shortcuts.find(
        (d) => catalog.matchShortcut(e, d) && inputGuardBypass(d, { tagName: "TEXTAREA", value }),
      )?.action;
    };
    for (const value of ["", "draft"]) {
      expect(fromField(true, keyEvent({ metaKey: true, altKey: true }), value)).toBe("ui.undoHistory");
      expect(fromField(false, keyEvent({ ctrlKey: true, altKey: true }), value)).toBeUndefined();
      expect(fromField(false, keyEvent({ key: "ż", ctrlKey: true, altKey: true }), value)).toBeUndefined();
    }
  });

  test("undo and redo never repeat while held", () => {
    const defs = SHORTCUTS.filter((d) => d.action === "ui.undo" || d.action === "ui.redo");
    expect(defs.length).toBe(4);
    for (const def of defs) expect(def.noRepeat).toBe(true);
  });

  test("the chords collide with no other action", () => {
    for (const isMac of [true, false]) {
      const collides = createShortcutCatalog(SHORTCUTS, { isMac })
        .conflicts()
        .filter((c) => c.defs.some((d) => UNDO_ACTIONS.includes(d.action)))
        .filter((c) => new Set(c.defs.map((d) => d.action)).size > 1);
      expect(collides).toEqual([]);
    }
  });
});

// A held toggle would flap the view (week, day, week...) or reopen what it
// just closed; a held step key walks on, as it should.
describe("Changes keys", () => {
  test("toggles fire once per press, steps repeat", () => {
    const changes = SHORTCUTS.filter((d) => d.when === "changes");
    const once = [...new Set(changes.filter((d) => d.noRepeat).map((d) => d.action))].sort();
    expect(once).toEqual([
      "changes.branches", "changes.copyLink", "changes.evidence", "changes.filter", "changes.mode",
      "changes.open", "changes.risks", "changes.today", "changes.waiting",
    ]);
    for (const action of ["changes.next", "changes.prev", "changes.prevDay", "changes.nextDay"]) {
      expect(changes.filter((d) => d.action === action).every((d) => !d.noRepeat)).toBe(true);
    }
    // Both evidence bindings, e and enter.
    expect(changes.filter((d) => d.action === "changes.evidence").every((d) => d.noRepeat)).toBe(true);
  });
});
