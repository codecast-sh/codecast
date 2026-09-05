// Ranking file paths against what somebody typed into the finder.
//
// The query is matched as a subsequence, which is what makes "wsp" find
// "workspace" and "rpc" find "components/repo/RepoPullsContent.tsx". Three
// things decide the score, in the order a person would rank them by eye:
// matches inside the file name beat matches in the directories leading to it,
// runs of adjacent characters beat scattered ones, and a match on a word
// boundary beats one in the middle of a word.

export type FuzzyHit = { path: string; score: number; positions: number[] };

/** Where a word starts: the first character, or one after a separator. */
function isBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  const previous = text[at - 1];
  return previous === "/" || previous === "." || previous === "_" || previous === "-";
}

/**
 * The subsequence match, or null. Greedy from the left, which is the standard
 * finder behaviour: it finds the earliest match rather than the best possible
 * one, and the scoring below is what recovers quality from that.
 */
export function fuzzyMatch(path: string, query: string): FuzzyHit | null {
  if (!query) return { path, score: 0, positions: [] };

  const haystack = path.toLowerCase();
  const needle = query.toLowerCase();
  const nameAt = path.lastIndexOf("/") + 1;

  const positions: number[] = [];
  let at = 0;
  for (const character of needle) {
    if (character === " ") continue;
    const found = haystack.indexOf(character, at);
    if (found === -1) return null;
    positions.push(found);
    at = found + 1;
  }

  let score = 0;
  positions.forEach((position, index) => {
    if (position >= nameAt) score += 8;               // in the file name itself
    if (isBoundary(path, position)) score += 4;        // at the start of a word
    if (index > 0 && position === positions[index - 1] + 1) score += 6; // adjacent
  });
  // A short path carrying the same match is the more likely target.
  score -= Math.floor(path.length / 40);
  return { path, score, positions };
}

/** The best matches first, ties broken by the shorter path. */
export function rankPaths(paths: string[], query: string, limit = 50): FuzzyHit[] {
  const hits: FuzzyHit[] = [];
  for (const path of paths) {
    const hit = fuzzyMatch(path, query);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return hits.slice(0, limit);
}
