// xterm theme derived from the app's --sol-* tokens.
//
// Solarized was born as a terminal palette: the sixteen ANSI slots map onto
// the accent tokens plus the fixed base ramp, and the palette is the same in
// light and dark — only background/foreground swap, which the tokens already
// encode. Reading computed styles (instead of hardcoding) keeps the terminal
// in lockstep with any future token retune.

import type { ITheme } from "@xterm/xterm";

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

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = styles.getPropertyValue(name).trim();
  return v || fallback;
}

export function isDarkTheme(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function buildTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const dark = isDarkTheme();
  const bg = cssVar(styles, "--sol-bg", dark ? BASE.base03 : BASE.base3);
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

/** Re-run `apply` whenever the html class flips between light/dark. */
export function observeTheme(apply: () => void): () => void {
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
