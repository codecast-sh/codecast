// --sol-* tokens bridged from the app theme. Shared web modules name colours
// as CSS variables ("var(--sol-yellow)"); a canvas needs them as CSS and a
// native view needs the hex, so both read this one table.
import type { Palette } from '@/constants/Theme';

export function solTokens(t: Palette): Record<string, string> {
  return {
    '--sol-bg': t.bg,
    '--sol-bg-alt': t.bgAlt,
    '--sol-bg-highlight': t.bgHighlight,
    '--sol-card': t.cardBg,
    '--sol-border': t.border,
    '--sol-border-light': t.borderLight,
    '--sol-text': t.text,
    '--sol-text-secondary': t.textSecondary,
    '--sol-text-muted': t.textMuted,
    '--sol-text-dim': t.textDim,
    '--sol-accent': t.accent,
    '--sol-blue': t.blue,
    '--sol-cyan': t.cyan,
    '--sol-green': t.green,
    '--sol-red': t.red,
    '--sol-orange': t.orange,
    '--sol-violet': t.violet,
    '--sol-magenta': t.magenta,
    '--sol-yellow': t.accent,
  };
}

/** The hex behind a web colour value. A plain colour passes through; a value
 *  a native view cannot paint (color-mix, an unknown token) reads as `fallback`. */
export function solColor(value: string | undefined | null, t: Palette, fallback: string = t.textMuted): string {
  if (!value) return fallback;
  const token = /^var\((--sol-[a-z-]+)\)$/.exec(value.trim());
  if (token) return solTokens(t)[token[1]] ?? fallback;
  return /^(#|rgb)/.test(value) ? value : fallback;
}
