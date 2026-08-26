import { test, expect, describe } from "bun:test";
import {
  createShortcutCatalog,
  inputGuardBypass,
  hasOpenModal,
  altChordDirection,
  type ShortcutDef,
} from "./catalog";

// Ported from the codecast donor suites (shortcuts/registry.test.ts and
// shortcuts/newSessionBindings.test.ts), generalized to fixture action ids.
// The app-specific halves — guards over codecast's own SHORTCUTS list and its
// inbox selection logic — stay in codecast beside its catalog.

type Action = "compose" | "create" | "stash" | "settings";

const DEFS: ShortcutDef<Action>[] = [
  { key: "ctrl+n", action: "compose", skipInputCheck: true, description: "Compose" },
  { key: "ctrl+alt+n", action: "create", skipInputCheck: true, description: "Create (full page)" },
  { key: "ctrl+backspace", action: "stash", skipInputCheck: "whenEmpty", description: "Stash" },
  { key: "ctrl+shift+,", mac: "meta+,", action: "settings", worksInModal: true, skipInputCheck: true, description: "Settings" },
];

const catalog = createShortcutCatalog(DEFS, { isMac: false });

// Mirror a dispatcher's resolution: first def that matches wins.
function resolveAction(e: Partial<KeyboardEvent>): Action | null {
  const ev = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...e } as KeyboardEvent;
  return DEFS.find((def) => catalog.matchShortcut(ev, def))?.action ?? null;
}

describe("matchShortcut", () => {
  test("a plain chord matches on e.key", () => {
    expect(resolveAction({ key: "n", code: "KeyN", ctrlKey: true })).toBe("compose");
  });

  test("an alt chord matches on e.key when the layout delivers the letter", () => {
    expect(resolveAction({ key: "n", code: "KeyN", ctrlKey: true, altKey: true })).toBe("create");
  });

  test("an alt chord matches via e.code where ⌥N is the tilde dead key (macOS)", () => {
    // What Chrome on macOS actually delivers for ⌃⌥N: the composed/dead glyph
    // in e.key, the physical key only in e.code.
    expect(resolveAction({ key: "Dead", code: "KeyN", ctrlKey: true, altKey: true })).toBe("create");
    expect(resolveAction({ key: "˜", code: "KeyN", ctrlKey: true, altKey: true })).toBe("create");
  });

  test("the e.code fallback never fires for a plain (no-Alt) chord", () => {
    // A chord with a mismatched e.key must NOT borrow the physical key — only
    // Alt chords get the fallback, so a layout that maps KeyN elsewhere wins.
    expect(resolveAction({ key: "j", code: "KeyN", ctrlKey: true })).not.toBe("compose");
  });

  test("a no-Alt chord never resolves to the alt variant", () => {
    expect(resolveAction({ key: "n", code: "KeyN", ctrlKey: true })).not.toBe("create");
  });

  test("the mac variant of a def wins on mac, the base key elsewhere", () => {
    const mac = createShortcutCatalog(DEFS, { isMac: true });
    const settingsDef = DEFS[3];
    const metaComma = { key: ",", code: "Comma", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
    expect(mac.matchShortcut(metaComma, settingsDef)).toBe(true);
    expect(catalog.matchShortcut(metaComma, settingsDef)).toBe(false);
  });
});

describe("inputGuardBypass", () => {
  const def = (skipInputCheck?: boolean | "whenEmpty"): ShortcutDef<Action> => ({
    key: "ctrl+backspace",
    action: "stash",
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
    // e.g. a review region: treated as an input by the dispatcher but has no
    // value/content notion, so the chord must not fire there.
    expect(inputGuardBypass(def("whenEmpty"), { tagName: "DIV" })).toBe(false);
    expect(inputGuardBypass(def("whenEmpty"), null)).toBe(false);
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

  // A dialog can host its own keyboard surface — chords inside it must keep
  // working. A modal that CONTAINS the handler's root doesn't block it; any
  // modal stacked elsewhere (a confirm dialog, settings) still does.
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
      // A host ref can be null for a beat before the surface mounts — fail
      // safe: stand down as if unhosted.
      expect(hasOpenModal(null)).toBe(true);
    } finally {
      delete (globalThis as any).document;
    }
  });
});

