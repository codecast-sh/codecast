// Whether a judge's live finding still has a moment standing behind it: the
// pure half of the standing sweep in judgeRetire.ts.

export const fold = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** A live judge run as the standing sweep reads it: where it ran, which findings it stands behind, what it found. */
export type StandingRun = { moment: string; judge: string; version: string; at: number; signal_ids: string[]; found: Array<{ expectation: string; quote: string }> };

/** Two quotes of one message: one holds the other's opening words, or they share a sentence. */
export function quotesOverlap(a: string, b: string): boolean {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return false;
  if (x.includes(y.slice(0, 40)) || y.includes(x.slice(0, 40))) return true;
  const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter((s) => s.length >= 20);
  return sentences(x).some((s) => y.includes(s));
}

/**
 * Whether a live finding still has a moment standing behind it. Its carriers
 * are every moment one of its judge's runs filed it from or found it in again:
 * its own moment, a run listing it, a run naming its expectation on the same
 * words. It stands while the newest run of its judge on some carrier still
 * files it; it is stale when every carrier's newest run has let it go. A
 * newest run that names the expectation on other words may be the same message
 * quoted differently, so the finding is left as unsure rather than retired.
 */
export function findingStanding(
  f: { id: string; judge: string; moment: string; expectation: string; quote: string },
  runs: StandingRun[],
): { verdict: "stands" | "stale" | "unsure"; carriers: Array<{ moment: string; at: number; version: string; files: boolean; lists: boolean }> } {
  const mine = runs.filter((r) => r.judge === f.judge);
  const names = (r: StandingRun) => r.found.some((x) => x.expectation === f.expectation && quotesOverlap(x.quote, f.quote));
  const files = (r: StandingRun) => r.signal_ids.includes(f.id) || names(r);
  const carriers = new Set([f.moment, ...mine.filter(files).map((r) => r.moment)]);
  const out: Array<{ moment: string; at: number; version: string; files: boolean; lists: boolean }> = [];
  let near = false;
  for (const m of carriers) {
    const newest = mine.filter((r) => r.moment === m).sort((a, b) => b.at - a.at)[0];
    if (!newest) continue;
    // `lists`: settleRun can let the finding go from this moment (its own, or one whose runs list it). A carrier known
    // only by its words (the same opening line, said to another contact) is not one it can ever release.
    out.push({ moment: m, at: newest.at, version: newest.version, files: files(newest), lists: m === f.moment || mine.some((r) => r.moment === m && r.signal_ids.includes(f.id)) });
    if (!files(newest) && newest.found.some((x) => x.expectation === f.expectation)) near = true;
  }
  if (!out.length) return { verdict: "unsure", carriers: out };
  return { verdict: out.some((c) => c.files) ? "stands" : near ? "unsure" : "stale", carriers: out };
}
