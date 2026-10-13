// What a list's "more" button says. Pure.

/** "Show 52 more" when one press shows the rest, else "Show 60 more · 112 left". */
export function moreWords(page: number, left: number): string {
  return left <= page ? `Show ${left} more` : `Show ${page} more · ${left} left`;
}
