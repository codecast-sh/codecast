// The letters and the colour a name gets when there is no picture of it.
//
// One answer for every surface that draws a name as a tile: a teammate's
// avatar fallback and a channel's monogram in the narrow rail must agree on
// what "Ada Lovelace" and "chat-smoke" look like, or the same thing wears two
// faces on one screen.

const HUES = ["#268bd2", "#2aa198", "#859900", "#b58900", "#cb4b16", "#d33682", "#6c71c4"];

/** A stable colour for a name: the same name is the same hue everywhere. */
export function hueFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

/** "Ada Lovelace" → "AL", "ada" → "AD". Two letters read as a person where one
 *  reads as a bullet, which matters once faces overlap in a stack. Hyphens,
 *  underscores and dots split words too, so "chat-smoke" is "CS" rather than
 *  "CH" — a channel name is words joined by punctuation, not one word. */
export function initials(name: string, letters: 1 | 2): string {
  const parts = (name || "").trim().split(/[\s\-_.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (letters === 1) return parts[0].charAt(0).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
