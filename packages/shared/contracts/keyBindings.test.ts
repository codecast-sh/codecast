import { describe, expect, test } from "bun:test";
import {
  actionsForChord,
  applyKeyBindings,
  comboIdentity,
  currentChords,
  defaultChords,
  findConflicts,
  parseChord,
  reservedReason,
  resolveAction,
  resolveChord,
  setActionChords,
  comboToAccelerator,
  desktopMenuKeys,
} from "./keyBindings";
import { SHORTCUTS } from "./shortcutCatalog";

const chord = (s: string) => {
  const r = parseChord(s);
  if (!r.ok) throw new Error(r.error);
  return r.chord;
};

describe("parseChord", () => {
  test("reads the ways people write chords", () => {
    expect(chord("cmd+shift+k")).toBe("mod+shift+k");
    expect(chord("Ctrl-J")).toBe("ctrl+j");
    expect(chord("⌘⇧K")).toBe("mod+shift+k");
    expect(chord("opt+enter")).toBe("alt+enter");
    expect(chord("shift+alt+ctrl+backspace")).toBe("ctrl+alt+shift+backspace");
    expect(chord("ctrl++")).toBe("ctrl++");
    expect(chord("ctrl+-")).toBe("ctrl+-");
    expect(chord("j")).toBe("j");
    expect(chord("esc")).toBe("escape");
    expect(chord("ctrl+[")).toBe("ctrl+[");
    expect(chord("F5")).toBe("f5");
  });

  test("Shift that changes the key is spelled as the glyph", () => {
    expect(chord("shift+/")).toBe("?");
    expect(chord("ctrl+shift+[")).toBe("ctrl+shift+{");
  });

  test("refuses what cannot be a chord", () => {
    expect(parseChord("ctrl+shift").ok).toBe(false);
    expect(parseChord("ctrl+j+k").ok).toBe(false);
    expect(parseChord("ctrl+banana").ok).toBe(false);
    expect(parseChord("").ok).toBe(false);
  });
});

test("mod resolves per platform", () => {
  expect(resolveChord("mod+shift+k", true)).toBe("meta+shift+k");
  expect(resolveChord("mod+shift+k", false)).toBe("ctrl+shift+k");
  expect(resolveChord("ctrl+mod+k", false)).toBe("ctrl+k");
});

test("combo identity ignores Shift on a shifted glyph", () => {
  expect(comboIdentity("ctrl+shift+{")).toBe(comboIdentity("ctrl+{"));
  expect(comboIdentity("shift+ctrl+j")).toBe("ctrl+shift+j");
});

describe("applyKeyBindings", () => {
  test("an override replaces every default chord and goes first", () => {
    const live = applyKeyBindings(SHORTCUTS, [{ action: "tab.prev", keys: ["alt+h"] }], true);
    const defs = live.filter((d) => d.action === "tab.prev");
    expect(defs.map((d) => d.key)).toEqual(["alt+h"]);
    expect(live[0].action).toBe("tab.prev");
    expect(defs[0].skipInputCheck).toBe(true);
  });

  test("an empty override unbinds", () => {
    const live = applyKeyBindings(SHORTCUTS, [{ action: "session.next", keys: [] }], true);
    expect(live.some((d) => d.action === "session.next")).toBe(false);
  });

  test("a chord that types text never fires from a field", () => {
    const live = applyKeyBindings(SHORTCUTS, [{ action: "session.next", keys: ["j"] }], true);
    expect(live.find((d) => d.action === "session.next")!.skipInputCheck).toBeUndefined();
  });

  test("unknown actions and fixed defs are ignored", () => {
    const fixed = SHORTCUTS.find((d) => d.fixed);
    const overrides = [{ action: "nope.nothing", keys: ["ctrl+q"] }, ...(fixed ? [{ action: fixed.action, keys: ["ctrl+q"] }] : [])];
    expect(applyKeyBindings(SHORTCUTS, overrides, true)).toBe(SHORTCUTS);
  });
});

describe("conflicts", () => {
  test("a global chord collides with a context one", () => {
    const hits = findConflicts(SHORTCUTS, "session.next", "ctrl+k", true);
    expect(hits.map((h) => h.action)).toContain("session.prev");
  });

  test("two different contexts do not collide", () => {
    const hits = findConflicts(SHORTCUTS, "list.down", "d", true);
    expect(hits.map((h) => h.action)).not.toContain("conv.toggleDiff");
  });

  test("actionsForChord finds the owner", () => {
    expect(actionsForChord(SHORTCUTS, "ctrl+j", true).map((d) => d.action)).toEqual(["session.next"]);
  });
});

describe("setActionChords", () => {
  test("setting the defaults back drops the override", () => {
    const once = setActionChords([], "session.next", ["ctrl+h"], true);
    expect(once).toEqual([{ action: "session.next", keys: ["ctrl+h"] }]);
    expect(setActionChords(once, "session.next", defaultChords("session.next", true), true)).toEqual([]);
  });

  test("steal takes the chord from the other action", () => {
    const list = setActionChords([], "session.next", ["ctrl+k"], true, ["session.prev"]);
    expect(currentChords(list, "session.prev", true)).toEqual([]);
    expect(currentChords(list, "session.next", true)).toEqual(["ctrl+k"]);
  });

  test("defaults collapse the two spellings of one press", () => {
    expect(defaultChords("tab.prev", true)).toEqual(["meta+shift+["]);
  });
});

test("resolveAction takes ids and words", () => {
  expect(resolveAction("session.next")).toEqual({ ok: true, action: "session.next" });
  expect(resolveAction("next session")).toEqual({ ok: true, action: "session.next" });
  const r = resolveAction("session");
  expect(r.ok).toBe(false);
});

test("reserved chords", () => {
  expect(reservedReason("mod+q", true, true)).toBe("macOS keeps this chord");
  expect(reservedReason("mod+t", true, false)).toContain("browser");
  expect(reservedReason("mod+t", true, true)).toBeNull();
});

describe("desktop menu keys", () => {
  test("combos become accelerators", () => {
    expect(comboToAccelerator("meta+shift+k", true)).toBe("Command+Shift+K");
    expect(comboToAccelerator("alt+arrowleft", false)).toBe("Alt+Left");
    expect(comboToAccelerator("meta+,", true)).toBe("Command+,");
    expect(comboToAccelerator("?", true)).toBeNull();
  });

  test("only what the person changed reaches the menu", () => {
    expect(desktopMenuKeys([], SHORTCUTS, true)).toBeNull();
    const overrides = [{ action: "nav.back", keys: ["mod+shift+b"] }, { action: "session.next", keys: ["mod+,"] }];
    const live = applyKeyBindings(SHORTCUTS, overrides, true);
    expect(desktopMenuKeys(overrides, live, true)).toEqual({ keys: { "nav.back": ["Command+Shift+B"] }, claimed: ["Command+,"] });
  });
});
