import { test, expect, describe } from "bun:test";
import { KeyEngine } from "./engine";
import { createShortcutCatalog, type ShortcutDef } from "./catalog";
import { engineCheatSheet, catalogCheatSheet } from "./cheatsheet";

// Both keyboard layers describe their live keymap as the same entry shape, so
// one help overlay renders either.

describe("engineCheatSheet", () => {
  test("renders active bindings for a context, sequences as ordered chords", () => {
    const engine = new KeyEngine();
    engine.register([
      { keys: "g i", context: "global", description: "Go to inbox", group: "Navigate", handler: () => {} },
      { keys: "j", context: "list", description: "Down", group: "List", handler: () => {} },
      { keys: "x", context: "thread", description: "Elsewhere", group: "Thread", handler: () => {} },
      { keys: "J", context: "list", description: "Internal", group: "List", handler: () => {}, hidden: true },
    ]);

    const entries = engineCheatSheet(engine, "list");
    expect(entries).toEqual([
      { keys: [["g"], ["i"]], description: "Go to inbox", group: "Navigate" },
      { keys: [["j"]], description: "Down", group: "List" },
    ]);
  });
});

describe("catalogCheatSheet", () => {
  type Action = "next" | "down";
  const DEFS: ShortcutDef<Action>[] = [
    { key: "ctrl+j", action: "next", skipInputCheck: true, description: "Next session" },
    { key: "j", action: "down", when: "list", description: "Move down" },
  ];
  const catalog = createShortcutCatalog(DEFS, { isMac: false });

  test("global and context-tagged bindings share the entry shape", () => {
    expect(catalogCheatSheet(catalog)).toEqual([
      { keys: [["Ctrl", "J"]], description: "Next session", group: "global" },
    ]);
    expect(catalogCheatSheet(catalog, "list")).toEqual([
      { keys: [["J"]], description: "Move down", group: "list" },
    ]);
  });
});
