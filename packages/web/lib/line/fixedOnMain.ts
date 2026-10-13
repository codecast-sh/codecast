// A problem parked because main already carries its fix (lineInbox fixedOnMain):
// what a person checks before closing it. The run's note without the commit it
// names, and whether a recorded deploy carried it (its CI is lineFixChecks'). Pure,
// so a test reads it.

/** The park note past its "Already fixed on main by <sha>", which the facts say: no leading colon or bracket left, and no
 *  CI word the run wrote when it looked ("; CI run 38315388555 in progress, redeploy main once green"), which is stale by
 *  now and read live beside it. The whole note when nothing else is left. */
export function fixedNoteRest(note: string | null | undefined): string {
  const raw = note ?? "";
  const rest = raw
    .replace(/^\s*(?:already )?fixed on main (?:by|in|at) [0-9a-f]+\s*/i, "")
    .replace(/^\(([^)]*)\)/, "$1")
    .replace(/^[\s:;,.\-–—]+/, "")
    .replace(/[;,.]?\s*CI\b[^;]*$/i, "")
    .trim();
  return rest || raw.trim();
}

/** Short and full shas name the same commit when one starts with the other (7 characters at least). */
export const sameCommit = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && Math.min(a.length, b.length) >= 7 && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));

export type DeployFact = { at: number; sha: string | null; url: string | null };

/** The recorded deploy of the fix commit itself, the earliest; null when none names it. */
export function deployOfCommit(sha: string, deploys: ReadonlyArray<DeployFact>): DeployFact | null {
  return deploys.filter((d) => sameCommit(d.sha, sha)).sort((a, b) => a.at - b.at)[0] ?? null;
}

/** The newest recorded deploy with a commit, the one a later deploy check compares against. */
export function newestDeploy(deploys: ReadonlyArray<DeployFact>): DeployFact | null {
  return deploys.filter((d) => d.sha).sort((a, b) => b.at - a.at)[0] ?? null;
}
