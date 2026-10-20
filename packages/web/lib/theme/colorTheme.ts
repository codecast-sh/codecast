// Color themes on the page: codecast's own (builtinThemes.ts) and the ones the
// viewer's mods offer, and putting the chosen one's variables on the root.
// Inline on <html>, like the bubble hue, so a theme outranks every stylesheet
// rule (light, dark, Minimal) without a specificity contest. index.html
// replays the cached variables before the first paint, so a reload never
// flashes another palette; with nothing cached it paints the default theme
// (plugins/colorThemeBoot.ts).

import { themeKey, type ModTheme, type ThemeMode } from "@codecast/shared/contracts/theme";
import type { ModRow } from "../mods/host";
import { modIsActive } from "../mods/active";
export { themeVarsByMode } from "./themeVars";
import { BUILTIN_THEMES, BUILTIN_THEME_SOURCE, DEFAULT_THEME } from "./builtinThemes";

/** localStorage: `{ light: vars, dark: vars }` of the chosen theme, read by index.html. */
export const COLOR_THEME_CACHE_KEY = "codecast-color-theme";
/** The names of the variables last put on the root, so the next theme clears them. */
const APPLIED_ATTR = "data-theme-vars";

/** `modTitle` is the mod that declares the theme; codecast's own have none. */
export type ThemeChoice = { key: string; modTitle?: string; theme: ModTheme };

export const DEFAULT_COLOR_THEME = themeKey(BUILTIN_THEME_SOURCE, DEFAULT_THEME.id);
export const ORIGINAL_COLOR_THEME = themeKey(BUILTIN_THEME_SOURCE, "original");

/** The stored choice (clientState.ui.color_theme), or the default when there is none. */
export function resolveColorThemeKey(stored: string | null | undefined): string {
  return stored || DEFAULT_COLOR_THEME;
}

const BUILTIN_CHOICES: ThemeChoice[] = BUILTIN_THEMES.map((theme) => ({ key: themeKey(BUILTIN_THEME_SOURCE, theme.id), theme }));

/** Codecast's themes, then every theme the viewer's active mods declare, in mod order. */
export function availableThemes(rows: readonly ModRow[], installed: readonly string[]): ThemeChoice[] {
  return [
    ...BUILTIN_CHOICES,
    ...rows
      .filter((r) => modIsActive(r, installed))
      .flatMap((r) => (r.manifest.themes ?? []).map((theme) => ({ key: themeKey(r.name, theme.id), modTitle: r.title || r.name, theme }))),
  ];
}

/** Puts `vars` on the root and takes off whatever the last call (or index.html) put there. */
export function applyThemeVars(vars: Record<string, string>): void {
  const root = document.documentElement;
  for (const name of (root.getAttribute(APPLIED_ATTR) ?? "").split(" ")) {
    if (name && !(name in vars)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  const names = Object.keys(vars);
  if (names.length) root.setAttribute(APPLIED_ATTR, names.join(" "));
  else root.removeAttribute(APPLIED_ATTR);
}

export function cacheThemeVars(byMode: Record<ThemeMode, Record<string, string>>): void {
  try {
    localStorage.setItem(COLOR_THEME_CACHE_KEY, JSON.stringify(byMode));
  } catch {}
}
