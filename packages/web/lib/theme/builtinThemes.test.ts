import { describe, expect, test } from "bun:test";
import { THEME_COLOR_TOKENS, themeErrors } from "@codecast/shared/contracts/theme";
import { BUILTIN_THEMES, DEFAULT_THEME } from "./builtinThemes";
import { availableThemes, DEFAULT_COLOR_THEME, ORIGINAL_COLOR_THEME, resolveColorThemeKey, themeVarsByMode } from "./colorTheme";
import { colorThemeBootPlugin, DEFAULT_THEME_GLOBAL } from "../../plugins/colorThemeBoot";

describe("built-in color themes", () => {
  test("every one is a valid theme and every painted mode sets every color token", () => {
    expect(themeErrors(BUILTIN_THEMES.filter((t) => t.light || t.dark))).toEqual([]);
    for (const t of BUILTIN_THEMES) for (const mode of ["light", "dark"] as const) {
      if (t[mode]) expect(Object.keys(t[mode]!).sort()).toEqual([...THEME_COLOR_TOKENS].sort());
    }
  });

  test("a person who never chose gets Verdigris; Original sets no variables", () => {
    expect(DEFAULT_THEME.id).toBe("verdigris");
    expect(resolveColorThemeKey(undefined)).toBe(DEFAULT_COLOR_THEME);
    expect(resolveColorThemeKey("")).toBe(DEFAULT_COLOR_THEME);
    const original = availableThemes([], []).find((c) => c.key === ORIGINAL_COLOR_THEME)!;
    expect(themeVarsByMode(original.theme)).toEqual({ light: {}, dark: {} });
  });

  test("the boot plugin inlines the default's variables, and the prerender's strip pattern removes them", () => {
    const hook = colorThemeBootPlugin().transformIndexHtml as { handler: () => { children: string }[] };
    const script = hook.handler()[0]!.children;
    expect(script.startsWith(`window.${DEFAULT_THEME_GLOBAL}=`)).toBe(true);
    expect(JSON.parse(script.slice(script.indexOf("=") + 1))).toEqual(themeVarsByMode(DEFAULT_THEME));
    const html = `<head><script>${script}</script>\n<title>x</title>`;
    expect(html.replace(/<script>window\.__ccDefaultColorTheme=[^<]*<\/script>\s*/, "")).toBe("<head><title>x</title>");
  });
});
