/**
 * Where a row's text starts: up to `budget` characters before the match, moved
 * forward to the start of a word so the row never opens mid-word, and never
 * into the indentation. A window with no word start shows no lead at all.
 */
export function leadStart(text: string, start: number, budget: number): number {
  const indent = /^\s*/.exec(text)![0].length;
  if (start - budget <= indent) return Math.min(indent, start);
  for (let i = start - budget; i < start; i++) {
    if (/\W/.test(text[i - 1]) && /\w/.test(text[i])) return i;
  }
  return start;
}
