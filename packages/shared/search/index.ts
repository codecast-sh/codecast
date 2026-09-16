// Text search primitives shared by the server scan (messages.findAllMessagesByContent),
// the transcript renderer (marks in markdown and code) and the global search
// box, so a hit means the same thing everywhere it is counted or drawn.

/** Split a search box's text into lowercase terms; a quoted phrase is one term. */
export function parseSearchTerms(query: string): string[] {
  const terms: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    const term = match[1] || match[2];
    if (term) terms.push(term.toLowerCase());
  }
  return terms;
}

/** Non-overlapping, case-insensitive substring hits of every term in `content`. */
export function countMatches(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = content.toLowerCase();
  let count = 0;
  for (const term of terms) {
    if (!term) continue;
    let pos = 0;
    while ((pos = lower.indexOf(term, pos)) !== -1) {
      count++;
      pos += term.length;
    }
  }
  return count;
}
