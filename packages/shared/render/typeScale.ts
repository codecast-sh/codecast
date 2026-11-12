// The type scale the Modern style sets words in: seven steps, the same values
// as the web's tailwind.config.ts fontSize (text-mark ... text-display) and
// the --fs-* variables in packages/web/app/globals.css. 12 is the floor for
// words; mark (11) is for glyph-like marks only: counts in small badges, key
// caps, avatar initials and labels set in capitals.
//
// The web can read these values from here later; today they are equal by
// hand, and typeScale.test.ts holds the web's two copies to them.

export const TYPE_SCALE = {
  mark: { size: 11, lineHeight: 14 },
  meta: { size: 12, lineHeight: 16 },
  ui: { size: 13, lineHeight: 18 },
  body: { size: 14, lineHeight: 20 },
  read: { size: 15, lineHeight: 24 },
  title: { size: 18, lineHeight: 24 },
  display: { size: 24, lineHeight: 30 },
} as const;

export type TypeStep = keyof typeof TYPE_SCALE;

/** The smallest size for words, and for capitals and glyph-like marks. */
export const WORD_FLOOR = TYPE_SCALE.meta.size;
export const MARK_FLOOR = TYPE_SCALE.mark.size;

/**
 * A text size held to the floor: under 12 rises to 12, except text set in
 * capitals, which may sit at 11. A line height set beside it grows by the same
 * ratio, so a raised line keeps its leading instead of clipping. Sizes at or
 * above the floor, and absent sizes, pass through unchanged.
 */
export function floorTextSize(
  fontSize: number | undefined,
  lineHeight: number | undefined,
  caps: boolean,
): { fontSize?: number; lineHeight?: number } {
  if (typeof fontSize !== "number") return { fontSize, lineHeight };
  const floor = caps ? MARK_FLOOR : WORD_FLOOR;
  if (fontSize >= floor) return { fontSize, lineHeight };
  const raised = typeof lineHeight === "number" ? Math.round((lineHeight * floor) / fontSize) : lineHeight;
  return { fontSize: floor, lineHeight: raised };
}
