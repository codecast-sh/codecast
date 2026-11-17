// Settings › Appearance › Text size: how large conversation text and the
// composers set on this phone. Small is the size the app shipped with;
// Medium, the default, and Large step up from it. The choice lives in
// `ui.mobile_text_size`, kept per device.
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
