// xterm theme derived from the app's --sol-* tokens.
//
// Solarized was born as a terminal palette: the sixteen ANSI slots map onto
// the accent tokens plus the fixed base ramp, and the palette is the same in
// light and dark — only background/foreground swap, which the tokens already
// encode. Reading computed styles (instead of hardcoding) keeps the terminal
// in lockstep with any future token retune.

import type { ITheme } from "@xterm/xterm";
import { cssVar, isDarkTheme } from "../solTheme";
import { isModernStyle } from "../visualStyle";
import { COLOR_THEME_CACHE_KEY } from "../theme/colorTheme";
import { DEFAULT_THEME } from "../theme/builtinThemes";
import { themeVars } from "../theme/themeVars";

// Re-exported so terminal callers keep importing theme concerns from one place.
export { isDarkTheme, observeTheme } from "../solTheme";

// Canonical Solarized base ramp — fallbacks when a token is missing.
const BASE = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base1: "#93a1a1",
  base2: "#eee8d5",
  base3: "#fdf6e3",
};

/**
 * In Modern a terminal is a dark island on a light page: painted on the page's
 * own background it could not be told from the transcript beside it. Returns
 * the painted theme's dark variables (ThemeProvider caches both modes), or null
 * when the terminal follows the page (Classic, Minimal, and Modern in dark).
 */
export function terminalIslandVars(): Record<string, string> | null {
  if (!isModernStyle() || isDarkTheme()) return null;
  try {
    const cached = JSON.parse(localStorage.getItem(COLOR_THEME_CACHE_KEY) || "null");
    if (cached?.dark?.["--sol-bg"]) return cached.dark as Record<string, string>;
  } catch {}
  return themeVars(DEFAULT_THEME.dark, "dark");
}

/** A #rrggbb colour mixed toward black; anything else is returned as given. */
function deepen(color: string, by: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - by)).toString(16).padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

export function buildTerminalTheme(): ITheme {
  const root = getComputedStyle(document.documentElement);
  const island = terminalIslandVars();
  // Reads the island's variable when there is one, the root's otherwise.
  const styles = { getPropertyValue: (name: string) => island?.[name] ?? root.getPropertyValue(name) } as CSSStyleDeclaration;
  const dark = island ? true : isDarkTheme();
  const pageBg = cssVar(styles, "--sol-bg", dark ? BASE.base03 : BASE.base3);
  // Modern in dark: a step below the page, for the same reason as the island.
  const bg = !island && dark && isModernStyle() ? deepen(pageBg, 0.35) : pageBg;
  const fg = cssVar(styles, "--sol-text", dark ? BASE.base0 : BASE.base02);
  const blue = cssVar(styles, "--sol-blue", "#268bd2");

  return {
    background: bg,
    foreground: fg,
    cursor: cssVar(styles, "--sol-orange", "#cb4b16"),
    cursorAccent: bg,
    selectionBackground: `${blue}55`,
    selectionInactiveBackground: `${blue}2e`,
    black: BASE.base02,
    red: cssVar(styles, "--sol-red", "#dc322f"),
    green: cssVar(styles, "--sol-green", "#859900"),
    yellow: cssVar(styles, "--sol-yellow", "#b58900"),
    blue,
    magenta: cssVar(styles, "--sol-magenta", "#d33682"),
    cyan: cssVar(styles, "--sol-cyan", "#2aa198"),
    white: BASE.base2,
    brightBlack: BASE.base01,
    brightRed: cssVar(styles, "--sol-orange", "#cb4b16"),
    brightGreen: BASE.base01,
    brightYellow: BASE.base00,
    brightBlue: BASE.base0,
    brightMagenta: cssVar(styles, "--sol-violet", "#6c71c4"),
    brightCyan: BASE.base1,
    brightWhite: BASE.base3,
  };
}