// A window-capture ⌥-chord router resolves keydowns through altChordDirection.
// Regression (codecast 4497dcc59): adding ⌥←/⌥→ to the router stole macOS word
// jump from a focused textarea. Horizontal ARROWS from an editable target must
// resolve to null; everything else keeps routing.
describe("altChordDirection", () => {
  const textarea = { tagName: "TEXTAREA" } as unknown as EventTarget;
  const body = { tagName: "BODY" } as unknown as EventTarget;
  const chord = (code: string, target: EventTarget, mods: Partial<KeyboardEvent> = {}) =>
    altChordDirection({ altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, code, target, ...mods });

  test("⌥←/⌥→ from a text caret is released (word jump), not routed", () => {
    expect(chord("ArrowLeft", textarea)).toBeNull();
    expect(chord("ArrowRight", textarea)).toBeNull();
  });

  test("⌥H/⌥L still cycle even from the caret", () => {
    expect(chord("KeyH", textarea)).toBe("left");
    expect(chord("KeyL", textarea)).toBe("right");
  });

  test("⌥←/⌥→ route when focus is outside a text field", () => {
    expect(chord("ArrowLeft", body)).toBe("left");
    expect(chord("ArrowRight", body)).toBe("right");
  });

  test("⌥↑/⌥↓ stay intercepted from the caret — they climb out of the input", () => {
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

describe("formatting", () => {
  test("formatShortcutParts renders words off mac, glyphs on mac", () => {
    const mac = createShortcutCatalog(DEFS, { isMac: true });
    expect(catalog.formatShortcutParts(DEFS[0])).toEqual(["Ctrl", "N"]);
    expect(mac.formatShortcutParts(DEFS[0])).toEqual(["⌃", "N"]);
    // The mac variant of a def is what mac renders.
    expect(mac.formatShortcutParts(DEFS[3])).toEqual(["⌘", ","]);
  });

  test("formatAcceleratorParts resolves CommandOrControl per platform", () => {
    const mac = createShortcutCatalog(DEFS, { isMac: true });
    expect(mac.formatAcceleratorParts("CommandOrControl+Shift+N")).toEqual(["⌘", "⇧", "N"]);
    expect(catalog.formatAcceleratorParts("CommandOrControl+Shift+N")).toEqual(["Ctrl", "Shift", "N"]);
  });

  test("formatShortcutLabel joins glyphs on mac, words with + elsewhere", () => {
    const mac = createShortcutCatalog(DEFS, { isMac: true });
    expect(catalog.formatShortcutLabel("compose")).toBe("Ctrl+N");
    expect(mac.formatShortcutLabel("compose")).toBe("⌃N");
    expect(catalog.formatShortcutLabel("missing" as Action)).toBeNull();
  });
});

describe("conflicts", () => {
  type C = "search" | "favorite" | "prevTab" | "openNote" | "findPage";

  test("two actions on one combo in one scope are reported; spellings and scopes separate", () => {
    // Modeled on the donor catalog: one chord deliberately shared by two
    // surfaces (decline semantics pick the winner), a second spelling of one
    // chord, and the same letter in two different contexts.
    const defs: ShortcutDef<C>[] = [
      { key: "ctrl+shift+f", action: "search", description: "Search files" },
      { key: "ctrl+shift+f", action: "favorite", when: "conversation", description: "Toggle favorite" },
      { key: "ctrl+shift+f", action: "findPage", description: "Find in page" },
      { key: "ctrl+shift+[", action: "prevTab", description: "Previous tab" },
      { key: "ctrl+shift+{", action: "prevTab", description: "Previous tab" },
    ];
    const c = createShortcutCatalog(defs, { isMac: false });
    const found = c.conflicts();
    expect(found.length).toBe(1);
    expect(found[0].combo).toBe("ctrl+shift+f");
    expect(found[0].when).toBeUndefined();
    expect(found[0].defs.map(d => d.action)).toEqual(["search", "findPage"]);
  });

  test("modifier order never hides a collision", () => {
    const defs: ShortcutDef<C>[] = [
      { key: "shift+ctrl+p", action: "search", description: "A" },
      { key: "ctrl+shift+p", action: "favorite", description: "B" },
    ];
    expect(createShortcutCatalog(defs, { isMac: false }).conflicts().length).toBe(1);
  });

  test("a mac variant collides only on the platform where it resolves", () => {
    const defs: ShortcutDef<C>[] = [
      { key: "ctrl+o", mac: "meta+o", action: "openNote", description: "Open note" },
      { key: "meta+o", action: "search", description: "Search" },
    ];
    expect(createShortcutCatalog(defs, { isMac: true }).conflicts().length).toBe(1);
    expect(createShortcutCatalog(defs, { isMac: false }).conflicts().length).toBe(0);
  });
});
