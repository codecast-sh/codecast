// A registered mark: one meaning Codecast draws as a glyph, often without its
// word. The id names the meaning, not the glyph: two glyphs drawn under one id
// are two pictures of the same thing, and the icon legend lists them on one row.
export type MarkGroup = "Priorities pass" | "Sessions" | "Inbox" | "Priorities" | "Work";

export type MarkDef = {
  id: string;
  /** The mark's word, as the legend and its hover name it. */
  name: string;
  /** What it means, in a few words. */
  meaning: string;
  group: MarkGroup;
  /** Drawn from data, so every instance differs; the legend shows the first one seen. */
  oneGlyph?: true;
};
