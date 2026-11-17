// Settings › Appearance › Text size: how large every text on this phone is
// set. Small is the size each style is written at; Medium, the default, and
// Large step up from it. The choice lives in `ui.mobile_text_size`, kept per
// device. The Themed Text and TextInput apply it (sizeStyle), so a screen
// never sizes its own text for it.
//
// No React Native here, so the sizing is tested directly (textSize.test.ts).

export type TextSize = 'small' | 'medium' | 'large';

export const TEXT_SIZES: readonly { key: TextSize; label: string }[] = [
  { key: 'small', label: 'Small' },
  { key: 'medium', label: 'Medium' },
  { key: 'large', label: 'Large' },
];

const STEP: Record<TextSize, number> = { small: 0, medium: 1.5, large: 3 };

export function resolveTextSize(value: unknown): TextSize {
  return value === 'small' || value === 'large' ? value : 'medium';
}

/** A Small size raised to the chosen step. The line height grows by the same
 *  ratio, so a raised line keeps its leading. */
export function sizedText(fontSize: number, lineHeight: number | undefined, size: TextSize): { fontSize: number; lineHeight?: number } {
  const next = fontSize + STEP[size];
  if (lineHeight === undefined) return { fontSize: next };
  return { fontSize: next, lineHeight: Math.round((lineHeight * next) / fontSize) };
}

/** A resolved text style raised to the chosen step. Only a size the style sets
 *  outright is raised: a nested Text that names none inherits its parent's,
 *  which is raised already. */
export function sizeStyle<T extends { fontSize?: number; lineHeight?: number }>(style: T, size: TextSize): T {
  if (STEP[size] === 0 || typeof style.fontSize !== 'number') return style;
  return { ...style, ...sizedText(style.fontSize, typeof style.lineHeight === 'number' ? style.lineHeight : undefined, size) };
}
