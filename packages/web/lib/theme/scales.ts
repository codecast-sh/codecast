// Tailwind's color scales as CSS variables. tailwind.config.ts points every
// class of these scales (`text-zinc-500`, `bg-amber-100/50`) at `--tw-c-<scale>-<shade>`
// and defines each variable as Tailwind's own value, so the app paints
// exactly as it always did and nobody writes UI any differently. A color
// theme (themeVars.ts) rewrites the variables from its few tokens, which is
// how a theme reaches the thousand-odd palette classes without touching them.

import type { ThemeColorToken } from "@codecast/shared/contracts/theme";

/** The neutral scales, drawn between the theme's paper and ink. */
export const NEUTRAL_SCALES = ["slate", "gray", "zinc", "neutral", "stone"] as const;

/** Each hued scale and the theme accent that recolors it. */
export const ACCENT_SCALES = {
  red: "red", rose: "red",
  orange: "orange",
  amber: "amber",
  yellow: "yellow", lime: "yellow",
  green: "green", emerald: "green",
  teal: "cyan", cyan: "cyan",
  sky: "blue", blue: "blue",
  indigo: "violet", violet: "violet", purple: "violet",
  fuchsia: "magenta", pink: "magenta",
} as const satisfies Record<string, ThemeColorToken>;

export const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export type Shade = (typeof SHADES)[number];

export const SCALES = [...NEUTRAL_SCALES, ...Object.keys(ACCENT_SCALES)] as readonly string[];

export const scaleVar = (scale: string, shade: Shade): string => `--tw-c-${scale}-${shade}`;

/** How much ink a neutral shade holds over paper, in percent. */
export const NEUTRAL_INK: Record<Shade, number> = { 50: 3, 100: 6, 200: 12, 300: 22, 400: 40, 500: 55, 600: 68, 700: 78, 800: 87, 900: 93, 950: 97 };

/**
 * An accent shade: below 500 the accent over paper (its share in percent),
 * above it the accent under ink (ink's share). Mirrors Tailwind, whose
 * light shades are pale and dark shades deep in either mode.
 */
export const ACCENT_MIX: Record<Shade, { toward: "paper" | "ink"; pct: number }> = {
  50: { toward: "paper", pct: 8 }, 100: { toward: "paper", pct: 15 }, 200: { toward: "paper", pct: 30 },
  300: { toward: "paper", pct: 50 }, 400: { toward: "paper", pct: 75 }, 500: { toward: "paper", pct: 100 },
  600: { toward: "ink", pct: 15 }, 700: { toward: "ink", pct: 30 }, 800: { toward: "ink", pct: 45 },
  900: { toward: "ink", pct: 58 }, 950: { toward: "ink", pct: 72 },
};
