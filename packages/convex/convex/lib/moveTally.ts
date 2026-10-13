// The one note a problem keeps for the reports moved on or off it while a run
// works on it (signals.ts moveForCli). Each move used to write its own
// one-line note, and a regroup of a hundred reports buried the problem page
// under a hundred of them; a run's moves now fold into one note with a count
// per problem. The note is plain text, so it reads the same everywhere a
// comment shows, and it parses back into its tally when the next move lands.

export type MoveTally = { in: Map<string, number>; out: Map<string, number>; fresh: Set<string> };

/** How long a run's moves keep folding into the same note. */
export const MOVE_TALLY_WINDOW_MS = 2 * 60 * 60 * 1000;

const HEAD = "Reports moved";
const ENTRY = /(\d+) (?:from|to) (ct-\d+)( \(new\))?/g;

const total = (m: Map<string, number>) => [...m.values()].reduce((s, n) => s + n, 0);

export const emptyTally = (): MoveTally => ({ in: new Map(), out: new Map(), fresh: new Set() });

/** The tally a move note carries, or null when the text is not one. */
export function parseMoveTally(text: string): MoveTally | null {
  if (!text.startsWith(HEAD)) return null;
  const tally = emptyTally();
  for (const line of text.split("\n")) {
    const side = line.startsWith("In: ") ? tally.in : line.startsWith("Out: ") ? tally.out : null;
    if (!side) continue;
    for (const m of line.matchAll(ENTRY)) {
      side.set(m[2], (side.get(m[2]) ?? 0) + Number(m[1]));
      if (m[3]) tally.fresh.add(m[2]);
    }
  }
  return tally;
}

export function addMove(tally: MoveTally, dir: "in" | "out", other: string, n: number, fresh: boolean): MoveTally {
  const side = tally[dir];
  side.set(other, (side.get(other) ?? 0) + n);
  if (fresh) tally.fresh.add(other);
  return tally;
}

/** "Reports moved: 7 in, 3 out" over one line per direction, biggest counterpart first. */
export function formatMoveTally(tally: MoveTally): string {
  const list = (m: Map<string, number>, word: string) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ct, n]) => `${n} ${word} ${ct}${tally.fresh.has(ct) ? " (new)" : ""}`).join(", ");
  const counts = [tally.in.size ? `${total(tally.in)} in` : "", tally.out.size ? `${total(tally.out)} out` : ""].filter(Boolean).join(", ");
  return [
    `${HEAD}: ${counts}`,
    tally.in.size ? `In: ${list(tally.in, "from")}` : "",
    tally.out.size ? `Out: ${list(tally.out, "to")}` : "",
  ].filter(Boolean).join("\n");
}
