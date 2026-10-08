import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_COLOR_TOKENS, THEME_FONT_TOKENS, themeErrors } from "./theme";
import { validateManifest } from "./mods";

describe("color themes in a mod manifest", () => {
  test("a good theme passes, in one mode or both", () => {
    const check = validateManifest({
      name: "nord",
      themes: [
        { id: "nord", title: "Nord", light: { bg: "#eceff4", text: "#2e3440", blue: "#5e81ac" }, dark: { bg: "#2e3440", text: "#eceff4", "font-mono": '"Iosevka", monospace' } },
        { id: "night", title: "Night", dark: { bg: "#000" } },
      ],
    });
    expect(check.ok).toBe(true);
  });

  test("refuses anything but hex colors and plain font lists", () => {
    const errors = themeErrors([
      { id: "x", title: "X", light: { bg: "red", text: "url(https://evil.example/a)", "font-ui": "a; } body { display: none" } },
    ]);
    expect(errors).toHaveLength(3);
  });

  test("refuses unknown tokens, keys, ids and a theme with no palette", () => {
    expect(themeErrors([{ id: "x", title: "X", light: { "sidebar-bg": "#fff" } }])[0]).toContain("not a theme token");
    expect(themeErrors([{ id: "x", title: "X", css: "", light: {} }])[0]).toContain('unknown key "css"');
    expect(themeErrors([{ id: "X Y", title: "X" }])[0]).toContain("must be lowercase");
    expect(themeErrors([{ id: "x", title: "X" }])[0]).toContain("needs a light or a dark palette");
    expect(themeErrors([{ id: "x", title: "X", dark: {} }, { id: "x", title: "X", dark: {} }])[0]).toContain("declared twice");
  });

  test("the authoring types name every token, so editors autocomplete the whole contract", () => {
    const types = readFileSync(join(import.meta.dir, "..", "mods", "authoring.d.ts"), "utf8");
    const block = types.slice(types.indexOf("export type ThemePalette"), types.indexOf("export type Manifest"));
    for (const token of [...THEME_COLOR_TOKENS, ...THEME_FONT_TOKENS]) expect(block).toContain(`"${token}"`);
  });
});
