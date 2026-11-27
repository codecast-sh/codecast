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

/** The hex behind a colour as web's vocabulary tables write it: a CSS value
 *  (solColor's forms, a `--sol-class-*` token, `color-mix(in srgb, a p%, b)`)
 *  or a Tailwind text class (`text-sol-yellow`, `text-[color:…]`). */
export function webColor(value: string | undefined | null, t: Palette, fallback: string = t.textMuted): string {
  if (!value) return fallback;
  const v = value.trim();
  const named = /(?:^|\s)text-sol-([a-z-]+)(?:\s|$)/.exec(v);
  if (named) return solColor(`var(--sol-${named[1]})`, t, fallback);
  const arbitrary = /(?:^|\s)text-\[color:(.+?)\](?:\s|$)/.exec(v);
  const css = (arbitrary ? arbitrary[1].replace(/_/g, ' ') : v).replace(/--sol-class-/g, '--sol-');
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(css);
  if (mix) {
    const b = mix[3].trim();
    return mixColor(solColor(mix[1], t, fallback), Number(mix[2]), b === 'transparent' ? b : solColor(b, t, fallback));
  }
  return solColor(css, t, fallback);
}

function rgbOf(hex: string): [number, number, number] | null {
  const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim()) ?? /^#([\da-f])([\da-f])([\da-f])$/i.exec(hex.trim());
  if (!m) return null;
  return [m[1], m[2], m[3]].map((c) => parseInt(c.length === 1 ? c + c : c, 16)) as [number, number, number];
}

/** CSS `color-mix(in srgb, a pct%, b)` for two hex colours, as a hex native
 *  views can paint. `b` may be 'transparent', which gives `a` at that alpha. */
export function mixColor(a: string, pct: number, b: string): string {
  const p = Math.min(100, Math.max(0, pct)) / 100;
  const x = rgbOf(a);
  if (!x) return a;
  if (b === 'transparent') return `rgba(${x[0]}, ${x[1]}, ${x[2]}, ${p})`;
  const y = rgbOf(b);
  if (!y) return a;
  const hex = (i: number) => Math.round(x[i] * p + y[i] * (1 - p)).toString(16).padStart(2, '0');
  return `#${hex(0)}${hex(1)}${hex(2)}`;
}
