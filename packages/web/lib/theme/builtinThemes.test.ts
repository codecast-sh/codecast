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

  test("dim text stays readable: 4.5:1 on the page and 4:1 on a hovered row, muted a step above it", () => {
    // WCAG relative luminance; the hover ground is themeVars' --sol-bg-highlight
    // (6% text into bg-alt). Dim ink carries timestamps, counts and hints app-wide.
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const off: string[] = [];
    for (const t of BUILTIN_THEMES) for (const mode of ["light", "dark"] as const) {
      const p = t[mode];
      if (!p) continue;
      const [bg, alt, text, dim, muted] = [p.bg!, p["bg-alt"]!, p.text!, p["text-dim"]!, p["text-muted"]!].map(rgb);
      const hover = alt!.map((v, i) => text![i]! * 0.06 + v * 0.94);
      if (ratio(dim!, bg!) < 4.5) off.push(`${t.id} ${mode} dim on bg ${ratio(dim!, bg!).toFixed(2)}`);
      if (ratio(dim!, hover) < 4) off.push(`${t.id} ${mode} dim on hover ${ratio(dim!, hover).toFixed(2)}`);
      if (ratio(muted!, bg!) <= ratio(dim!, bg!)) off.push(`${t.id} ${mode} muted is not above dim`);
    }
    expect(off).toEqual([]);
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
