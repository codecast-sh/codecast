// The one place a color theme's tokens (shared/contracts/theme.ts) meet the
// app's internal CSS variables. The token names are public and stable; the
// variables here are ours, so renaming or adding an internal variable means
// editing this file and nothing a theme author wrote.

import type { ThemeColorToken, ThemeMode, ThemePalette, ThemeToken } from "@codecast/shared/contracts/theme";
import { ACCENT_MIX, ACCENT_SCALES, NEUTRAL_INK, NEUTRAL_SCALES, SHADES, scaleVar } from "./scales";

const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

/** The stylesheet variables each token sets: its value, or a shade derived from it. */
const DIRECT: Record<ThemeToken, (string | [string, (value: string) => string])[]> = {
  bg: ["--sol-bg"],
  "bg-alt": ["--sol-bg-alt", ["--sol-bg-highlight", (v) => mix("var(--sol-text)", 6, v)], ["--sol-bg-inset", (v) => mix("var(--sol-bg)", 40, v)]],
  card: ["--sol-card", ["--sol-card-hover", (v) => mix("var(--sol-text)", 3, v)]],
  border: ["--sol-border"],
  text: ["--sol-text", ["--sol-text-secondary", (v) => mix(v, 88, "var(--sol-bg)")]],
  "text-muted": ["--sol-text-muted", "--sol-text-muted0"],
  "text-dim": ["--sol-text-dim"],
  link: ["--sol-link"],
  red: ["--sol-red", "--sol-class-red"],
  orange: ["--sol-orange", "--sol-class-orange"],
  amber: ["--sol-amber", "--sol-class-amber"],
  yellow: ["--sol-yellow", "--sol-class-yellow"],
  green: ["--sol-green", "--sol-class-green"],
  cyan: ["--sol-cyan", "--sol-class-cyan"],
  blue: ["--sol-blue", "--sol-class-blue"],
  violet: ["--sol-violet", "--sol-class-violet"],
  magenta: ["--sol-magenta", "--sol-class-magenta"],
  "font-ui": ["--font-ui"],
  "font-mono": ["--font-mono"],
};

/** The shadcn variables (`bg-background`, `text-muted-foreground`), which hold bare HSL triplets. */
const SHADCN: Record<string, ThemeColorToken> = {
  "--background": "bg", "--foreground": "text",
  "--card": "card", "--card-foreground": "text",
  "--popover": "card", "--popover-foreground": "text",
  "--primary": "text", "--primary-foreground": "bg",
  "--secondary": "bg-alt", "--secondary-foreground": "text",
  "--muted": "bg-alt", "--muted-foreground": "text-muted",
  "--accent": "bg-alt", "--accent-foreground": "text",
  "--border": "border", "--input": "border", "--ring": "text-muted",
  "--destructive": "red",
};

/** "#268bd2" -> "205 69% 49%", the form the shadcn variables hold. */
export function hexToHslTriplet(hex: string): string {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let hue = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return `${round(hue)} ${round(s * 100)}% ${round(l * 100)}%`;
}

/**
 * Every variable a palette sets in one mode. Paper is the light end of the
 * neutrals and ink the dark end: bg and text, swapped in dark mode, so
 * `text-zinc-900` stays dark and `bg-amber-50` stays pale as Tailwind meant.
 */
export function themeVars(palette: ThemePalette | undefined, mode: ThemeMode): Record<string, string> {
  if (!palette) return {};
  const vars: Record<string, string> = {};
  for (const [token, value] of Object.entries(palette) as [ThemeToken, string][]) {
    for (const v of DIRECT[token] ?? []) {
      if (typeof v === "string") vars[v] = value;
      else vars[v[0]] = v[1](value);
    }
  }
  for (const [v, token] of Object.entries(SHADCN)) if (palette[token]) vars[v] = hexToHslTriplet(palette[token]!);

  const paper = mode === "light" ? "var(--sol-bg)" : "var(--sol-text)";
  const ink = mode === "light" ? "var(--sol-text)" : "var(--sol-bg)";
  if (palette.bg || palette.text) {
    for (const scale of NEUTRAL_SCALES) for (const n of SHADES) {
      vars[scaleVar(scale, n)] = mix(ink, NEUTRAL_INK[n], paper);
    }
  }
  for (const [scale, token] of Object.entries(ACCENT_SCALES)) {
    const accent = palette[token];
    if (!accent) continue;
    for (const n of SHADES) {
      const { toward, pct } = ACCENT_MIX[n];
      vars[scaleVar(scale, n)] = pct === 100 ? accent : toward === "paper"
        ? mix(accent, pct, paper)
        : mix(accent, 100 - pct, ink);
    }
  }
  return vars;
}
