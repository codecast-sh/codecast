// Which recorded decisions bear on a change (`cast decisions --touching`).
// A decision touches a diff when it governs a path the diff changes, or when
// it came from a session that wrote the lines the diff changes. Pure, so the
// matching is tested without a database.

/** Repo-relative paths as a decision stores them: no leading "./" or "/",
 *  forward slashes, a directory kept as "dir/". */
export function normalizeDecisionFiles(files: string[]): string[] {
  const out = new Set<string>();
  for (const raw of files) {
    const f = raw.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
    if (f) out.add(f);
  }
  return [...out];
}

/** A governed path covers a changed file when it names that file, or a
 *  directory ("dir/" or "dir") the file sits under. */
export function pathCovers(governed: string, changed: string): boolean {
  if (governed === changed) return true;
  const dir = governed.endsWith("/") ? governed : `${governed}/`;
  return changed.startsWith(dir);
}

export type DecisionTouch = { files: string[]; session: boolean };

/**
 * Why a decision touches a change, or null when it does not. A decision
 * someone reversed binds nothing. File matches need the same repository:
 * repo-relative paths collide across repos. A session match does not, since
 * the session that wrote the changed lines is exact evidence.
 */
export function decisionTouches(
  d: { repo?: string; files?: string[]; conversation_id?: string; superseded_by?: string },
  change: { repo?: string | null; files: string[]; conversationIds: Set<string> },
): DecisionTouch | null {
  if (d.superseded_by) return null;
  const session = !!d.conversation_id && change.conversationIds.has(String(d.conversation_id));
  const sameRepo = !!d.repo && !!change.repo && d.repo === change.repo;
  const files = sameRepo
    ? change.files.filter((f) => (d.files ?? []).some((g) => pathCovers(g, f)))
    : [];
  if (!session && files.length === 0) return null;
  return { files, session };
}
