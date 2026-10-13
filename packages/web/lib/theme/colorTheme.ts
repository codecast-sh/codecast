// Color themes on the page: which ones the viewer's mods offer, and putting
// the chosen one's variables on the root. Inline on <html>, like the bubble
// hue, so a theme outranks every stylesheet rule (light, dark, Minimal)
// without a specificity contest. index.html replays the cached variables
// before the first paint, so a reload never flashes the default palette.

import { themeKey, type ModTheme, type ThemeMode } from "@codecast/shared/contracts/theme";
import type { ModRow } from "../mods/host";
import { modIsActive } from "../mods/active";
import { themeVars } from "./themeVars";

/** localStorage: `{ light: vars, dark: vars }` of the chosen theme, read by index.html. */
export const COLOR_THEME_CACHE_KEY = "codecast-color-theme";
/** The names of the variables last put on the root, so the next theme clears them. */
const APPLIED_ATTR = "data-theme-vars";

export type ThemeChoice = { key: string; modTitle: string; theme: ModTheme };

/** Every theme the viewer's active mods declare, in mod order. */
export function availableThemes(rows: readonly ModRow[], installed: readonly string[]): ThemeChoice[] {
  return rows
    .filter((r) => modIsActive(r, installed))
    .flatMap((r) => (r.manifest.themes ?? []).map((theme) => ({ key: themeKey(r.name, theme.id), modTitle: r.title || r.name, theme })));
}

/** Both modes' variables for a theme, or null for codecast's own palette. */
export function themeVarsByMode(theme: ModTheme | undefined): Record<ThemeMode, Record<string, string>> | null {
  if (!theme) return null;
  return { light: themeVars(theme.light, "light"), dark: themeVars(theme.dark, "dark") };
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

export function cacheThemeVars(byMode: Record<ThemeMode, Record<string, string>> | null): void {
  try {
    if (byMode) localStorage.setItem(COLOR_THEME_CACHE_KEY, JSON.stringify(byMode));
    else localStorage.removeItem(COLOR_THEME_CACHE_KEY);
  } catch {}
}
