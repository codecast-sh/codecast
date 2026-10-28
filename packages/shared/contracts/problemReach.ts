/** The distinct contacts a problem's evidence names (fingerprints "evidence:contacts/<id>:..."): the people it reached.
 *  The server stamps it on a decision row (convex lib/decisionRowFacts) and For you reads it off a problem. */
export function contactsOf(fingerprints: ReadonlyArray<string> | null | undefined): number {
  const ids = new Set<string>();
  for (const f of fingerprints ?? []) {
    const m = /^evidence:contacts\/([^:]+)/.exec(f);
    if (m) ids.add(m[1]);
  }
  return ids.size;
}
